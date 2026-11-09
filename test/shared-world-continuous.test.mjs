import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fixture, legacyState } from './helpers/shared-world.mjs';


test('both players travel at four meters per second regardless of renewal frequency', () => {
  const f = fixture();
  try {
    const initial = f.world.read('a');
    f.send('a', 'north'); f.send('b', 'north');
    for (let tick = 0; tick < 20; tick++) {
      f.send('a', 'north');
      if (tick % 4 === 0) f.send('b', 'north');
      f.step();
    }
    const view = f.world.read('a');
    for (const id of ['a', 'b']) assert(Math.abs(view.players[id].z - initial.players[id].z + 4) < 1e-8);
    assert.equal(view.simTimeMs, 1000);
    assert.equal(view.simTick, 20);
    f.send('a');
    const stopped = f.world.read('a').players.a;
    f.step(); f.step();
    assert.deepEqual(f.world.read('a').players.a, stopped);
  } finally { f.close(); }
});

test('expired inputs stop and committed moving positions restore without held input', () => {
  const f = fixture();
  try {
    f.send('a', 'north');
    for (let i = 0; i < 4; i++) f.step();
    const before = f.world.read('a');
    assert.equal(before.players.a.moving, true);
    f.restart();
    const restored = f.world.read('a');
    assert.notEqual(restored.epoch, before.epoch);
    assert.equal(restored.simTick, before.simTick);
    assert.equal(restored.players.a.z, before.players.a.z);
    assert.equal(restored.players.a.moving, false);
    assert.throws(() => f.world.submit('a', { epoch: before.epoch, seq: before.nextSeq, type: 'move', direction: 'north' }), /stale/);
    f.step();
    assert.equal(f.world.read('a').players.a.z, restored.players.a.z);
    f.send('a', 'north');
    for (let i = 0; i < 16; i++) f.step();
    const expired = f.world.read('a').players.a;
    assert.equal(expired.moving, false);
    f.step();
    assert.deepEqual(f.world.read('a').players.a, expired);
  } finally { f.close(); }
});

test('a newly received direction cannot move through time before it was received', () => {
  const f = fixture();
  try {
    const before = f.world.read('a').players.a;
    f.elapse(200);
    f.send('a', 'north');
    f.world.advance();
    assert.equal(before.z, f.world.read('a').players.a.z);
    f.step();
    assert(Math.abs(before.z - f.world.read('a').players.a.z - 0.2) < 1e-8);
  } finally { f.close(); }
});

test('old checkpoints migrate positions and identities with no transient input', () => {
  const f = fixture();
  try {
    f.send('a', 'north'); f.step();
    const before = f.world.read('a');
    const db = new DatabaseSync(f.filename);
    try {
      const old = legacyState(JSON.parse(db.prepare('SELECT state FROM shared_world WHERE id = 1').get().state), 1);
      db.prepare('UPDATE shared_world SET state = ? WHERE id = 1').run(JSON.stringify(old));
    } finally { db.close(); }
    f.restart();
    const restored = f.world.read('a');
    assert.equal(restored.players.a.z, before.players.a.z);
    assert.equal(restored.nextSeq, before.nextSeq);
    assert.equal(restored.players.a.moving, false);
    assert.equal(restored.simTick, 0);
    f.step(); f.restart();
    assert.equal(f.world.read('a').simTick, 1);
  } finally { f.close(); }
});

test('a late timer preserves steps before lease expiry and stop settles preceding elapsed steps', () => {
  const f = fixture();
  try {
    f.send('a', 'north');
    for (let i = 0; i < 13; i++) f.step();
    const before = f.world.read('a');
    f.step(150);
    assert(Math.abs(before.players.a.z - f.world.read('a').players.a.z - 0.2) < 1e-8);
    f.send('a', 'north');
    const held = f.world.read('a');
    f.elapse(100);
    f.send('a');
    assert(Math.abs(held.players.a.z - f.world.read('a').players.a.z - 0.4) < 1e-8);
  } finally { f.close(); }
});

function engage(f) {
  f.send('a', 'east');
  for (let i = 0; i < 12 && !f.world.read('a').battle; i++) f.step();
  assert.equal(f.world.read('a').monsters['trial-1'].starts, 1);
  assert(f.world.read('a').battle);
}
function combat(f, action, request) {
  const v = f.world.read('a');
  return f.world.submit('a', request ?? { epoch: v.epoch, seq: v.nextSeq, type: 'combat', battleId: v.battle.id, action });
}

test('battle deadlines, duplicate defense, independent exploration and atomic restart settlement', () => {
  const f = fixture();
  try {
    engage(f);
    const initial = f.world.read('a');
    // Dodge covers the first landing, but does not cancel the warning early.
    while (f.world.read('a').simTick < initial.battle.phaseUntilTick - 5) f.step();
    const v = f.world.read('a');
    const request = { epoch: v.epoch, seq: v.nextSeq, type: 'combat', battleId: v.battle.id, action: 'dodge' };
    const dodged = combat(f, 'dodge', request);
    assert.equal(dodged.battle.dodges, 0);
    assert.equal(dodged.battle.telegraph, true);
    assert.throws(() => combat(f, 'dodge', request), /stale/);
    f.step();
    assert.throws(() => combat(f, 'dodge'), /cooldown/);
    assert.equal(f.world.read('a').battle.iframeUntilTick, dodged.battle.iframeUntilTick);
    // A rejected defense with a fresh sequence after general action cooldown also cannot renew it.
    for (let i = 0; i < 5; i++) f.step();
    assert.throws(() => combat(f, 'guard'), /cooldown/);
    assert.equal(f.world.read('a').battle.dodges, 1);
    f.restart();
    assert.equal(f.world.read('a').battle.dodges, 1);
    const b = f.world.read('b'); f.send('b', 'north');
    for (let i = 0; i < 5; i++) f.step();
    assert(f.world.read('b').players.b.z < b.players.b.z);
    assert.equal(f.world.read('b').battle, null);
    f.send('b');
    while (f.world.read('a').battle.iframeRemainingMs) f.step();
    assert.equal(f.world.read('a').battle.iframeRemainingMs, 0);
    while (f.world.read('a').simTick < initial.battle.phaseUntilTick + 50) f.step();
    assert.equal(f.world.read('a').battle.strikes, 2);
    assert.equal(f.world.read('a').battle.partyHp, initial.battle.partyHp - 35);
    // Crash with a new live iframe, restore the exact remaining ticks, land once.
    while (f.world.read('a').battle.phase !== 'warning') f.step();
    while (f.world.read('a').battle.phaseRemainingMs > 250) f.step();
    const protectedView = combat(f, 'dodge');
    f.restart();
    assert.deepEqual(f.world.read('a').battle, protectedView.battle);
    for (let i = 0; i < 5; i++) f.step();
    assert.equal(f.world.read('a').battle.strikes, 3);
    assert.equal(f.world.read('a').battle.dodges, 2);
    const after = f.world.read('a'); f.restart();
    assert.deepEqual(f.world.read('a').battle, after.battle);
    f.step(); assert.equal(f.world.read('a').battle.strikes, 3);
    while (f.world.read('a').battle) {
      while (f.world.read('a').battle?.actionRemainingMs) f.step();
      combat(f, 'heavy');
    }
    f.restart(); f.step();
    assert.equal(f.world.read('a').monsters['trial-1'].settlements, 1);
    assert.equal(f.world.read('a').battle, null);
    assert.throws(() => combat(f, 'dodge', request), /stale/);
  } finally { f.close(); }
});

test('v2 engaged checkpoints receive one fresh warning and persist their migrated clock', () => {
  const f = fixture();
  try {
    engage(f);
    const before = f.world.read('a');
    const db = new DatabaseSync(f.filename);
    try {
      const old = legacyState(JSON.parse(db.prepare('SELECT state FROM shared_world WHERE id=1').get().state), 2);
      db.prepare('UPDATE shared_world SET state=? WHERE id=1').run(JSON.stringify(old));
    } finally { db.close(); }
    f.restart();
    const migrated = f.world.read('a');
    assert.equal(migrated.battle.hp, before.battle.hp);
    assert.equal(migrated.battle.phaseRemainingMs, 1500);
    f.step(); f.restart();
    assert.equal(f.world.read('a').battle.phaseRemainingMs, 1450);
  } finally { f.close(); }
});

test('a failed strike commit publishes no damage and restart applies the strike once', () => {
  const f = fixture();
  try {
    engage(f);
    while (f.world.read('a').battle.phaseRemainingMs > 50) f.step();
    const before = f.world.read('a');
    const db = new DatabaseSync(f.filename);
    try {
      db.exec("CREATE TRIGGER fail_write BEFORE UPDATE ON shared_world BEGIN SELECT RAISE(FAIL, 'test disk failure'); END");
      assert.throws(() => f.step(), /test disk failure/);
      assert.throws(() => f.world.read('a'), /requires restart/);
      const saved = JSON.parse(db.prepare('SELECT state FROM shared_world WHERE id=1').get().state);
      assert.equal(saved.simTick, before.simTick);
      assert.equal(Object.values(saved.battles)[0].clock.strikes, 0);
      assert.equal(saved.players.a.party[0].hp, before.battle.partyHp);
      db.exec('DROP TRIGGER fail_write');
    } finally { db.close(); }
    f.restart(); f.step();
    assert.equal(f.world.read('a').battle.strikes, 1);
    assert.equal(f.world.read('a').battle.partyHp, before.battle.partyHp - 35);
    f.restart(); f.step();
    assert.equal(f.world.read('a').battle.strikes, 1);
  } finally { f.close(); }
});

test('corrupt v5 clock deadlines fail closed at startup', () => {
  const f = fixture();
  try {
    engage(f);
    const db = new DatabaseSync(f.filename);
    try {
      const saved = JSON.parse(db.prepare('SELECT state FROM shared_world WHERE id=1').get().state);
      Object.values(saved.battles)[0].clock.phaseUntil = saved.simTick;
      db.prepare('UPDATE shared_world SET state=? WHERE id=1').run(JSON.stringify(saved));
    } finally { db.close(); }
    assert.throws(() => f.restart(), /invalid shared-world encounter checkpoint/);
  } finally { f.close(); }
});
