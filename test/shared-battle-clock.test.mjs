import assert from 'node:assert/strict';
import test from 'node:test';
import * as clock from '../src/shared-battle-clock.js';
import { buildProceduralWorldAssets, Gujian2EngineCore } from '../src/engine_core.js';

function fixture() {
  const { meta, heights, propsIndex } = buildProceduralWorldAssets();
  const engine = new Gujian2EngineCore(meta, heights, propsIndex);
  engine._startCombat({ boss_id: 'shared_trial', enemy_name: '试炼', vip_monster: false, hp: 600, shield: 0, telegraph_name: '扑击' });
  const battle = { combat: structuredClone(engine.combat), clock: clock.createBattleClock(100, true) };
  const party = structuredClone(engine.party);
  return { engine, battle, party };
}

test('warning attacks once at its deadline and recovery leads to a fresh warning', () => {
  const { engine, battle, party } = fixture();
  const hp = party[0].hp;
  for (let tick = 101; tick < 130; tick++) clock.advanceBattleClock(engine, battle, party, tick);
  assert.equal(party[0].hp, hp);
  clock.advanceBattleClock(engine, battle, party, 130);
  assert.equal(party[0].hp, hp - 35);
  assert.equal(battle.clock.strikes, 1);
  assert.equal(battle.clock.phase, 'recovery');
  for (let tick = 131; tick <= 150; tick++) clock.advanceBattleClock(engine, battle, party, tick);
  assert.equal(battle.clock.strikes, 1);
  assert.equal(battle.clock.phase, 'warning');
  assert.equal(battle.clock.phaseUntil, 180);
});

test('dodge expires at the exact deadline and cooldown requests cannot extend it', () => {
  const { engine, battle, party } = fixture();
  clock.performTimedAction(engine, battle, party, 'dodge', 120);
  assert.equal(battle.clock.iframeUntil, 129);
  assert.throws(() => clock.performTimedAction(engine, battle, party, 'dodge', 126), /cooldown/);
  assert.equal(battle.clock.iframeUntil, 129);
  clock.advanceBattleClock(engine, battle, party, 129);
  assert.equal(battle.combat.iframe_timer, 0);
  const hp = party[0].hp;
  clock.advanceBattleClock(engine, battle, party, 130);
  assert.equal(party[0].hp, hp - 35);
});

test('a dodge covering the landing avoids damage and earns success at landing', () => {
  const { engine, battle, party } = fixture();
  const hp = party[0].hp;
  clock.performTimedAction(engine, battle, party, 'dodge', 122);
  assert.equal(battle.combat.dodges_succeeded, 0);
  const restored = structuredClone(battle);
  clock.advanceBattleClock(engine, restored, party, 130);
  assert.equal(party[0].hp, hp);
  assert.equal(restored.combat.dodges_succeeded, 1);
  assert.equal(restored.clock.strikes, 1);
  assert.equal(restored.clock.iframeUntil, 131);
});

test('native commands cannot opt out of retaliation using the internal deferral flag', () => {
  const { engine } = fixture();
  const hp = engine.party[0].hp;
  engine.dispatch({ cmd: 'combat_action', action: 'attack', deferEnemyAttack: true });
  assert.equal(engine.party[0].hp, hp - 35);
});

test('guard protects one timed landing and attack requests do not advance enemy damage', () => {
  const { engine, battle, party } = fixture();
  const hp = party[0].hp;
  clock.performTimedAction(engine, battle, party, 'attack', 110);
  assert.equal(party[0].hp, hp);
  assert.equal(battle.clock.phaseUntil, 130);
  assert.throws(() => clock.performTimedAction(engine, battle, party, 'heavy', 115), /cooldown/);
  clock.performTimedAction(engine, battle, party, 'guard', 125);
  clock.advanceBattleClock(engine, battle, party, 130);
  assert.equal(party[0].hp, hp);
  assert.equal(battle.combat.guard_active, false);
  assert.equal(battle.clock.guardUntil, 0);
  assert.equal(battle.clock.strikes, 1);
  clock.advanceBattleClock(engine, battle, party, 130);
  assert.equal(battle.clock.strikes, 1);
});

test('protection ending exactly at a strike deadline no longer prevents damage', () => {
  const { engine, battle, party } = fixture();
  const hp = party[0].hp;
  clock.performTimedAction(engine, battle, party, 'dodge', 121);
  clock.advanceBattleClock(engine, battle, party, 130);
  assert.equal(battle.combat.iframe_timer, 0);
  assert.equal(battle.combat.dodges_succeeded, 0);
  assert.equal(party[0].hp, hp - 35);
});
