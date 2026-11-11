import { randomUUID } from 'node:crypto';

export const RESPAWN_TICKS = 200;
export const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const partyDown = party => !party.some(role => role.in_team && role.hp > 0);
export const livingLeader = party => party.findIndex(role => role.in_team && role.hp > 0);
export const partyHp = party => party.filter(role => role.in_team).reduce((hp, role) => hp + role.hp, 0);

export function upgradeLifecycle(previous) {
  const state = structuredClone(previous);
  for (const player of Object.values(state.players)) {
    player.life = { status: partyDown(player.party) ? 'downed' : 'alive', downId: partyDown(player.party) ? randomUUID() : null };
  }
  for (const [id, monster] of Object.entries(state.monsters)) {
    Object.assign(monster, { generation: 1, refreshes: 0, respawnAt: null, lastResult: null });
    if (monster.status === 'defeated') {
      monster.victors ??= [];
      monster.lastResult = { battleId: monster.battleId, generation: 1, outcome: 'victory', participants: [...monster.victors], tick: state.simTick };
      monster.respawnAt = state.simTick + RESPAWN_TICKS;
    }
    if (monster.status === 'engaged') state.battles[monster.battleId].generation = 1;
  }
  state.version = 6;
  for (const battle of Object.values(state.battles)) {
    if (Object.keys(battle.participants).every(id => state.players[id].life.status === 'downed')) settleBattle(state, battle, 'defeat', state.simTick);
  }
  return state;
}
export function settleBattle(state, battle, outcome, tick) {
  const monster = state.monsters[battle.monsterId], members = Object.keys(battle.participants).sort();
  monster.status = 'defeated'; monster.settlements++;
  monster.victors = outcome === 'victory' ? members : [];
  monster.lastResult = { battleId: battle.id, generation: monster.generation, outcome, participants: members, tick };
  monster.respawnAt = tick + RESPAWN_TICKS;
  if (outcome === 'victory') for (const id of members) {
    if (state.players[id].life.status === 'alive') for (const role of state.players[id].party) if (role.in_team) role.hp = role.max_hp;
  }
  delete state.battles[battle.id];
}
export function resolveDowned(state, battle, tick) {
  for (const id of Object.keys(battle.participants)) {
    const player = state.players[id];
    if (player.life.status === 'alive' && partyDown(player.party)) {
      player.life = { status: 'downed', downId: randomUUID() };
      for (const key of Object.keys(battle.participants[id].clock)) battle.participants[id].clock[key] = 0;
    }
  }
  if (Object.keys(battle.participants).every(id => state.players[id].life.status === 'downed')) settleBattle(state, battle, 'defeat', tick);
}
export function refreshMonsters(state, tick) {
  for (const monster of Object.values(state.monsters)) {
    if (monster.status !== 'defeated' || tick < monster.respawnAt) continue;
    monster.status = 'available'; monster.generation++; monster.refreshes++;
    monster.battleId = null; monster.respawnAt = null; delete monster.victors;
  }
}
export function revivePlayer(state, id, downId, arena) {
  const player = state.players[id];
  if (player.life.status !== 'downed' || player.life.downId !== downId) {
    throw Object.assign(Error('revival is unavailable'), { status: 409 });
  }
  for (const battle of Object.values(state.battles)) delete battle.participants[id];
  for (const role of player.party) if (role.in_team) role.hp = role.max_hp;
  player.x = arena.x + (id === 'a' ? -4 : 4); player.z = arena.z;
  player.life = { status: 'alive', downId: null };
}
export function validLifePlayers(players) {
  const ids = new Set();
  for (const player of Object.values(players)) {
    if (!player.party.some(role => role?.in_team) || player.party.some(role => !role || typeof role.in_team !== 'boolean' ||
        !Number.isFinite(role.hp) || !Number.isFinite(role.max_hp) || role.max_hp <= 0 || role.hp < 0 || role.hp > role.max_hp)) return false;
    const life = player.life;
    if (life?.status === 'alive' && life.downId === null && !partyDown(player.party)) continue;
    if (life?.status !== 'downed' || !isUuid(life.downId) || ids.has(life.downId) || !partyDown(player.party)) return false;
    ids.add(life.downId);
  }
  return true;
}
export function validMonsterCycle(monster, tick) {
  const m = monster;
  if (!['generation', 'refreshes', 'starts', 'settlements'].every(key => Number.isSafeInteger(m[key]) && m[key] >= 0) ||
      m.generation !== m.refreshes + 1 || !['available', 'engaged', 'defeated'].includes(m.status)) return false;
  const completed = m.status === 'defeated', started = m.status !== 'available';
  if (m.starts !== m.refreshes + Number(started) || m.settlements !== m.refreshes + Number(completed)) return false;
  if (m.status === 'available' ? m.battleId !== null : !isUuid(m.battleId)) return false;
  if (completed ? !Number.isSafeInteger(m.respawnAt) || m.respawnAt <= tick || m.respawnAt > tick + RESPAWN_TICKS : m.respawnAt !== null) return false;
  const r = m.lastResult;
  if (!r) return m.refreshes === 0 && !completed && r === null;
  if (!isUuid(r.battleId) || !['victory', 'defeat'].includes(r.outcome) || !Number.isSafeInteger(r.tick) || r.tick < 0 || r.tick > tick ||
      r.generation !== m.generation - Number(!completed) || !Array.isArray(r.participants) || r.participants.length > 2 ||
      new Set(r.participants).size !== r.participants.length || r.participants.some(id => !['a', 'b'].includes(id))) return false;
  if (completed) return r.battleId === m.battleId && m.respawnAt === r.tick + RESPAWN_TICKS &&
    Array.isArray(m.victors) && JSON.stringify(m.victors) === JSON.stringify(r.outcome === 'victory' ? r.participants : []);
  return m.battleId !== r.battleId && r.tick + RESPAWN_TICKS <= tick;
}
