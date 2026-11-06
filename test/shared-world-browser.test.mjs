import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { chromium } from 'playwright';

const tokens = ['alpha-test-secret-0000', 'beta-test-secret-00000'];

test('two browsers race for one encounter and finish it after a hard restart', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gujian2-shared-'));
  const serverPath = new URL('../bin/agent-gujian2-shared.mjs', import.meta.url);
  const children = [];
  let browser;
  async function start() {
    const assets = process.env.GUJIAN2_TEST_ASSETS;
    const child = spawn(process.execPath, [serverPath.pathname, '--port', '0', '--db', join(dir, 'world.sqlite'),
      ...(assets ? ['--assets', assets] : [])], {
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

  const state = page => page.locator('#world').getAttribute('data-view').then(JSON.parse);
  async function wait(page, fn) {
    await page.waitForFunction(fn, undefined, { timeout: 5000 });
    return state(page);
  }
  async function connect(server) {
    return Promise.all(tokens.map(async token => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(server.url);
      await page.locator('#token').fill(token);
      await page.locator('#join').click();
      await wait(page, () => document.querySelector('#world').dataset.view);
      return page;
    }));
  }
  async function command(page, name) {
    const [response] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/intent') && response.ok()),
      page.locator('#' + name).click(),
    ]);
    const committed = await response.json();
    await page.waitForFunction(revision => JSON.parse(document.querySelector('#world').dataset.view).revision >= revision, committed.revision);
  }
  async function authenticated(server, index, endpoint, body) {
    return fetch(server.url + endpoint, {
      headers: { Authorization: 'Bearer ' + tokens[index], 'Content-Type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
  }

  try {
    const server = await start();
    browser = await chromium.launch();
    const [a, b] = await connect(server);
    const initial = await state(a);
    assert.equal(await a.locator('[data-player="b"]').count(), 1);
    assert.equal(await b.locator('[data-player="a"]').count(), 1);
    const invalid = await authenticated(server, 0, '/intent', {
      epoch: initial.epoch, seq: initial.nextSeq, type: 'move', direction: ['east'],
    });
    assert.equal(invalid.status, 400);

    await command(a, 'north');
    const moved = await wait(b, () => JSON.parse(document.querySelector('#world').dataset.view).revision >= 1);
    assert.equal(moved.players.b.z, initial.players.b.z);
    assert.equal(moved.players.a.z, initial.players.a.z - 2);
    await command(a, 'south');

    await Promise.all([command(a, 'east'), command(b, 'west')]);
    const pair = await Promise.all([a, b].map(page => wait(page, () => JSON.parse(document.querySelector('#world').dataset.view).revision >= 4)));
    assert.equal(pair[0].monster.status, 'engaged');
    assert.equal(pair[0].monster.starts, 1);
    const winner = pair.findIndex(view => view.battle);
    assert(winner === 0 || winner === 1);
    assert.equal(pair[1 - winner].battle, null);
    await command([a, b][1 - winner], 'south');
    await command([a, b][winner], 'attack');
    const before = await state([a, b][winner]);
    assert(before.battle.hp < before.battle.maxHp && before.battle.hp > 0);

    server.child.kill('SIGKILL');
    assert.deepEqual(await server.closed, [null, 'SIGKILL']);
    await Promise.all([a, b].map(page => page.context().close()));

    const restarted = await start();
    const pages = await connect(restarted);
    assert.equal((await fetch(restarted.url + '/state')).status, 401);
    const recovered = await state(pages[winner]);
    assert.notEqual(recovered.epoch, before.epoch);
    for (const key of ['revision', 'players', 'monster', 'battle', 'nextSeq']) {
      assert.deepEqual(recovered[key], before[key], key);
    }

    const old = await authenticated(restarted, winner, '/intent', {
      epoch: before.epoch, seq: before.nextSeq, type: 'combat', action: 'attack', battleId: before.battle.id,
    });
    assert.equal(old.status, 409);

    const other = await state(pages[1 - winner]);
    const unauthorized = await authenticated(restarted, 1 - winner, '/intent', {
      epoch: other.epoch, seq: other.nextSeq, type: 'combat', action: 'attack', battleId: before.battle.id,
    });
    assert.equal(unauthorized.status, 409);

    let victoryIntent;
    for (let i = 0; i < 12; i++) {
      const active = await state(pages[winner]);
      if (!active.battle) break;
      victoryIntent = { epoch: active.epoch, seq: active.nextSeq, type: 'combat', action: 'heavy', battleId: active.battle.id };
      await command(pages[winner], 'heavy');
      await pages[winner].waitForFunction(revision => JSON.parse(document.querySelector('#world').dataset.view).revision > revision, active.revision);
    }
    const won = await wait(pages[1 - winner], () => JSON.parse(document.querySelector('#world').dataset.view).monster.status === 'defeated');
    assert.equal(won.monster.starts, 1);
    assert.equal(won.monster.settlements, 1);
    assert.equal((await authenticated(restarted, winner, '/intent', victoryIntent)).status, 409);
    const final = await (await authenticated(restarted, winner, '/state')).json();
    assert.equal(final.monster.settlements, 1);

    restarted.child.kill('SIGKILL');
    assert.deepEqual(await restarted.closed, [null, 'SIGKILL']);
    const afterVictory = await start();
    const settled = await (await authenticated(afterVictory, winner, '/state')).json();
    assert.deepEqual(settled.monster, final.monster);
    assert.equal(settled.battle, null);
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
