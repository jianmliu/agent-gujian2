import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Gujian2EngineCore } from './engine_core.js';

const players = ['a', 'b'];
const directions = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
export const SHARED_STEP_MS = 50;
export const SHARED_INPUT_TTL_MS = 750;
const speed = 4;
const actions = new Set(['attack', 'heavy', 'guard']);
const encounter = Object.freeze({
  boss_id: 'shared_trial', vip_monster: false, enemy_name: '荒野试炼怪',
  hp: 600, shield: 0, telegraph_name: '野兽扑击',
});
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
  return {
    version: 2, simTick: 0, revision: 0, players: { a: newPlayer(-4), b: newPlayer(4) },
    monster: { status: 'available', starts: 0, settlements: 0 }, battle: null,
  };
}

function checkState(state, revision, arena) {
  if (![1, 2].includes(state?.version) ||
      (state.version === 2 && (!Number.isSafeInteger(state.simTick) || state.simTick < 0)) || state.revision !== revision || !Number.isSafeInteger(revision) || revision < 0 ||
      !players.every(id => {
        const p = state.players?.[id];
        return p && Number.isFinite(p.x) && Number.isFinite(p.z) &&
          Math.abs(p.x - arena.x) <= arena.extent && Math.abs(p.z - arena.z) <= arena.extent &&
          Number.isSafeInteger(p.seq) && p.seq >= 0 && p.seq <= revision && Array.isArray(p.party) && p.party.length === 4;
      })) throw Error('invalid shared-world checkpoint');
  const { monster, battle } = state;
  if (monster?.status === 'available' && monster.starts === 0 && monster.settlements === 0 && battle === null) return;
  if (monster?.status === 'defeated' && monster.starts === 1 && monster.settlements === 1 && battle === null) return;
  if (monster?.status === 'engaged' && monster.starts === 1 && monster.settlements === 0 &&
      battle?.id === encounter.boss_id && players.includes(battle.owner) &&
      battle.combat?.active === true && battle.combat.boss_id === encounter.boss_id &&
      battle.combat.enemy_max_hp === encounter.hp && Number.isFinite(battle.combat.enemy_hp) &&
      battle.combat.enemy_hp > 0 && battle.combat.enemy_hp <= encounter.hp) return;
  throw Error('invalid shared-world encounter checkpoint');
}

function intentError(message) {
  return Object.assign(Error(message), { status: 409 });
}

function nearestOnStep(target, from, to) {
  return Math.max(Math.min(from, to), Math.min(target, Math.max(from, to)));
}

export function openSharedWorld({ filename, assets, identityId, now = () => performance.now() }) {
  const engine = assets.createEngine();
  const arena = arenaFor(engine);
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
    checkState(state, row.revision, arena);
    if (state.version === 1) state = { ...state, version: 2, simTick: 0 };
    const update = db.prepare('UPDATE shared_world SET revision = ?, state = ? WHERE id = 1 AND revision = ? AND configuration = ?');
    const revision = db.prepare('SELECT revision FROM shared_world WHERE id = 1');
    const view = id => {
      const battle = state.battle?.owner === id ? state.battle : null;
      return {
        epoch, revision: state.revision, simTick: state.simTick, simTimeMs: state.simTick * SHARED_STEP_MS, self: id, arena,
        nextSeq: state.players[id].seq + 1,
        players: Object.fromEntries(players.map(key => {
          const { x, z } = state.players[key];
          return [key, { x, z, y: engine.physics.heightAt(x, z), moving: !!inputs.get(key) && inputs.get(key).until > now() && state.battle?.owner !== key }];
        })),
        monster: { ...state.monster, x: arena.x, z: arena.z, y: engine.physics.heightAt(arena.x, arena.z), name: encounter.enemy_name },
        battle: battle && {
          id: battle.id, hp: battle.combat.enemy_hp, maxHp: battle.combat.enemy_max_hp,
          combo: battle.combat.combo_step, telegraph: battle.combat.telegraph_active,
          partyHp: state.players[id].party[0].hp, log: battle.combat.last_combat_log,
        },
      };
    };
    const checkCurrent = () => {
      if (unavailable) throw Error('shared world requires restart');
      try {
        if (revision.get().revision !== state.revision) throw Error('another host advanced the checkpoint');
      } catch (error) { unavailable = true; throw error; }
    };
    function commit(next) {
      checkState(next, next.revision, arena);
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
      if (next.battle?.owner === id) throw intentError('player is in battle');
      const player = next.players[id], [dx, dz] = directions[direction];
      const distance = speed * SHARED_STEP_MS / 1000;
      const x = player.x + dx * distance, z = player.z + dz * distance;
      if (Math.abs(x - arena.x) > arena.extent || Math.abs(z - arena.z) > arena.extent ||
          engine.physics.regionAt(x, z)?.name !== arena.region) return;
      const position = engine.physics.stepMovement(player.x, player.z, x, z);
      // Axis-aligned movement lets us check the nearest point on the accepted step.
      const contactX = nearestOnStep(arena.x, player.x, position.x);
      const contactZ = nearestOnStep(arena.z, player.z, position.z);
      player.x = position.x;
      player.z = position.z;
      if (next.monster.status !== 'available' || Math.hypot(contactX - arena.x, contactZ - arena.z) > 2) return;
      engine.party = player.party;
      engine.combat = structuredClone(initialCombat);
      engine._startCombat(encounter);
      next.battle = { id: encounter.boss_id, owner: id, combat: structuredClone(engine.combat) };
      next.monster = { status: 'engaged', starts: 1, settlements: 0 };
    }

    function fight(next, id, input) {
      const battle = next.battle;
      if (!battle || battle.id !== input.battleId || battle.owner !== id) throw intentError('battle offer is unavailable');
      engine.party = next.players[id].party;
      engine.combat = battle.combat;
      engine.combatAction(input.action);
      if (!battle.combat.active) {
        next.battle = null;
        next.monster = { status: 'defeated', starts: 1, settlements: 1 };
      }
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
          const order = next.simTick % 2 ? [...players].reverse() : players;
          for (const id of order) {
            const input = inputs.get(id);
            if (!input) continue;
            if (input.until <= stepTime || next.battle?.owner === id) { inputs.delete(id); continue; }
            if (input.since > stepTime) continue;
            move(next, id, input.direction);
            if (next.battle?.owner === id) inputs.delete(id);
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
        // The detached candidate owns every engine field that prototype combat can modify.
        if (input.type === 'move' && state.battle?.owner === id) throw intentError('player is in battle');
        if (input.type === 'combat') fight(next, id, input);
        next.players[id].seq++;
        next.revision++;
        commit(next);
        if (input.type === 'move') {
          const time = now(), previous = inputs.get(id);
          const since = previous?.direction === input.direction && previous.until > time ? previous.since : time;
          inputs.set(id, { direction: input.direction, since, until: time + SHARED_INPUT_TTL_MS });
        }
        if (input.type === 'stop') inputs.delete(id);
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
  if (input.type === 'stop') return Object.keys(input).length === 3;
  if (input.type === 'move') {
    return Object.keys(input).length === 4 && typeof input.direction === 'string' && Object.hasOwn(directions, input.direction);
  }
  return input.type === 'combat' && Object.keys(input).length === 5 &&
    typeof input.battleId === 'string' && actions.has(input.action);
}
