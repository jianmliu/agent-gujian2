import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fixture, legacyState } from './helpers/shared-world.mjs';

function act(f, id, action, battleId) {
  const v = f.world.read(id);
  return f.world.submit(id, { epoch: v.epoch, seq: v.nextSeq, type: 'combat', battleId: battleId ?? v.battle.id, action });
}
function walk(f, id, target) {
  for (const axis of ['z', 'x']) {
    for (let step = 0; Math.abs(f.world.read(id).players[id][axis] - target[axis]) > 0.25; step++) {
      assert(step < 200, 'walk is bounded');
      if (f.world.read(id).battle) break;
      const delta = target[axis] - f.world.read(id).players[id][axis];
      f.send(id, axis === 'x' ? (delta > 0 ? 'east' : 'west') : (delta > 0 ? 'south' : 'north'));
      f.step();
    }
  }
  f.send(id);
}
function engageBoth(f) {
  const monsters = f.world.read('a').monsters;
  assert.equal(Object.keys(monsters).length, 2);
  walk(f, 'a', monsters['trial-1']);
  walk(f, 'b', monsters['trial-2']);
  assert.equal(f.world.read('a').battle.monsterId, 'trial-1');
  assert.equal(f.world.read('b').battle.monsterId, 'trial-2');
}
function finish(f, id) {
  while (f.world.read(id).battle) {
    while (f.world.read(id).battle.actionRemainingMs > 0) f.step();
    act(f, id, 'heavy');
  }
}

test('same monster permits only one encounter when both players contact in one tick', () => {
  const f = fixture();
  try {
    f.send('a', 'east'); f.send('b', 'west');
    for (let i = 0; i < 12; i++) f.step();
    const a = f.world.read('a'), b = f.world.read('b');
    assert.equal(a.monsters['trial-1'].starts, 1);
    assert.equal([a, b].filter(v => v.battle).length, 1);
    assert.equal(a.monsters['trial-2'].starts, 0);
    const loser = a.battle ? 'b' : 'a', winner = a.battle ? a : b;
    assert.throws(() => act(f, loser, 'heavy', winner.battle.id), /unavailable/);
  } finally { f.close(); }
});

test('two private encounters advance independently, restore both clocks and settle once each', () => {
  const f = fixture();
  try {
    engageBoth(f);
    const beforeA = f.world.read('a'), beforeB = f.world.read('b');
    assert.notEqual(beforeA.battle.id, beforeB.battle.id);
    assert.throws(() => act(f, 'a', 'attack', beforeB.battle.id), /unavailable/);
    assert.throws(() => act(f, 'b', 'attack', beforeA.battle.id), /unavailable/);
    act(f, 'a', 'dodge'); act(f, 'b', 'attack');
    const a = f.world.read('a'), b = f.world.read('b');
    assert.equal(a.battle.hp, 600);
    assert(b.battle.hp < 600);
    assert.equal(b.battle.iframeRemainingMs, 0);
    f.restart();
    assert.deepEqual(f.world.read('a').battle, a.battle);
    assert.deepEqual(f.world.read('b').battle, b.battle);
    assert.equal(f.world.read('a').nextSeq, a.nextSeq);
    for (let i = 0; i < 60; i++) f.step();
    assert(f.world.read('a').battle.strikes > a.battle.strikes);
    assert(f.world.read('b').battle.strikes > b.battle.strikes);
    finish(f, 'a');
    const pending = f.world.read('b').battle;
    assert(pending);
    assert.equal(f.world.read('a').monsters['trial-1'].settlements, 1);
    assert.equal(f.world.read('a').monsters['trial-2'].settlements, 0);
    const position = f.world.read('a').players.a;
    f.send('a', 'north'); f.step(); f.send('a');
    assert(f.world.read('a').players.a.z < position.z);
    f.restart();
    assert.equal(f.world.read('b').battle.id, pending.id);
    finish(f, 'b'); f.restart();
    for (let i = 0; i < 35; i++) f.step();
    for (const monster of Object.values(f.world.read('a').monsters)) {
      assert.equal(monster.starts, 1); assert.equal(monster.settlements, 1); assert.equal(monster.status, 'defeated');
    }
    assert.equal(f.world.read('a').battle, null); assert.equal(f.world.read('b').battle, null);
    assert.throws(() => act(f, 'a', 'heavy', a.battle.id), /unavailable/);
  } finally { f.close(); }
});

// Tests below mutate disk only while the host is about to restart, to model old/corrupt archives.

function rewrite(f, change) {
  const db = new DatabaseSync(f.filename);
  try {
    const saved = JSON.parse(db.prepare('SELECT state FROM shared_world WHERE id=1').get().state);
    db.prepare('UPDATE shared_world SET state=? WHERE id=1').run(JSON.stringify(change(saved) ?? saved));
  } finally { db.close(); }
}

for (const version of [1, 2, 3, 4]) for (const status of ['available', 'engaged', 'defeated']) {
  test(`v${version} ${status} checkpoint migrates once with stable identity and original progress`, () => {
    const f = fixture();
    try {
      if (status !== 'available') walk(f, 'a', f.world.read('a').monsters['trial-1']);
      if (status === 'engaged') { act(f, 'a', 'dodge'); f.step(); }
      if (status === 'defeated') finish(f, 'a');
      const before = f.world.read('a');
      rewrite(f, state => legacyState(state, version));
      f.restart();
      const migrated = f.world.read('a');
      assert.equal(migrated.nextSeq, before.nextSeq);
      assert.deepEqual(migrated.players.a, before.players.a);
      assert.equal(migrated.monsters['trial-1'].status, status);
      assert.equal(migrated.monsters['trial-1'].settlements, status === 'defeated' ? 1 : 0);
      assert.equal(migrated.monsters['trial-2'].status, 'available');
      if (status === 'engaged') {
        assert.notEqual(migrated.battle.id, 'shared_trial');
        assert.equal(migrated.battle.hp, before.battle.hp);
        assert.equal(migrated.battle.partyHp, before.battle.partyHp);
        if (version >= 3) {
          for (const key of ['phaseUntilTick', 'iframeUntilTick', 'iframeRemainingMs', 'defenseRemainingMs', 'actionRemainingMs']) {
            assert.equal(migrated.battle[key], before.battle[key]);
          }
        } else assert.equal(migrated.battle.phaseRemainingMs, 1500);
      }
      const db = new DatabaseSync(f.filename, { readOnly: true });
      try {
        const saved = JSON.parse(db.prepare('SELECT state FROM shared_world WHERE id=1').get().state);
        assert.equal(saved.version, 5);
        assert.equal(saved.revision, before.revision + 1);
        assert.equal(saved.monster, undefined); assert.equal(saved.battle, undefined);
      } finally { db.close(); }
      // No advance between restarts: migration is already durable, including its new UUID.
      f.restart();
      assert.equal(f.world.read('a').revision, migrated.revision);
      assert.deepEqual(f.world.read('a').battle, migrated.battle);
    } finally { f.close(); }
  });
}

test('both strikes commit atomically and resume once after a failed simultaneous landing', () => {
  const f = fixture();
  try {
    engageBoth(f);
    rewrite(f, state => {
      for (const battle of Object.values(state.battles)) {
        battle.clock.phase = 'warning'; battle.clock.phaseUntil = state.simTick + 1;
        for (const member of Object.values(battle.participants)) {
          member.clock.iframeUntil = 0; member.clock.guardUntil = 0;
        }
      }
    });
    f.restart();
    const before = ['a', 'b'].map(id => f.world.read(id));
    const db = new DatabaseSync(f.filename);
    try {
      db.exec("CREATE TRIGGER fail_both BEFORE UPDATE ON shared_world BEGIN SELECT RAISE(FAIL, 'test dual failure'); END");
      assert.throws(() => f.step(), /test dual failure/);
      for (const id of ['a', 'b']) assert.throws(() => f.world.read(id), /requires restart/);
      const raw = JSON.parse(db.prepare('SELECT state FROM shared_world WHERE id=1').get().state);
      for (const view of before) {
        assert.equal(raw.battles[view.battle.id].clock.strikes, view.battle.strikes);
        assert.equal(raw.players[view.self].party[0].hp, view.battle.partyHp);
      }
      db.exec('DROP TRIGGER fail_both');
    } finally { db.close(); }
    f.restart(); f.step();
    for (const view of before) {
      const after = f.world.read(view.self);
      assert.equal(after.battle.strikes, view.battle.strikes + 1);
      assert.equal(after.battle.partyHp, view.battle.partyHp - 35);
    }
    f.restart(); f.step();
    for (const view of before) assert.equal(f.world.read(view.self).battle.strikes, view.battle.strikes + 1);
  } finally { f.close(); }
});

for (const corruption of ['owner', 'monster', 'id', 'orphan', 'tombstone']) {
  test(`corrupt parallel ${corruption} association fails closed`, () => {
    const f = fixture();
    try {
      engageBoth(f);
      rewrite(f, state => {
        const [a, b] = Object.values(state.battles);
        if (corruption === 'owner') b.participants = structuredClone(a.participants);
        if (corruption === 'monster') b.monsterId = a.monsterId;
        if (corruption === 'id') b.id = a.id;
        if (corruption === 'orphan') delete state.battles[a.id];
        if (corruption === 'tombstone') {
          delete state.battles[b.id];
          state.monsters[b.monsterId] = { status: 'defeated', starts: 1, settlements: 1, battleId: a.id };
        }
      });
      assert.throws(() => f.restart(), /invalid shared-world encounter checkpoint/);
    } finally { f.close(); }
  });
}

test('a settled encounter ID cannot command a later encounter owned by the same player', () => {
  const f = fixture();
  try {
    walk(f, 'a', f.world.read('a').monsters['trial-1']);
    const original = f.world.read('a').battle.id;
    finish(f, 'a');
    walk(f, 'a', f.world.read('a').monsters['trial-2']);
    const next = f.world.read('a');
    assert(next.battle); assert.notEqual(next.battle.id, original);
    assert.throws(() => act(f, 'a', 'attack', original), /unavailable/);
    assert.equal(f.world.read('a').nextSeq, next.nextSeq);
    f.restart(); assert.equal(f.world.read('a').battle.id, next.battle.id);
  } finally { f.close(); }
});
