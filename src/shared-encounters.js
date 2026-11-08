import { randomUUID } from 'node:crypto';
import { createBattleClock, syncBattleClock, validBattleClock } from './shared-battle-clock.js';

export const sharedEncounter = Object.freeze({
  boss_id: 'shared_trial', vip_monster: false, enemy_name: '荒野试炼怪',
  hp: 600, shield: 0, telegraph_name: '野兽扑击',
});
export const battleFor = (state, owner) => Object.values(state.battles).find(b => b.owner === owner);
export const freshMonster = () => ({ status: 'available', starts: 0, settlements: 0, battleId: null });

// v4 fixes two spawn instances. Future layout changes require a schema migration.
export function encounterCatalogue(engine, arena) {
  const open = (x, z) => Math.abs(x - arena.x) <= arena.extent && Math.abs(z - arena.z) <= arena.extent &&
    engine.physics.regionAt(x, z)?.name === arena.region && !engine.physics.checkBuildingCollision(x, z) &&
    engine.physics.slopeAt(x, z) <= engine.physics.maxClimbSlope;
  for (const distance of [12, -12, 8, -8, 16, -16, 20, -20]) {
    let clear = true;
    // Certify both spawn lanes and the connecting lane, at the native step size.
    for (let step = 0; step <= Math.abs(distance) * 5 && clear; step++) {
      const z = arena.z + Math.sign(distance) * step / 5;
      for (const dx of [-4, 0, 4]) {
        if (!open(arena.x + dx, z)) { clear = false; break; }
      }
    }
    for (let step = -20; step <= 20 && clear; step++) clear = open(arena.x + step / 5, arena.z + distance);
    if (clear) return {
      'trial-1': { x: arena.x, z: arena.z, name: '荒野试炼怪·一' },
      'trial-2': { x: arena.x, z: arena.z + distance, name: '荒野试炼怪·二' },
    };
  }
  throw Error('no reachable second shared-world encounter');
}

export function migrateEncounters(old) {
  const state = structuredClone(old), monster = state.monster, battle = state.battle;
  if (state.version === 1) state.simTick = 0;
  const battleId = monster.status === 'available' ? null : randomUUID();
  state.monsters = { 'trial-1': { ...monster, battleId }, 'trial-2': freshMonster() };
  state.battles = {};
  if (battle) {
    battle.id = battleId;
    battle.monsterId = 'trial-1';
    if (state.version < 3) {
      battle.clock = createBattleClock(state.simTick, battle.combat.telegraph_active);
      syncBattleClock(battle, state.simTick);
    }
    state.battles[battleId] = battle;
  }
  delete state.monster; delete state.battle;
  state.version = 4;
  return state;
}

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export function checkEncounters(state, catalogue) {
  const invalid = () => { throw Error('invalid shared-world encounter checkpoint'); };
  if (!state.monsters || !state.battles || Array.isArray(state.monsters) || Array.isArray(state.battles) ||
      Object.keys(state.monsters).length !== Object.keys(catalogue).length ||
      Object.keys(catalogue).some(id => !Object.hasOwn(state.monsters, id)) ||
      Object.keys(state.battles).length > 2) invalid();
  const owners = new Set(), ids = new Set();
  let engaged = 0;
  for (const [id, monster] of Object.entries(state.monsters)) {
    if (monster.status === 'available') {
      if (monster.starts !== 0 || monster.settlements !== 0 || monster.battleId !== null) invalid();
      continue;
    }
    if (!uuid(monster.battleId) || ids.has(monster.battleId) || monster.starts !== 1) invalid();
    ids.add(monster.battleId);
    if (monster.status === 'defeated') {
      if (monster.settlements !== 1 || Object.hasOwn(state.battles, monster.battleId)) invalid();
      continue;
    }
    if (monster.status !== 'engaged' || monster.settlements !== 0) invalid();
    engaged++;
    const battle = state.battles[monster.battleId];
    if (!battle || battle.id !== monster.battleId || battle.monsterId !== id ||
        !['a', 'b'].includes(battle.owner) || owners.has(battle.owner) ||
        battle.combat?.active !== true || battle.combat.boss_id !== sharedEncounter.boss_id ||
        battle.combat.enemy_max_hp !== sharedEncounter.hp || !Number.isFinite(battle.combat.enemy_hp) ||
        battle.combat.enemy_hp <= 0 || battle.combat.enemy_hp > sharedEncounter.hp ||
        !validBattleClock(battle.clock, state.simTick)) invalid();
    owners.add(battle.owner);
  }
  if (engaged !== Object.keys(state.battles).length) invalid();
}

// First circle intersection on the accepted movement segment. Starting inside is contact at t=0.
export function contactFraction(from, to, monster) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const ox = from.x - monster.x, oz = from.z - monster.z;
  const c = ox * ox + oz * oz - 4;
  if (c <= 0) return 0;
  const a = dx * dx + dz * dz;
  if (!a) return Infinity;
  const b = ox * dx + oz * dz, discriminant = b * b - a * c;
  if (discriminant < 0) return Infinity;
  const t = (-b - Math.sqrt(discriminant)) / a;
  return t >= 0 && t <= 1 ? t : Infinity;
}
