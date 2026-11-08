import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProceduralWorldAssets, Gujian2EngineCore } from '../../src/engine_core.js';
import { openSharedWorld } from '../../src/shared-world.js';

export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'gujian-continuous-'));
  let now = 0;
  const worldAssets = buildProceduralWorldAssets();
  const options = {
    filename: join(directory, 'world.sqlite'), identityId: 'test', now: () => now,
    assets: { assetId: 'procedural', createEngine: () => new Gujian2EngineCore(worldAssets.meta, worldAssets.heights, worldAssets.propsIndex) },
  };
  let world = openSharedWorld(options);
  return {
    get world() { return world; },
    send(id, direction) {
      const view = world.read(id);
      return world.submit(id, { epoch: view.epoch, seq: view.nextSeq,
        ...(direction ? { type: 'move', direction } : { type: 'stop' }) });
    },
    elapse(ms) { now += ms; },
    filename: options.filename,
    step(ms = 50) { now += ms; world.advance(); },
    restart() { world.close(); world = null; world = openSharedWorld(options); },
    close() { world?.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

// Reconstruct the actual pre-v4 disk schema for migration regression fixtures.
export function legacyState(current, version) {
  const state = structuredClone(current);
  state.monster = state.monsters['trial-1'];
  state.battle = state.battles[state.monster.battleId] ?? null;
  delete state.monster.battleId;
  if (state.battle) {
    state.battle.id = 'shared_trial'; delete state.battle.monsterId;
    if (version < 3) delete state.battle.clock;
  }
  delete state.monsters; delete state.battles;
  state.version = version;
  if (version === 1) delete state.simTick;
  return state;
}
