import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { validateSharedIntent } from '../src/shared-world.js';
import { fixture, legacyState } from './helpers/shared-world.mjs';

function request(f, id, input) {
  const v = f.world.read(id);
  return f.world.submit(id, { epoch: v.epoch, seq: v.nextSeq, ...input });
}
function action(f, id, action) {
  return request(f, id, { type: 'combat', battleId: f.world.read(id).battle.id, action });
}
function prepare(f) {
  f.send('a', 'east');
  for (let i = 0; i < 12; i++) f.step();
  f.send('a');
  const first = f.world.read('a');
  f.send('b', 'west');
  for (let i = 0; i < 11; i++) f.step();
  f.send('b');
  return first;
}
function join(f) {
  const before = prepare(f);
  const offer = f.world.read('b').joinOffers[0];
  assert.equal(offer.battleId, before.battle.id);
  return request(f, 'b', { type: 'joinBattle', battleId: offer.battleId });
}

test('nearby explicit join preserves one encounter, enemy clock and original defenses', () => {
  const f = fixture();
  try {
    prepare(f); action(f, 'a', 'dodge');
    const before = f.world.read('a');
    assert.equal(f.world.read('b').battle, null);
    const joined = request(f, 'b', { type: 'joinBattle', battleId: before.battle.id });
    assert.equal(joined.battle.id, before.battle.id);
    assert.equal(joined.battle.phaseUntilTick, before.battle.phaseUntilTick);
    assert.deepEqual(joined.battle.participants, ['a', 'b']);
    assert.equal(f.world.read('a').battle.iframeUntilTick, before.battle.iframeUntilTick);
    assert.equal(joined.battle.iframeRemainingMs, 0);
    assert.equal(joined.monsters['trial-1'].starts, 1);
    assert.throws(() => request(f, 'b', { type: 'joinBattle', battleId: before.battle.id }), /unavailable/);
    assert.equal(f.world.read('b').nextSeq, joined.nextSeq);
  } finally { f.close(); }
});

test('attacks and defenses are independent, both survive restart, victory releases both once', () => {
  const f = fixture();
  try {
    join(f);
    action(f, 'a', 'attack');
    const firstHp = f.world.read('b').battle.hp;
    action(f, 'b', 'attack');
    assert(f.world.read('a').battle.hp < firstHp);
    assert.equal(f.world.read('a').battle.hp, f.world.read('b').battle.hp);
    while (f.world.read('a').battle.phaseRemainingMs > 250) f.step();
    const protectedA = action(f, 'a', 'dodge');
    const hpA = protectedA.battle.partyHp, hpB = f.world.read('b').battle.partyHp;
    assert.equal(f.world.read('b').battle.iframeRemainingMs, 0);
    const before = ['a', 'b'].map(id => f.world.read(id));
    f.restart();
    for (const v of before) assert.deepEqual(f.world.read(v.self).battle, v.battle);
    for (let i = 0; i < 5; i++) f.step();
    assert.equal(f.world.read('a').battle.partyHp, hpA);
    assert.equal(f.world.read('b').battle.partyHp, hpB - 35);
    assert.equal(f.world.read('a').battle.dodges, 1);
    assert.equal(f.world.read('b').battle.dodges, 0);
    assert.equal(f.world.read('a').battle.strikes, 1);
    assert.equal(f.world.read('b').battle.strikes, 1);
    while (f.world.read('a').battle) {
      for (const id of ['a', 'b']) {
        if (!f.world.read(id).battle) break;
        if (!f.world.read(id).battle.actionRemainingMs) action(f, id, 'heavy');
      }
      f.step();
    }
    assert.equal(f.world.read('b').battle, null);
    const monster = f.world.read('a').monsters['trial-1'];
    assert.equal(monster.settlements, 1);
    assert.deepEqual(monster.victors, ['a', 'b']);
    f.restart(); f.step();
    assert.equal(f.world.read('a').monsters['trial-1'].settlements, 1);
    for (const id of ['a', 'b']) assert.throws(() => request(f, id, { type: 'combat', battleId: before[0].battle.id, action: 'heavy' }), /unavailable/);
  } finally { f.close(); }
});

function rewrite(f, change) {
  const db = new DatabaseSync(f.filename);
  try {
    const saved = JSON.parse(db.prepare('SELECT state FROM shared_world WHERE id=1').get().state);
    db.prepare('UPDATE shared_world SET state=? WHERE id=1').run(JSON.stringify(change(saved) ?? saved));
  } finally { db.close(); }
}
function engageSeparate(f) {
  f.send('a', 'east'); for (let i = 0; i < 12; i++) f.step(); f.send('a');
  const target = f.world.read('b').monsters['trial-2'];
  for (let i = 0; Math.abs(f.world.read('b').players.b.z - target.z) > 0.25; i++) {
    assert(i < 120);
    f.send('b', target.z > f.world.read('b').players.b.z ? 'south' : 'north'); f.step();
  }
  for (let i = 0; !f.world.read('b').battle; i++) {
    assert(i < 30); f.send('b', 'west'); f.step();
  }
  f.send('b');
}

test('joining outside range or while busy cannot change membership or consume sequence', () => {
  const f = fixture();
  try {
    f.send('a', 'east'); for (let i = 0; i < 12; i++) f.step();
    const id = f.world.read('a').battle.id, before = f.world.read('b');
    assert.deepEqual(before.joinOffers, []);
    assert.throws(() => request(f, 'b', { type: 'joinBattle', battleId: id }), /distance/);
    assert.equal(f.world.read('b').nextSeq, before.nextSeq);
    assert.throws(() => request(f, 'b', { type: 'joinBattle', battleId: 'unknown' }), /unavailable/);
  } finally { f.close(); }
  const busy = fixture();
  try {
    engageSeparate(busy);
    const a = busy.world.read('a'), b = busy.world.read('b');
    assert.throws(() => request(busy, 'b', { type: 'joinBattle', battleId: a.battle.id }), /unavailable/);
    assert.deepEqual(busy.world.read('b').battle, b.battle);
    assert.equal(busy.world.read('b').nextSeq, b.nextSeq);
  } finally { busy.close(); }
});

test('a joining request first resolves a due strike against existing members only', () => {
  const f = fixture();
  try {
    prepare(f);
    while (f.world.read('a').battle.phaseRemainingMs > 50) f.step();
    const a = f.world.read('a'), b = f.world.read('b');
    f.elapse(50);
    const joined = request(f, 'b', { type: 'joinBattle', battleId: a.battle.id });
    assert.equal(joined.battle.strikes, a.battle.strikes + 1);
    assert.equal(joined.battle.phase, 'recovery');
    assert.equal(f.world.read('a').battle.partyHp, a.battle.partyHp - 35);
    assert.equal(joined.battle.partyHp, b.battle?.partyHp ?? 260);
  } finally { f.close(); }
});

test('a failed join commit restores original membership and unchanged player sequence', () => {
  const f = fixture();
  try {
    prepare(f);
    const a = f.world.read('a'), b = f.world.read('b');
    const db = new DatabaseSync(f.filename);
    try {
      db.exec("CREATE TRIGGER fail_join BEFORE UPDATE ON shared_world BEGIN SELECT RAISE(FAIL, 'test join failure'); END");
      assert.throws(() => request(f, 'b', { type: 'joinBattle', battleId: a.battle.id }), /test join failure/);
      assert.throws(() => f.world.read('b'), /requires restart/);
      const raw = JSON.parse(db.prepare('SELECT state FROM shared_world WHERE id=1').get().state);
      assert.deepEqual(Object.keys(raw.battles[a.battle.id].participants), ['a']);
      assert.equal(raw.players.b.seq + 1, b.nextSeq);
      db.exec('DROP TRIGGER fail_join');
    } finally { db.close(); }
    f.restart();
    assert.equal(f.world.read('b').battle, null);
    assert.equal(f.world.read('b').nextSeq, b.nextSeq);
    assert.equal(request(f, 'b', { type: 'joinBattle', battleId: a.battle.id }).battle.id, a.battle.id);
  } finally { f.close(); }
});

test('cooperative victory commit is atomic and competing final commands settle only once', () => {
  const f = fixture();
  try {
    join(f);
    rewrite(f, state => {
      Object.values(state.battles)[0].combat.enemy_hp = 1;
      state.players.a.party[0].hp = 100; state.players.b.party[0].hp = 120;
    });
    f.restart();
    const before = f.world.read('a'), beforeB = f.world.read('b');
    const db = new DatabaseSync(f.filename);
    try {
      db.exec("CREATE TRIGGER fail_victory BEFORE UPDATE ON shared_world BEGIN SELECT RAISE(FAIL, 'test victory failure'); END");
      assert.throws(() => action(f, 'a', 'heavy'), /test victory failure/);
      assert.throws(() => f.world.read('a'), /requires restart/);
      const raw = JSON.parse(db.prepare('SELECT state FROM shared_world WHERE id=1').get().state);
      assert.equal(raw.monsters['trial-1'].settlements, 0);
      assert.equal(raw.battles[before.battle.id].combat.enemy_hp, 1);
      assert.equal(raw.players.a.party[0].hp, 100); assert.equal(raw.players.b.party[0].hp, 120);
      db.exec('DROP TRIGGER fail_victory');
    } finally { db.close(); }
    f.restart(); action(f, 'a', 'heavy');
    assert.throws(() => request(f, 'b', { type: 'combat', battleId: before.battle.id, action: 'heavy' }), /unavailable/);
    assert.equal(f.world.read('b').nextSeq, beforeB.nextSeq);
    assert.throws(() => request(f, 'b', { type: 'joinBattle', battleId: before.battle.id }), /unavailable/);
    f.restart();
    const result = f.world.read('a').monsters['trial-1'];
    assert.equal(result.settlements, 1); assert.deepEqual(result.victors, ['a', 'b']);
    assert.equal(f.world.read('a').battle, null); assert.equal(f.world.read('b').battle, null);
    const rawDb = new DatabaseSync(f.filename, { readOnly: true });
    try {
      const raw = JSON.parse(rawDb.prepare('SELECT state FROM shared_world WHERE id=1').get().state);
      for (const id of ['a', 'b']) assert.equal(raw.players[id].party[0].hp, raw.players[id].party[0].max_hp);
    } finally { rawDb.close(); }
  } finally { f.close(); }
});

for (const corruption of ['empty', 'unknown', 'window', 'shared-defense', 'personal-shared']) test('corrupt cooperative ' + corruption + ' fails closed', () => {
  const f = fixture();
  try {
    join(f);
    rewrite(f, state => {
      const battle = Object.values(state.battles)[0];
      if (corruption === 'empty') battle.participants = {};
      if (corruption === 'unknown') battle.participants.c = structuredClone(battle.participants.b);
      if (corruption === 'window') battle.participants.b.clock.iframeUntil = state.simTick + 100;
      if (corruption === 'shared-defense') battle.clock.iframeUntil = state.simTick + 9;
      if (corruption === 'personal-shared') battle.combat.combo_step = 2;
    });
    assert.throws(() => f.restart(), /invalid shared-world encounter checkpoint/);
  } finally { f.close(); }
});

test('v4 parallel encounters migrate with both identities, stats and defense deadlines intact', () => {
  const f = fixture();
  try {
    engageSeparate(f); action(f, 'a', 'dodge'); action(f, 'b', 'guard');
    const before = ['a', 'b'].map(id => f.world.read(id));
    rewrite(f, state => legacyState(state, 4)); f.restart();
    for (const v of before) {
      assert.deepEqual(f.world.read(v.self).battle, v.battle);
      assert.equal(f.world.read(v.self).nextSeq, v.nextSeq);
    }
    f.restart();
    for (const v of before) assert.deepEqual(f.world.read(v.self).battle, v.battle);
  } finally { f.close(); }
});

test('join protocol accepts only the server-defined four-field intent', () => {
  const input = { epoch: 'test', seq: 1, type: 'joinBattle', battleId: 'test' };
  assert.equal(validateSharedIntent(input), true);
  assert.equal(validateSharedIntent({ ...input, iframeUntil: 1000 }), false);
  assert.equal(validateSharedIntent({ ...input, battleId: ['test'] }), false);
  assert.equal(validateSharedIntent({ ...input, seq: 0 }), false);
});

test('staggered personal dodges expire independently and rejected repeats protect neither teammate', () => {
  const f = fixture();
  try {
    join(f);
    while (f.world.read('a').battle.phaseRemainingMs > 600) f.step();
    const a = action(f, 'a', 'dodge');
    while (f.world.read('b').battle.phaseRemainingMs > 200) f.step();
    const b = action(f, 'b', 'dodge');
    assert.equal(f.world.read('a').battle.iframeUntilTick, a.battle.iframeUntilTick);
    assert(b.battle.iframeUntilTick > a.battle.iframeUntilTick);
    assert.throws(() => action(f, 'a', 'dodge'), /cooldown/);
    const hpA = f.world.read('a').battle.partyHp, hpB = b.battle.partyHp;
    f.restart();
    while (f.world.read('a').battle.phase === 'warning') f.step();
    assert.equal(f.world.read('a').battle.partyHp, hpA - 35);
    assert.equal(f.world.read('a').battle.iframeRemainingMs, 0);
    assert.equal(f.world.read('b').battle.partyHp, hpB);
    assert.equal(f.world.read('b').battle.dodges, 1);
    assert.equal(f.world.read('a').battle.dodges, 0);
  } finally { f.close(); }
});

test('an engaged monster cannot claim completed victors in a checkpoint', () => {
  const f = fixture();
  try {
    join(f);
    rewrite(f, state => { state.monsters['trial-1'].victors = ['a']; });
    assert.throws(() => f.restart(), /invalid shared-world encounter checkpoint/);
  } finally { f.close(); }
});
