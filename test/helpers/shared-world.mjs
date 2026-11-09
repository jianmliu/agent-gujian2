import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProceduralWorldAssets, Gujian2EngineCore } from '../../src/engine_core.js';
import { participantBattle } from '../../src/shared-coop-battle.js';
import { syncBattleClock } from '../../src/shared-battle-clock.js';
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
    restart() { world?.close(); world = null; world = openSharedWorld(options); },
    close() { world?.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

// Reconstruct the actual pre-v5 disk schema for migration regression fixtures.
export function legacyState(current, version) {
  const state = structuredClone(current);
  if (state.version === 5) {
    state.battles = Object.fromEntries(Object.values(state.battles).map(battle => {
      const [owner] = Object.keys(battle.participants);
      if (Object.keys(battle.participants).length !== 1) throw Error('legacy fixture requires one participant');
      const temporary = participantBattle(battle, owner);
      syncBattleClock(temporary, state.simTick);
      return [battle.id, { id: battle.id, monsterId: battle.monsterId, owner, ...temporary }];
    }));
  }
  for (const monster of Object.values(state.monsters)) delete monster.victors;
  state.version = version;
  if (version === 4) return state;
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
