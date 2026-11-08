import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { get as httpGet } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { chromium } from 'playwright';

const tokens = ['alpha-test-secret-0000', 'beta-test-secret-00000'];

for (const entry of ['/', '/play3d']) test(entry + ' continuous world survives moving and battle process deaths', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gujian2-continuous-browser-'));
  const filename = join(dir, 'world.sqlite');
  const serverPath = new URL('../bin/agent-gujian2-shared.mjs', import.meta.url);
  const children = [], pageErrors = [];
  let browser;
  const state = page => page.locator('#world').getAttribute('data-view').then(JSON.parse);
  async function wait(page, predicate, value) {
    await page.waitForFunction(({ source, value }) => {
      const raw = document.querySelector('#world')?.dataset.view;
      return raw && new Function('s', 'value', 'return (' + source + ')(s, value)')(JSON.parse(raw), value);
    }, { source: predicate.toString(), value }, { timeout: 8000 });
    return state(page);
  }
  async function start(port = 0) {
    const assets = process.env.GUJIAN2_TEST_ASSETS, render = process.env.GUJIAN2_TEST_RENDER;
    const child = spawn(process.execPath, [serverPath.pathname, '--port', String(port), '--db', filename,
      ...(assets ? ['--assets', assets] : []), ...(render ? ['--render', render] : [])], {
      env: { ...process.env, GUJIAN2_PLAYER_A_TOKEN: tokens[0], GUJIAN2_PLAYER_B_TOKEN: tokens[1] },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    children.push({ child, closed });
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    const reader = createInterface({ input: child.stdout });
    const url = await Promise.race([
      once(reader, 'line').then(([line]) => JSON.parse(line).url),
      closed.then(([code]) => { throw Error('server exited ' + code + ': ' + errors); }),
    ]);
    reader.close();
    return { child, closed, url };
  }
  async function connect(server) {
    return Promise.all(tokens.map(async token => {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(new URL(entry, server.url).href);
      await page.locator('#token').fill(token);
      await page.locator('#join').click();
      await wait(page, () => true);
      if (entry === '/play3d') {
        await page.waitForFunction(() => document.querySelector('#scene3d')?.dataset.ready === 'true');
        const rendered = await page.locator('#scene3d').getAttribute('data-render').then(JSON.parse);
        assert.equal(rendered.actors.length, 2);
        assert(rendered.drawCalls > 0 && rendered.actors.every(actor => actor.visible && actor.skinned));
      }
      return page;
    }));
  }
  async function key(page, name, down) {
    await page.keyboard[down ? 'down' : 'up'](name);
  }
  async function stop(page, name) {
    await key(page, name, false);
    return wait(page, s => !s.players[s.self].moving);
  }
  async function ticks(page, count) {
    const before = await state(page);
    return wait(page, (s, tick) => s.simTick >= tick, before.simTick + count);
  }
  async function killAndRead(server, pages, closePages = true) {
    server.child.kill('SIGKILL');
    assert.deepEqual(await server.closed, [null, 'SIGKILL']);
    const db = new DatabaseSync(filename, { readOnly: true });
    let saved;
    try { saved = JSON.parse(db.prepare('SELECT state FROM shared_world WHERE id = 1').get().state); }
    finally { db.close(); }
    if (closePages) await Promise.all(pages.map(page => page.context().close()));
    return saved;
  }
  function compareRecovery(saved, view) {
    assert(view.simTick >= saved.simTick);
    for (const id of ['a', 'b']) {
      assert.equal(view.players[id].x, saved.players[id].x);
      assert.equal(view.players[id].z, saved.players[id].z);
      assert.equal(view.players[id].moving, false);
    }
    assert.equal(view.monster.status, saved.monster.status);
    assert.equal(view.monster.starts, saved.monster.starts);
  }
  async function send(server, index, body) {
    return fetch(server.url + '/intent', {
      method: 'POST', headers: { Authorization: 'Bearer ' + tokens[index], 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  }
  async function fight(page, action) {
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/intent') && r.ok() && r.request().postDataJSON().type === 'combat'),
      page.locator('#' + action).click(),
    ]);
    const view = await response.json();
    await wait(page, (s, seq) => s.nextSeq >= seq, view.nextSeq);
    return view;
  }
  async function align(page, z) {
    const view = await state(page);
    if (Math.abs(view.players[view.self].z - z) < 0.6) return;
    const keyName = view.players[view.self].z < z ? 'ArrowDown' : 'ArrowUp';
    await key(page, keyName, true);
    await wait(page, (s, target) => Math.abs(s.players[s.self].z - target) < 0.6, z);
    await stop(page, keyName);
  }
  try {
    let server = await start();
    assert.equal((await fetch(server.url + '/state')).status, 401);
    const traversal = await new Promise((resolve, reject) => {
      httpGet(server.url, { path: '/assets/chars/../world.meta.json', headers: { Authorization: 'Bearer ' + tokens[0] } }, response => {
        response.resume(); resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(traversal, 404);
    browser = await chromium.launch();
    let pages = await connect(server);
    const [a, b] = pages;
    const initial = await state(a);
    assert.equal((await send(server, 0, { epoch: initial.epoch, seq: initial.nextSeq, type: 'move', direction: ['east'] })).status, 400);
    assert.equal(await a.locator('[data-player="b"]').count(), 1);
    assert.equal(await b.locator('[data-player="a"]').count(), 1);

    await Promise.all(pages.map(page => key(page, 'ArrowUp', true)));
    const moving = await wait(a, s => s.players.a.moving && s.players.b.moving);
    for (let i = 0; i < 15; i++) await key(a, 'ArrowUp', true);
    const later = await wait(a, (s, tick) => s.simTick >= tick, moving.simTick + 6);
    for (const id of ['a', 'b']) {
      const expected = (later.simTick - moving.simTick) * 0.2;
      assert(Math.abs(moving.players[id].z - later.players[id].z - expected) < 1e-7, JSON.stringify({ id, moving, later, expected }));
    }
    await Promise.all(pages.map(page => stop(page, 'ArrowUp')));
    const stopped = await wait(a, s => !s.players.a.moving && !s.players.b.moving);
    assert.deepEqual((await ticks(a, 5)).players, stopped.players, 'key release stops both players');

    await key(a, 'ArrowDown', true);
    await wait(b, s => s.players.a.moving);
    await a.context().route('**/intent', route => route.abort());
    const disconnected = await wait(b, s => !s.players.a.moving);
    assert.deepEqual((await ticks(b, 5)).players.a, disconnected.players.a, 'lost input lease stops disconnected player');
    await key(a, 'ArrowDown', false);
    await a.context().unroute('**/intent');
    await ticks(a, 3);

    await Promise.all(pages.map(page => key(page, 'ArrowUp', true)));
    await wait(a, s => s.players.a.moving && s.players.b.moving);
    const old = await state(a);
    const movingPort = Number(new URL(server.url).port);
    const savedMoving = await killAndRead(server, pages, false);
    server = await start(movingPort);
    let recovered = await wait(pages[0], (s, epoch) => s.epoch !== epoch, old.epoch);
    await wait(pages[1], (s, epoch) => s.epoch !== epoch, old.epoch);
    await Promise.all(pages.map(page => key(page, 'ArrowUp', false)));
    assert.notEqual(recovered.epoch, old.epoch);
    compareRecovery(savedMoving, recovered);
    assert.deepEqual((await ticks(pages[0], 5)).players, recovered.players, 'restored held input cannot resume movement');
    assert.equal((await send(server, 0, { epoch: old.epoch, seq: old.nextSeq, type: 'move', direction: 'north' })).status, 409);

    await Promise.all(pages.map(page => align(page, initial.arena.z)));
    await Promise.all([key(pages[0], 'ArrowRight', true), key(pages[1], 'ArrowLeft', true)]);
    await wait(pages[0], s => s.monster.status === 'engaged');
    await Promise.all([stop(pages[0], 'ArrowRight'), stop(pages[1], 'ArrowLeft')]);
    const pair = await Promise.all(pages.map(page => wait(page, s => s.monster.status === 'engaged')));
    const winner = pair.findIndex(view => view.battle);
    assert(winner >= 0);
    assert.equal(pair[1 - winner].battle, null);
    assert.equal(pair[0].monster.starts, 1);
    const other = pair[1 - winner];
    assert.equal((await send(server, 1 - winner, { epoch: other.epoch, seq: other.nextSeq, type: 'combat', battleId: pair[winner].battle.id, action: 'attack' })).status, 409);
    await fight(pages[winner], 'attack');
    const exploring = await state(pages[1 - winner]);
    await key(pages[1 - winner], 'ArrowUp', true);
    await ticks(pages[1 - winner], 4);
    await stop(pages[1 - winner], 'ArrowUp');
    assert((await state(pages[1 - winner])).players[exploring.self].z < exploring.players[exploring.self].z);
    const beforeBattle = await fight(pages[winner], 'dodge');
    assert(beforeBattle.battle.iframeRemainingMs > 0);
    const repeat = await send(server, winner, { epoch: beforeBattle.epoch, seq: beforeBattle.nextSeq - 1, type: 'combat', battleId: beforeBattle.battle.id, action: 'dodge' });
    assert.equal(repeat.status, 409);
    assert(beforeBattle.battle.hp > 0 && beforeBattle.battle.hp < 600);
    const savedBattle = await killAndRead(server, pages);
    assert(savedBattle.battle.clock.iframeUntil > savedBattle.simTick, 'crash occurred inside live dodge');
    server = await start();
    const bootView = await (await fetch(server.url + '/state', { headers: { Authorization: 'Bearer ' + tokens[winner] } })).json();
    assert.equal(bootView.battle.iframeUntilTick, savedBattle.battle.clock.iframeUntil);
    assert(bootView.battle.strikes >= savedBattle.battle.clock.strikes);
    pages = await connect(server);
    recovered = await state(pages[winner]);
    compareRecovery(savedBattle, recovered);
    assert.equal(recovered.battle.hp, beforeBattle.battle.hp);
    assert.equal(recovered.battle.iframeUntilTick, beforeBattle.battle.iframeUntilTick);
    await wait(pages[winner], s => s.battle.iframeRemainingMs === 0);
    if (entry === '/play3d' && process.env.GUJIAN2_SCREENSHOTS) {
      await pages[winner].screenshot({ path: join(process.env.GUJIAN2_SCREENSHOTS, 'battle-clock.png'), fullPage: true });
    }
    assert.equal((await send(server, winner, { epoch: beforeBattle.epoch, seq: beforeBattle.nextSeq, type: 'combat', battleId: beforeBattle.battle.id, action: 'heavy' })).status, 409);
    let last;
    for (let i = 0; i < 12 && (await state(pages[winner])).battle; i++) last = await fight(pages[winner], 'heavy');
    const final = await wait(pages[1 - winner], s => s.monster.status === 'defeated');
    assert.equal(final.monster.starts, 1);
    assert.equal(final.monster.settlements, 1);
    assert.equal((await send(server, winner, { epoch: last.epoch, seq: last.nextSeq - 1, type: 'combat', battleId: beforeBattle.battle.id, action: 'heavy' })).status, 409);
    const savedFinal = await killAndRead(server, pages);
    server = await start();
    const settled = await (await fetch(server.url + '/state', { headers: { Authorization: 'Bearer ' + tokens[winner] } })).json();
    compareRecovery(savedFinal, settled);
    assert.equal(settled.monster.settlements, 1);
    assert.equal(settled.battle, null);
    assert.deepEqual(pageErrors, []);
  } finally {
    try { await browser?.close(); }
    finally {
      for (const { child, closed } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closed;
      }
      await rm(dir, { recursive: true, force: true });
    }
  }
});
