import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Gujian2EngineCore } from './engine_core.js';
import { createBattleClock, validBattleClock } from './shared-battle-clock.js';

import { upgradeLifecycle, validLifePlayers, settleBattle, resolveDowned, refreshMonsters, revivePlayer, partyHp } from './shared-battle-lifecycle.js';
import { cooperativeBattle, participantBattle, addParticipant, performCooperativeAction, advanceCooperativeBattle } from './shared-coop-battle.js';
import { sharedEncounter as encounter, battleFor, freshMonster, encounterCatalogue, migrateEncounters, checkEncounters, contactFraction } from './shared-encounters.js';

const players = ['a', 'b'];
const directions = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
export const SHARED_STEP_MS = 50;
export const SHARED_INPUT_TTL_MS = 750;
const speed = 4;
const actions = new Set(['attack', 'heavy', 'guard', 'dodge']);
const digest = data => createHash('sha256').update(data).digest('hex');

export function loadSharedAssets(directory) {
  const metaBytes = readFileSync(join(directory, 'world.meta.json'));
  const heightBytes = readFileSync(join(directory, 'world.heights.bin'));
  const propsBytes = readFileSync(join(directory, 'props', 'index.json'));
  const meta = JSON.parse(metaBytes);
  if (!Number.isSafeInteger(meta.width) || meta.width < 2 ||
      !Number.isSafeInteger(meta.height) || meta.height < 2 ||
      heightBytes.length !== meta.width * meta.height * 2) throw Error('invalid terrain dimensions');
  const heights = new Float32Array(heightBytes.length / 2);
  for (let i = 0; i < heights.length; i++) {
    heights[i] = meta.hmin + heightBytes.readUInt16LE(i * 2) / 65535 * (meta.hmax - meta.hmin);
  }
  const props = JSON.parse(propsBytes);
  return {
    assetId: digest(JSON.stringify([digest(metaBytes), digest(heightBytes), digest(propsBytes)])),
    createEngine: () => new Gujian2EngineCore(meta, heights, props, { seed: 42 }),
  };
}

function arenaFor(engine) {
  const { physics } = engine;
  const [startX, , startZ] = engine.position;
  const region = physics.regionAt(startX, startZ)?.name;
  if (!region) throw Error('initial region missing');
  const open = (x, z) => physics.regionAt(x, z)?.name === region &&
    !physics.checkBuildingCollision(x, z) && physics.slopeAt(x, z) <= physics.maxClimbSlope;

  // Choose a stable patch of walkable terrain near the existing native spawn.
  for (let offset = 0; offset <= 120; offset += 4) {
    for (let dx = -offset; dx <= offset; dx += 4) {
      for (const dz of new Set([-offset, offset])) {
        const x = Math.round(startX) + dx, z = Math.round(startZ) + dz;
        const probes = [[0, 0], [-4, 0], [4, 0], [-2, 0], [2, 0], [-4, -2], [-2, 2], [2, 2]];
        if (probes.every(([u, v]) => open(x + u, z + v))) return { x, z, region, extent: 32 };
      }
    }
  }
  throw Error('no walkable shared-world arena near the native spawn');
}

function initialState(engine, arena) {
  const newPlayer = dx => ({
    x: arena.x + dx, z: arena.z, seq: 0, party: structuredClone(engine.party),
  });
  return upgradeLifecycle({
    version: 5, simTick: 0, revision: 0, players: { a: newPlayer(-4), b: newPlayer(4) },
    monsters: { 'trial-1': freshMonster(), 'trial-2': freshMonster() }, battles: {},
  });
}

function checkState(state, revision, arena, catalogue) {
  if (![1, 2, 3, 4, 5, 6].includes(state?.version) ||
      (state.version >= 2 && (!Number.isSafeInteger(state.simTick) || state.simTick < 0)) || state.revision !== revision || !Number.isSafeInteger(revision) || revision < 0 ||
      !players.every(id => {
        const p = state.players?.[id];
        return p && Number.isFinite(p.x) && Number.isFinite(p.z) &&
          Math.abs(p.x - arena.x) <= arena.extent && Math.abs(p.z - arena.z) <= arena.extent &&
          Number.isSafeInteger(p.seq) && p.seq >= 0 && p.seq <= revision && Array.isArray(p.party) && p.party.length === 4;
      })) throw Error('invalid shared-world checkpoint');
  if (state.version >= 6 && !validLifePlayers(state.players)) throw Error('invalid shared-world life checkpoint');
  if (state.version >= 4) return checkEncounters(state, catalogue);
  const { monster, battle } = state;
  if (monster?.status === 'available' && monster.starts === 0 && monster.settlements === 0 && battle === null) return;
  if (monster?.status === 'defeated' && monster.starts === 1 && monster.settlements === 1 && battle === null) return;
  if (monster?.status === 'engaged' && monster.starts === 1 && monster.settlements === 0 &&
      battle?.id === encounter.boss_id && players.includes(battle.owner) &&
      battle.combat?.active === true && battle.combat.boss_id === encounter.boss_id &&
      battle.combat.enemy_max_hp === encounter.hp && Number.isFinite(battle.combat.enemy_hp) &&
      battle.combat.enemy_hp > 0 && battle.combat.enemy_hp <= encounter.hp &&
      (state.version < 3 || validBattleClock(battle.clock, state.simTick))) return;
  throw Error('invalid shared-world encounter checkpoint');
}

function intentError(message) {
  return Object.assign(Error(message), { status: 409 });
}

export function openSharedWorld({ filename, assets, identityId, now = () => performance.now() }) {
  const engine = assets.createEngine();
  const arena = arenaFor(engine);
  const catalogue = encounterCatalogue(engine, arena);
  const battleEngines = Object.fromEntries(players.map(id => [id, assets.createEngine()]));
  const initialCombat = structuredClone(engine.combat);
  const epoch = randomUUID();
  const configuration = digest(JSON.stringify([assets.assetId, identityId, arena, encounter]));
  const inputs = new Map();
  let lastAdvance = now(), unavailable = false;
  const db = new DatabaseSync(filename);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS shared_world (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        configuration TEXT NOT NULL,
        revision INTEGER NOT NULL,
        state TEXT NOT NULL
      );
    `);
    const read = db.prepare('SELECT configuration, revision, state FROM shared_world WHERE id = 1');
    if (!read.get()) {
      db.prepare('INSERT OR IGNORE INTO shared_world VALUES (1, ?, 0, ?)').run(configuration, JSON.stringify(initialState(engine, arena)));
    }
    const row = read.get();
    if (row.configuration !== configuration) throw Error('shared-world checkpoint configuration mismatch');
    let state = JSON.parse(row.state);
    checkState(state, row.revision, arena, catalogue);
    const update = db.prepare('UPDATE shared_world SET revision = ?, state = ? WHERE id = 1 AND revision = ? AND configuration = ?');
    if (state.version < 6) {
      let migrated = state.version < 4 ? migrateEncounters(state) : structuredClone(state);
      if (migrated.version < 5) migrated.battles = Object.fromEntries(Object.entries(migrated.battles).map(([id, battle]) => [id, cooperativeBattle(battle)]));
      migrated = upgradeLifecycle(migrated);
      migrated.revision++;
      checkState(migrated, migrated.revision, arena, catalogue);
      if (update.run(migrated.revision, JSON.stringify(migrated), state.revision, configuration).changes !== 1) {
        throw Error('another host advanced the checkpoint');
      }
      state = migrated;
    }
    const revision = db.prepare('SELECT revision FROM shared_world WHERE id = 1');
    const view = id => {
      const battle = battleFor(state, id);
      const own = battle && participantBattle(battle, id);
      return {
        epoch, revision: state.revision, simTick: state.simTick, simTimeMs: state.simTick * SHARED_STEP_MS, self: id, arena,
        nextSeq: state.players[id].seq + 1, life: { ...state.players[id].life },
        players: Object.fromEntries(players.map(key => {
          const { x, z } = state.players[key];
          return [key, { x, z, downed: state.players[key].life.status === 'downed', y: engine.physics.heightAt(x, z), moving: !!inputs.get(key) && inputs.get(key).until > now() && !battleFor(state, key) && state.players[key].life.status === 'alive' }];
        })),
        monsters: Object.fromEntries(Object.entries(catalogue).map(([key, definition]) => {
          const { status, starts, settlements, victors, generation, refreshes, respawnAt, lastResult } = state.monsters[key];
          return [key, { id: key, ...definition, y: engine.physics.heightAt(definition.x, definition.z), status, starts, settlements, generation, refreshes, lastResult,
            respawnRemainingMs: respawnAt === null ? 0 : Math.max(0, respawnAt - state.simTick) * SHARED_STEP_MS,
            ...(victors && { victors }) }];
        })),
        joinOffers: battle || state.players[id].life.status === 'downed' ? [] : Object.values(state.battles).filter(candidate => {
          const monster = catalogue[candidate.monsterId], player = state.players[id];
          return Math.hypot(player.x - monster.x, player.z - monster.z) <= 2 + 1e-6;
        }).map(candidate => ({ battleId: candidate.id, monsterId: candidate.monsterId, name: catalogue[candidate.monsterId].name })),
        battle: battle ? {
          id: battle.id, generation: battle.generation, downed: state.players[id].life.status === 'downed', monsterId: battle.monsterId, name: catalogue[battle.monsterId].name, hp: battle.combat.enemy_hp, maxHp: battle.combat.enemy_max_hp,
          participants: Object.keys(battle.participants).sort(),
          combo: own.combat.combo_step, telegraph: battle.clock.phase === 'warning',
          phase: battle.clock.phase, phaseUntilTick: battle.clock.phaseUntil,
          phaseRemainingMs: (battle.clock.phaseUntil - state.simTick) * SHARED_STEP_MS,
          iframeUntilTick: own.clock.iframeUntil,
          iframeRemainingMs: Math.max(0, own.clock.iframeUntil - state.simTick) * SHARED_STEP_MS,
          guardRemainingMs: Math.max(0, own.clock.guardUntil - state.simTick) * SHARED_STEP_MS,
          actionUntilTick: own.clock.actionUntil,
          actionRemainingMs: Math.max(0, own.clock.actionUntil - state.simTick) * SHARED_STEP_MS,
          defenseRemainingMs: Math.max(0, own.clock.defenseUntil - state.simTick) * SHARED_STEP_MS,
          strikes: battle.clock.strikes, dodges: own.combat.dodges_succeeded,
          partyHp: partyHp(state.players[id].party), log: own.combat.last_combat_log,
        } : null,
      };
    };
    const checkCurrent = () => {
      if (unavailable) throw Error('shared world requires restart');
      try {
        if (revision.get().revision !== state.revision) throw Error('another host advanced the checkpoint');
      } catch (error) { unavailable = true; throw error; }
    };
    function commit(next) {
      checkState(next, next.revision, arena, catalogue);
      try {
        if (update.run(next.revision, JSON.stringify(next), state.revision, configuration).changes !== 1) {
          throw Error('another host advanced the checkpoint');
        }
      } catch (error) {
        unavailable = true;
        throw error;
      }
      state = next;
    }

    function move(next, id, direction) {
      if (battleFor(next, id)) throw intentError('player is in battle');
      const player = next.players[id], [dx, dz] = directions[direction];
      const distance = speed * SHARED_STEP_MS / 1000;
      const x = player.x + dx * distance, z = player.z + dz * distance;
      if (Math.abs(x - arena.x) > arena.extent || Math.abs(z - arena.z) > arena.extent ||
          engine.physics.regionAt(x, z)?.name !== arena.region) return;
      const position = engine.physics.stepMovement(player.x, player.z, x, z);
      const contact = Object.entries(catalogue)
        .filter(([key]) => next.monsters[key].status === 'available')
        .map(([key, definition]) => ({ key, definition, t: contactFraction(player, position, definition) }))
        .filter(candidate => Number.isFinite(candidate.t))
        .sort((a, b) => a.t - b.t || a.key.localeCompare(b.key))[0];
      player.x = position.x; player.z = position.z;
      if (!contact) return;
      const native = battleEngines[id];
      native.party = player.party;
      native.combat = structuredClone(initialCombat);
      native._startCombat({ ...encounter, enemy_name: contact.definition.name });
      const battleId = randomUUID();
      next.battles[battleId] = cooperativeBattle({ id: battleId, monsterId: contact.key, owner: id,
        combat: structuredClone(native.combat), clock: createBattleClock(next.simTick + 1) });
      next.battles[battleId].generation = next.monsters[contact.key].generation;
      Object.assign(next.monsters[contact.key], { status: 'engaged', starts: next.monsters[contact.key].starts + 1, battleId });
    }

    function fight(next, id, input) {
      const battle = battleFor(next, id);
      if (!battle || battle.id !== input.battleId) throw intentError('battle offer is unavailable');
      performCooperativeAction(battleEngines[id], battle, id, next.players[id].party, input.action, next.simTick);
      if (!battle.combat.active) settleBattle(next, battle, 'victory', next.simTick);
    }

    function joinBattle(next, id, input) {
      const battle = Object.values(next.battles).find(candidate => candidate.id === input.battleId);
      if (battleFor(next, id) || !battle) throw intentError('battle offer is unavailable');
      const definition = catalogue[battle.monsterId], player = next.players[id];
      if (Math.hypot(player.x - definition.x, player.z - definition.z) > 2 + 1e-6) throw intentError('battle offer is unavailable at this distance');
      const native = battleEngines[id];
      native.party = player.party; native.combat = structuredClone(initialCombat);
      native._startCombat({ ...encounter, enemy_name: definition.name });
      addParticipant(battle, id, native.combat);
    }

    function advance() {
      try {
        checkCurrent();
        const time = now();
        const elapsed = time - lastAdvance;
        const steps = Math.min(5, Math.floor(elapsed / SHARED_STEP_MS));
        if (!steps) return;
        lastAdvance = time - elapsed % SHARED_STEP_MS;
        for (let step = 0; step < steps; step++) {
          const stepTime = lastAdvance - (steps - step - 1) * SHARED_STEP_MS;
          const next = structuredClone(state);
          refreshMonsters(next, next.simTick + 1);
          for (const key of Object.keys(catalogue)) {
            const monster = next.monsters[key];
            if (monster.status !== 'engaged') continue;
            const battle = next.battles[monster.battleId];
            advanceCooperativeBattle(battleEngines, battle, next.players, next.simTick + 1);
            resolveDowned(next, battle, next.simTick + 1);
          }
          const order = next.simTick % 2 ? [...players].reverse() : players;
          for (const id of order) {
            const input = inputs.get(id);
            if (!input) continue;
            if (input.until <= stepTime || battleFor(next, id) || next.players[id].life.status === 'downed') { inputs.delete(id); continue; }
            if (input.since > stepTime) continue;
            move(next, id, input.direction);
            if (battleFor(next, id)) inputs.delete(id);
          }
          next.simTick++;
          next.revision++;
          commit(next);
        }
      } catch (error) { unavailable = true; throw error; }
    }

    return {
      read(id) { checkCurrent(); return view(id); },
      advance,
      terrain() {
        checkCurrent();
        const radius = arena.extent + 16, spacing = 1, size = radius * 2 + 1;
        const heights = [];
        for (let z = -radius; z <= radius; z += spacing) {
          for (let x = -radius; x <= radius; x += spacing) {
            heights.push(engine.physics.terrainHeightAt(arena.x + x, arena.z + z));
          }
        }
        const { originX, originZ, worldW, worldH } = engine.physics;
        return {
          arena, radius, spacing, size, heights, originX, originZ, worldW, worldH,
          props: engine.physics.placedProps.filter(p => Math.abs(p.x - arena.x) < radius && Math.abs(p.z - arena.z) < radius)
            .map(({ name, x, y, z, rot, scale }) => ({ name, x, y, z, rot, scale })),
        };
      },
      submit(id, input) {
        checkCurrent();
        if (input.epoch !== epoch || input.seq !== state.players[id].seq + 1) throw intentError('stale intent');
        advance();
        const next = structuredClone(state);
        if (next.players[id].life.status === 'downed' && !['stop', 'revive'].includes(input.type)) throw intentError('player is downed');
        // The detached candidate owns every engine field that prototype combat can modify.
        if (input.type === 'move' && battleFor(state, id)) throw intentError('player is in battle');
        if (input.type === 'combat') fight(next, id, input);
        if (input.type === 'joinBattle') joinBattle(next, id, input);
        if (input.type === 'revive') revivePlayer(next, id, input.downId, arena);
        next.players[id].seq++;
        next.revision++;
        commit(next);
        if (input.type === 'move') {
          const time = now(), previous = inputs.get(id);
          const since = previous?.direction === input.direction && previous.until > time ? previous.since : time;
          inputs.set(id, { direction: input.direction, since, until: time + SHARED_INPUT_TTL_MS });
        }
        if (input.type === 'stop' || input.type === 'joinBattle' || input.type === 'revive') inputs.delete(id);
        return view(id);
      },
      close() { db.close(); },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function validateSharedIntent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.epoch !== 'string' ||
      !Number.isSafeInteger(input.seq) || input.seq < 1) return false;
  if (input.type === 'revive') return Object.keys(input).length === 4 && typeof input.downId === 'string';
  if (input.type === 'joinBattle') return Object.keys(input).length === 4 && typeof input.battleId === 'string';
  if (input.type === 'stop') return Object.keys(input).length === 3;
  if (input.type === 'move') {
    return Object.keys(input).length === 4 && typeof input.direction === 'string' && Object.hasOwn(directions, input.direction);
  }
  return input.type === 'combat' && Object.keys(input).length === 5 &&
    typeof input.battleId === 'string' && actions.has(input.action);
}
