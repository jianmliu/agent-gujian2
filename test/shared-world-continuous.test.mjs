import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { buildProceduralWorldAssets, Gujian2EngineCore } from '../src/engine_core.js';
import { openSharedWorld } from '../src/shared-world.js';

function fixture() {
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
    restart() { world.close(); world = openSharedWorld(options); },
    close() { world.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

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
      const old = JSON.parse(db.prepare('SELECT state FROM shared_world WHERE id = 1').get().state);
      old.version = 1; delete old.simTick;
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
