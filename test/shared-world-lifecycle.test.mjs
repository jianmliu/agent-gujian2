import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { validateSharedIntent } from '../src/shared-world.js';
import { fixture, legacyState } from './helpers/shared-world.mjs';

function send(f, id, input) {
  const v = f.world.read(id);
  return f.world.submit(id, { epoch: v.epoch, seq: v.nextSeq, ...input });
}
function action(f, id, action) { return send(f, id, { type: 'combat', battleId: f.world.read(id).battle.id, action }); }
function rewrite(f, change) {
  const db = new DatabaseSync(f.filename);
  try {
    const state = JSON.parse(db.prepare('SELECT state FROM shared_world WHERE id=1').get().state);
    change(state);
    db.prepare('UPDATE shared_world SET state=? WHERE id=1').run(JSON.stringify(state));
  } finally { db.close(); }
}
function engage(f, both = true) {
  f.send('a', 'east'); for (let i = 0; i < 12; i++) f.step(); f.send('a');
  if (both) {
    f.send('b', 'west'); for (let i = 0; i < 11; i++) f.step(); f.send('b');
    send(f, 'b', { type: 'joinBattle', battleId: f.world.read('a').battle.id });
  }
}
function landing(f) {
  const strikes = f.world.read('a').battle?.strikes;
  for (let i = 0; i < 55; i++) {
    f.step(); const battle = f.world.read('a').battle;
    if (!battle || battle.strikes > strikes) return;
  }
  assert.fail('strike deadline not reached');
}
function revive(f, id) { return send(f, id, { type: 'revive', downId: f.world.read(id).life.downId }); }
function injure(f, a, b) {
  rewrite(f, state => { state.players.a.party[0].hp = a; state.players.b.party[0].hp = b; }); f.restart();
}

test('one player falls while their teammate continues, then all fallen ends in defeat', () => {
  const f = fixture();
  try {
    injure(f, 35, 70); engage(f);
    const battleId = f.world.read('a').battle.id;
    landing(f);
    const a = f.world.read('a'), b = f.world.read('b');
    assert.equal(a.life.status, 'downed'); assert(a.life.downId);
    assert.equal(a.battle.partyHp, 0); assert.equal(b.life.status, 'alive');
    assert.equal(b.battle.id, battleId); assert.equal(b.battle.partyHp, 35);
    assert.throws(() => action(f, 'a', 'heavy'), /downed/);
    assert.throws(() => f.send('a', 'north'), /downed/);
    assert.equal(action(f, 'b', 'attack').battle.hp < 600, true);
    landing(f);
    assert.equal(f.world.read('a').battle, null); assert.equal(f.world.read('b').battle, null);
    const monster = f.world.read('a').monsters['trial-1'];
    assert.equal(monster.lastResult.outcome, 'defeat'); assert.equal(monster.settlements, 1);
    assert.equal(f.world.read('b').life.status, 'downed');
    assert.equal(monster.respawnRemainingMs, 10000);
    f.restart();
    assert.equal(f.world.read('a').life.downId, a.life.downId);
    assert.equal(f.world.read('a').monsters['trial-1'].lastResult.battleId, battleId);
  } finally { f.close(); }
});

test('revive detaches the fallen participant and does not reset the ongoing enemy clock', () => {
  const f = fixture();
  try {
    injure(f, 35, 260); engage(f); landing(f);
    const fallen = f.world.read('a'), before = f.world.read('b');
    const restored = revive(f, 'a');
    assert.equal(restored.life.status, 'alive'); assert.equal(restored.battle, null);
    assert.equal(restored.players.a.x, restored.arena.x - 4);
    assert.deepEqual(f.world.read('b').battle.participants, ['b']);
    assert.equal(f.world.read('b').battle.phaseUntilTick, before.battle.phaseUntilTick);
    assert.throws(() => send(f, 'a', { type: 'revive', downId: fallen.life.downId }), /unavailable/);
    assert.equal(f.world.read('a').nextSeq, restored.nextSeq);
    assert.equal(action(f, 'b', 'heavy').battle.hp < 600, true);
  } finally { f.close(); }
});

test('refresh survives restart at the exact boundary, happens once, and new battles reject old commands', () => {
  const f = fixture();
  try {
    injure(f, 35, 35); engage(f); landing(f);
    const downId = f.world.read('a').life.downId;
    const old = f.world.read('a').monsters['trial-1'].lastResult.battleId;
    revive(f, 'a'); revive(f, 'b');
    for (let i = 0; i < 199; i++) f.step();
    const before = f.world.read('a').monsters['trial-1'];
    assert.equal(before.status, 'defeated'); assert.equal(before.respawnRemainingMs, 50);
    f.restart(); assert.equal(f.world.read('a').monsters['trial-1'].respawnRemainingMs, 50);
    f.step();
    const refreshed = f.world.read('a').monsters['trial-1'];
    assert.equal(refreshed.status, 'available'); assert.equal(refreshed.generation, 2); assert.equal(refreshed.refreshes, 1);
    f.restart(); for (let i = 0; i < 20; i++) f.step();
    assert.equal(f.world.read('a').monsters['trial-1'].refreshes, 1);
    engage(f, false);
    const current = f.world.read('a');
    assert.notEqual(current.battle.id, old); assert.equal(current.battle.generation, 2);
    assert.throws(() => send(f, 'a', { type: 'combat', battleId: old, action: 'heavy' }), /unavailable/);
    assert.equal(f.world.read('a').nextSeq, current.nextSeq);
    assert.equal(f.world.read('a').battle.hp, current.battle.hp);
    assert.equal(f.world.read('a').battle.phaseUntilTick, current.battle.phaseUntilTick);
    injure(f, 35, 260); landing(f);
    assert.notEqual(f.world.read('a').life.downId, downId);
    assert.throws(() => send(f, 'a', { type: 'revive', downId }), /unavailable/);
    revive(f, 'a');
  } finally { f.close(); }
});

for (const transition of ['down', 'defeat', 'victory', 'revive', 'refresh']) test(transition + ' write failure rolls back the entire lifecycle and resumes once', () => {
  const f = fixture();
  try {
    injure(f, 35, ['refresh', 'defeat'].includes(transition) ? 35 : 260); engage(f);
    if (transition === 'revive' || transition === 'refresh') landing(f);
    if (transition === 'refresh') for (let i = 0; i < 199; i++) f.step();
    if (transition === 'down' || transition === 'defeat') while (f.world.read('a').battle.phaseRemainingMs > 50) f.step();
    if (transition === 'victory') { rewrite(f, state => { Object.values(state.battles)[0].combat.enemy_hp = 1; }); f.restart(); }
    const operation = () => transition === 'victory' ? action(f, 'b', 'heavy') : transition === 'revive' ? revive(f, 'a') : f.step();
    const db = new DatabaseSync(f.filename);
    try {
      const before = db.prepare('SELECT revision,state FROM shared_world WHERE id=1').get();
      db.exec("CREATE TRIGGER fail_life BEFORE UPDATE ON shared_world BEGIN SELECT RAISE(FAIL, 'test life write failure'); END");
      assert.throws(operation, /test life write failure/);
      assert.throws(() => f.world.read('a'), /requires restart/);
      assert.deepEqual(db.prepare('SELECT revision,state FROM shared_world WHERE id=1').get(), before);
      db.exec('DROP TRIGGER fail_life');
    } finally { db.close(); }
    f.restart(); operation();
    const after = f.world.read('a');
    if (transition === 'down') assert.equal(after.life.status, 'downed');
    if (transition === 'defeat') { assert.equal(after.life.status, 'downed'); assert.equal(after.battle, null); assert.equal(after.monsters['trial-1'].lastResult.outcome, 'defeat'); }
    if (transition === 'revive') assert.equal(after.life.status, 'alive');
    if (transition === 'victory') { assert.equal(after.monsters['trial-1'].settlements, 1); assert.equal(after.life.status, 'alive'); }
    if (transition === 'refresh') assert.equal(after.monsters['trial-1'].refreshes, 1);
    f.restart(); f.step();
    assert.equal(f.world.read('a').life.downId, after.life.downId);
    assert.equal(f.world.read('a').monsters['trial-1'].settlements, after.monsters['trial-1'].settlements);
    assert.equal(f.world.read('a').monsters['trial-1'].refreshes, after.monsters['trial-1'].refreshes);
  } finally { f.close(); }
});

test('a surviving role leads and fallen companions do not attack or receive combat healing', () => {
  const f = fixture();
  try {
    rewrite(f, state => {
      const party = state.players.a.party;
      party[0].hp = 35; party[3].in_team = true; party[3].hp = 100;
    }); f.restart(); engage(f, false); landing(f);
    const v = f.world.read('a');
    assert.equal(v.life.status, 'alive');
    const db = new DatabaseSync(f.filename, { readOnly: true });
    try {
      const raw = JSON.parse(db.prepare('SELECT state FROM shared_world WHERE id=1').get().state);
      assert.equal(raw.players.a.party[0].hp, 0);
      assert(raw.players.a.party[3].hp > 65);
    } finally { db.close(); }
    action(f, 'a', 'attack');
    const afterDb = new DatabaseSync(f.filename, { readOnly: true });
    try {
      const raw = JSON.parse(afterDb.prepare('SELECT state FROM shared_world WHERE id=1').get().state);
      assert.equal(raw.battles[v.battle.id].participants.a.combat.companion_attacks, 0);
      assert.equal(raw.players.a.party[0].hp, 0);
    } finally { afterDb.close(); }
  } finally { f.close(); }
});

test('a fallen healer cannot prevent full-party defeat and victory does not revive another fallen player', () => {
  const f = fixture();
  try {
    rewrite(f, state => { state.players.a.party[0].hp = 35; state.players.a.party[3].hp = 35; state.players.a.party[3].in_team = true; });
    f.restart(); engage(f); landing(f);
    assert.equal(f.world.read('a').life.status, 'downed');
    while (f.world.read('b').battle) {
      while (f.world.read('b').battle.actionRemainingMs) f.step();
      action(f, 'b', 'heavy');
    }
    assert.equal(f.world.read('a').life.status, 'downed');
    assert.deepEqual(f.world.read('a').monsters['trial-1'].victors, ['a', 'b']);
    revive(f, 'a'); assert.equal(f.world.read('a').life.status, 'alive');
  } finally { f.close(); }
});

test('server downtime does not advance the pending refresh countdown', () => {
  const f = fixture();
  try {
    injure(f, 35, 35); engage(f); landing(f);
    const pending = f.world.read('a').monsters['trial-1'];
    f.elapse(60000); f.restart();
    assert.equal(f.world.read('a').monsters['trial-1'].respawnRemainingMs, pending.respawnRemainingMs);
    f.step(); assert.equal(f.world.read('a').monsters['trial-1'].respawnRemainingMs, 9950);
  } finally { f.close(); }
});

test('an impossible checkpoint cannot refresh before its last settlement deadline', () => {
  const f = fixture();
  try {
    injure(f, 35, 35); engage(f); landing(f);
    rewrite(f, state => {
      const m = state.monsters['trial-1'];
      m.status = 'available'; m.generation = 2; m.refreshes = 1; m.battleId = null; m.respawnAt = null; delete m.victors;
    });
    assert.throws(() => f.restart(), /invalid shared-world encounter checkpoint/);
  } finally { f.close(); }
});

test('v5 cooperative pending and settled checkpoints retain identities and begin the new refresh rule once', () => {
  const f = fixture();
  try {
    engage(f); action(f, 'a', 'dodge'); action(f, 'b', 'guard');
    const before = ['a', 'b'].map(id => f.world.read(id));
    rewrite(f, state => Object.assign(state, legacyState(state, 5)));
    f.restart();
    for (const v of before) {
      assert.deepEqual(f.world.read(v.self).battle, v.battle);
      assert.equal(f.world.read(v.self).nextSeq, v.nextSeq);
    }
    f.restart();
    for (const v of before) assert.deepEqual(f.world.read(v.self).battle, v.battle);
    while (f.world.read('b').battle) {
      while (f.world.read('b').battle.actionRemainingMs) f.step();
      action(f, 'b', 'heavy');
    }
    for (let i = 0; i < 10; i++) f.step();
    rewrite(f, state => Object.assign(state, legacyState(state, 5)));
    f.restart();
    assert.equal(f.world.read('a').monsters['trial-1'].respawnRemainingMs, 10000);
    f.step(); f.restart();
    assert.equal(f.world.read('a').monsters['trial-1'].respawnRemainingMs, 9950);
  } finally { f.close(); }
});

for (const corruption of ['alive-zero', 'false-down', 'bad-down-id', 'stale-deadline', 'counter', 'result-id', 'all-down-active']) {
  test('corrupt lifecycle ' + corruption + ' fails closed', () => {
    const f = fixture();
    try {
      injure(f, 35, 70); engage(f);
      if (['stale-deadline', 'counter', 'result-id'].includes(corruption)) { landing(f); landing(f); }
      rewrite(f, state => {
        if (corruption === 'alive-zero') state.players.a.party[0].hp = 0;
        if (corruption === 'false-down') state.players.a.life = { status: 'downed', downId: randomUUID() };
        if (corruption === 'bad-down-id') { state.players.a.party[0].hp = 0; state.players.a.life = { status: 'downed', downId: 'bad' }; }
        if (corruption === 'stale-deadline') state.monsters['trial-1'].respawnAt++;
        if (corruption === 'counter') state.monsters['trial-1'].refreshes++;
        if (corruption === 'result-id') state.monsters['trial-1'].lastResult.battleId = randomUUID();
        if (corruption === 'all-down-active') for (const player of Object.values(state.players)) {
          player.party[0].hp = 0; player.life = { status: 'downed', downId: randomUUID() };
        }
      });
      assert.throws(() => f.restart(), /invalid shared-world (life|encounter) checkpoint/);
    } finally { f.close(); }
  });
}

test('revive protocol forbids caller-supplied health, position and invalid identity shapes', () => {
  const input = { epoch: 'test', seq: 1, type: 'revive', downId: 'test' };
  assert.equal(validateSharedIntent(input), true);
  assert.equal(validateSharedIntent({ ...input, hp: 1000 }), false);
  assert.equal(validateSharedIntent({ ...input, x: 0 }), false);
  assert.equal(validateSharedIntent({ ...input, downId: ['test'] }), false);
});
