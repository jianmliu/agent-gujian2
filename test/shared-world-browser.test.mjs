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

for (const entry of ['/', '/play3d']) for (const mode of ['parallel', 'cooperative', 'lifecycle']) test(entry + ' ' + mode + ' encounters survive disconnect and process deaths', { timeout: mode === 'lifecycle' ? 180_000 : 120_000 }, async () => {
  const cooperative = mode !== 'parallel';
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
    }, { source: predicate.toString(), value }, { timeout: 8000 }).catch(async error => {
      error.message += '\nWait predicate ' + predicate.toString() + ' target ' + JSON.stringify(value) + '\nLast view ' + JSON.stringify(await state(page));
      throw error;
    });
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
  async function connect(server, together = true) {
    return Promise.all(tokens.map((_, index) => connectPlayer(server, index, together)));
  }
  async function connectPlayer(server, index, together = true) {
    const token = tokens[index];
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
        assert.equal(rendered.monsters.length, 2);
        assert(rendered.drawCalls > 0 && rendered.actors.every(actor => actor.skinned), JSON.stringify(rendered));
        assert(rendered.actors.find(actor => actor.id === (token === tokens[0] ? 'a' : 'b')).visible, JSON.stringify(rendered));
        if (together) assert(rendered.actors.every(actor => actor.visible), JSON.stringify(rendered));
      }
      return page;
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
    for (const [id, monster] of Object.entries(saved.monsters)) {
      assert.equal(view.monsters[id].status, monster.status);
      assert.equal(view.monsters[id].starts, monster.starts);
      assert.equal(view.monsters[id].settlements, monster.settlements);
    }
  }
  function compareClock(saved, view) {
    const c = saved.battles[view.battle.id].clock;
    let { phase, phaseUntil, strikes } = c;
    for (let tick = saved.simTick + 1; tick <= view.simTick; tick++) {
      if (tick >= phaseUntil) {
        if (phase === 'warning') { strikes++; phase = 'recovery'; phaseUntil = tick + 20; }
        else { phase = 'warning'; phaseUntil = tick + 30; }
      }
    }
    assert.equal(view.battle.strikes, strikes);
    assert.equal(view.battle.phase, phase);
    assert.equal(view.battle.phaseUntilTick, phaseUntil);
    assert.equal(view.battle.iframeUntilTick, saved.battles[view.battle.id].participants[view.self].clock.iframeUntil);
  }
  async function send(server, index, body) {
    return fetch(server.url + '/intent', {
      method: 'POST', headers: { Authorization: 'Bearer ' + tokens[index], 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  }
  async function fight(page, action, onAccepted = () => {}) {
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/intent') && r.ok() && r.request().postDataJSON().type === 'combat'),
      page.locator('#' + action).click(),
    ]);
    const view = await response.json();
    onAccepted(view);
    await wait(page, (s, seq) => s.nextSeq >= seq, view.nextSeq);
    return view;
  }
  async function authority(server, self) {
    return (await fetch(server.url + '/state', { headers: { Authorization: 'Bearer ' + tokens[self === 'a' ? 0 : 1] } })).json();
  }
  async function waitAuthority(server, self, predicate, timeout = 8000) {
    const deadline = performance.now() + timeout;
    let view;
    do {
      view = await authority(server, self);
      if (predicate(view)) return view;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (performance.now() < deadline);
    assert.fail('authoritative navigation timeout: ' + JSON.stringify(view));
  }
  async function align(page, z, server) {
    const self = (await state(page)).self;
    for (let attempt = 0; attempt < 8; attempt++) {
      const view = await authority(server, self);
      if (view.battle || Math.abs(view.players[self].z - z) < 0.6) return;
      const sign = view.players[self].z < z ? 1 : -1;
      const keyName = sign > 0 ? 'ArrowDown' : 'ArrowUp';
      await key(page, keyName, true);
      // Observe the server directly so display polling and long frames cannot delay key release.
      await waitAuthority(server, self, s => !!s.battle || (s.players[self].z - z) * sign >= -0.4);
      await stop(page, keyName);
    }
    const final = await authority(server, self);
    assert(final.battle || Math.abs(final.players[self].z - z) < 0.6, 'bounded alignment: ' + JSON.stringify(final));
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

    if (mode === 'lifecycle') {
      async function startPair(delayedJoin) {
        await key(pages[0], 'ArrowRight', true);
        await waitAuthority(server, 'a', s => !!s.battle);
        await stop(pages[0], 'ArrowRight');
        const created = await authority(server, 'a');
        if (delayedJoin) await waitAuthority(server, 'a', s => s.battle.strikes > 0);
        for (let attempt = 0; !(await authority(server, 'b')).joinOffers.length && attempt < 4; attempt++) {
          const v = await authority(server, 'b');
          const direction = v.players.b.x > v.arena.x ? 'ArrowLeft' : 'ArrowRight';
          await key(pages[1], direction, true);
          await waitAuthority(server, 'b', s => s.joinOffers.length > 0);
          await stop(pages[1], direction);
        }
        await wait(pages[1], s => s.joinOffers.length > 0);
        const [response] = await Promise.all([
          pages[1].waitForResponse(r => r.url().endsWith('/intent') && r.ok() && r.request().postDataJSON().type === 'joinBattle'),
          pages[1].locator('#join-battle-trial-1').click(),
        ]);
        assert.equal((await response.json()).battle.id, created.battle.id);
        await wait(pages[1], s => !!s.battle);
        return created.battle.id;
      }
      const firstId = await startPair(true);
      const fallen = await waitAuthority(server, 'a', s => s.life.status === 'downed', 25000);
      assert((await authority(server, 'b')).battle);
      assert.equal((await authority(server, 'b')).life.status, 'alive');
      const continued = await fight(pages[1], 'attack');
      assert.equal(continued.battle.id, firstId);
      await wait(pages[0], s => s.life.status === 'downed');
      assert.equal(await pages[0].locator('#attack').isDisabled(), true);
      await waitAuthority(server, 'b', s => s.life.status === 'downed', 12000);
      await wait(pages[1], s => s.life.status === 'downed');
      const lost = await authority(server, 'a');
      assert.equal(lost.battle, null);
      assert.equal(lost.monsters['trial-1'].lastResult.outcome, 'defeat');
      for (const page of pages) {
        await page.locator('#revive').click();
        await wait(page, s => s.life.status === 'alive');
      }
      const revived = await authority(server, 'a');
      assert.equal(revived.players.a.x, revived.arena.x - 4);
      assert.equal(revived.players.b.x, revived.arena.x + 4);
      await waitAuthority(server, 'a', s => s.monsters['trial-1'].status === 'available', 12000);
      const secondId = await startPair(false);
      assert.notEqual(secondId, firstId);
      let current = await authority(server, 'a');
      assert.equal((await send(server, 0, { epoch: current.epoch, seq: current.nextSeq, type: 'combat', battleId: firstId, action: 'heavy' })).status, 409);
      for (let i = 0; i < 10 && (await authority(server, 'a')).battle; i++) await fight(pages[i % 2], 'heavy');
      await wait(pages[0], s => !s.battle);
      await wait(pages[1], s => !s.battle);
      const won = await authority(server, 'a');
      assert.equal(won.monsters['trial-1'].lastResult.outcome, 'victory');
      assert.equal(won.monsters['trial-1'].settlements, 2);
      assert.deepEqual(won.monsters['trial-1'].victors, ['a', 'b']);
      if (process.env.GUJIAN2_SCREENSHOTS) await pages[0].screenshot({ path: join(process.env.GUJIAN2_SCREENSHOTS, entry === '/play3d' ? 'lifecycle-3d.png' : 'lifecycle-map.png'), fullPage: true });
      const port = Number(new URL(server.url).port);
      const saved = await killAndRead(server, pages, false);
      server = await start(port);
      const boot = await authority(server, 'a');
      assert.equal(boot.monsters['trial-1'].respawnRemainingMs, (saved.monsters['trial-1'].respawnAt - boot.simTick) * 50);
      assert.equal(boot.monsters['trial-1'].refreshes, 1);
      await Promise.all(pages.map(page => wait(page, (s, epoch) => s.epoch !== epoch, won.epoch)));
      await waitAuthority(server, 'a', s => s.monsters['trial-1'].status === 'available', 12000);
      await ticks(pages[0], 4);
      const refreshed = await authority(server, 'a');
      assert.equal(refreshed.monsters['trial-1'].generation, 3);
      assert.equal(refreshed.monsters['trial-1'].refreshes, 2);
      assert.equal(refreshed.monsters['trial-1'].settlements, 2);
      await key(pages[0], 'ArrowRight', true);
      await waitAuthority(server, 'a', s => !!s.battle);
      await stop(pages[0], 'ArrowRight');
      current = await authority(server, 'a');
      assert.equal(current.battle.generation, 3);
      assert.notEqual(current.battle.id, secondId);
      assert.equal((await send(server, 0, { epoch: current.epoch, seq: current.nextSeq, type: 'combat', battleId: secondId, action: 'heavy' })).status, 409);
      assert.equal((await send(server, 0, { epoch: current.epoch, seq: current.nextSeq, type: 'revive', downId: fallen.life.downId })).status, 409);
      assert.deepEqual(pageErrors, []);
      return;
    }

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

    for (const page of pages) await align(page, initial.arena.z, server);
    await Promise.all([key(pages[0], 'ArrowRight', true), key(pages[1], 'ArrowLeft', true)]);
    await wait(pages[0], s => s.monsters['trial-1'].status === 'engaged');
    await Promise.all([stop(pages[0], 'ArrowRight'), stop(pages[1], 'ArrowLeft')]);
    const pair = await Promise.all(pages.map(page => wait(page, s => s.monsters['trial-1'].status === 'engaged')));
    const winner = pair.findIndex(view => view.battle);
    assert(winner >= 0);
    assert.equal(pair[1 - winner].battle, null);
    assert.equal(pair[0].monsters['trial-1'].starts, 1);
    const other = pair[1 - winner];
    assert.equal((await send(server, 1 - winner, { epoch: other.epoch, seq: other.nextSeq, type: 'combat', battleId: pair[winner].battle.id, action: 'attack' })).status, 409);
    await fight(pages[winner], 'attack');
    const exploring = await state(pages[1 - winner]);
    await key(pages[1 - winner], 'ArrowUp', true);
    await ticks(pages[1 - winner], 4);
    await stop(pages[1 - winner], 'ArrowUp');
    assert((await state(pages[1 - winner])).players[exploring.self].z < exploring.players[exploring.self].z);
    if (cooperative) {
      await align(pages[1 - winner], initial.arena.z, server);
      const joinEvidence = [];
      pages[1 - winner].on('response', response => {
        if (response.url().endsWith('/intent')) joinEvidence.push({ status: response.status(), input: response.request().postDataJSON() });
      });
      // The loser of the contact race may have stopped just outside the two-metre join radius.
      // Approach the occupied monster through real movement until the server offers joining.
      for (let attempt = 0; !(await state(pages[1 - winner])).joinOffers.length && attempt < 4; attempt++) {
        const nearby = await state(pages[1 - winner]), position = nearby.players[nearby.self];
        const monster = nearby.monsters['trial-1'];
        const dx = monster.x - position.x, dz = monster.z - position.z;
        console.log('approach join radius', JSON.stringify({ entry, position, monster, distance: Math.hypot(dx, dz) }));
        const approach = Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 'ArrowRight' : 'ArrowLeft') : (dz > 0 ? 'ArrowDown' : 'ArrowUp');
        await key(pages[1 - winner], approach, true);
        const axis = Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z';
        const sign = monster[axis] > position[axis] ? 1 : -1;
        await waitAuthority(server, nearby.self, s => s.joinOffers.length > 0 ||
          (s.players[s.self][axis] - monster[axis]) * sign >= 0);
        await stop(pages[1 - winner], approach);
      }
      await wait(pages[1 - winner], s => s.joinOffers.some(offer => offer.monsterId === 'trial-1'));
      const joinButton = pages[1 - winner].locator('#join-battle-trial-1');
      await joinButton.focus();
      await ticks(pages[1 - winner], 6);
      assert(await joinButton.evaluate(button => button === document.activeElement), 'join target retains keyboard focus across snapshots');
      const [response] = await Promise.all([
        pages[1 - winner].waitForResponse(r => r.url().endsWith('/intent') && r.ok() && r.request().postDataJSON().type === 'joinBattle'),
        joinButton.click({ delay: 250 }),
      ]).catch(async error => {
        error.message += '\nJoin evidence ' + JSON.stringify(joinEvidence) + '\nLast view ' + JSON.stringify(await state(pages[1 - winner])) + '\nNotice ' + await pages[1 - winner].locator('#notice').textContent();
        throw error;
      });
      const joined = await response.json();
      assert.equal(joined.battle.id, pair[winner].battle.id);
      assert.deepEqual(joined.battle.participants, ['a', 'b']);
      await wait(pages[1 - winner], s => !!s.battle);
    } else {
      const second = exploring.monsters['trial-2'];
      await align(pages[1 - winner], second.z, server);
      if (!(await state(pages[1 - winner])).battle) {
        const secondPosition = (await state(pages[1 - winner])).players[exploring.self];
        const approach = secondPosition.x < second.x ? 'ArrowRight' : 'ArrowLeft';
        await key(pages[1 - winner], approach, true);
        await wait(pages[1 - winner], s => s.battle?.monsterId === 'trial-2');
        await stop(pages[1 - winner], approach);
      }
      assert.equal((await state(pages[1 - winner])).battle.monsterId, 'trial-2');
    }
    const secondBattle = await fight(pages[1 - winner], 'attack');
    const firstBattle = await state(pages[winner]);
    if (cooperative) assert.equal(firstBattle.battle.id, secondBattle.battle.id);
    else assert.notEqual(firstBattle.battle.id, secondBattle.battle.id);
    for (const [index, wrong] of (cooperative ? [] : [[winner, secondBattle], [1 - winner, firstBattle]])) {
      const own = await state(pages[index]);
      assert.equal((await send(server, index, { epoch: own.epoch, seq: own.nextSeq, type: 'combat', battleId: wrong.battle.id, action: 'heavy' })).status, 409);
    }
    const repeat = await send(server, 1 - winner, { epoch: secondBattle.epoch, seq: secondBattle.nextSeq - 1, type: 'combat', battleId: secondBattle.battle.id, action: 'attack' });
    assert.equal(repeat.status, 409);
    if (cooperative) {
      const disconnected = await state(pages[winner]);
      await pages[1 - winner].context().close();
      const continued = await ticks(pages[winner], 8);
      assert.deepEqual(continued.battle.participants, ['a', 'b']);
      assert(continued.simTick > disconnected.simTick);
      const disconnectedSnapshot = await (await fetch(server.url + '/state', { headers: { Authorization: 'Bearer ' + tokens[1 - winner] } })).json();
      pages[1 - winner] = await connectPlayer(server, 1 - winner);
      const rejoined = await state(pages[1 - winner]);
      assert.equal(rejoined.battle.id, firstBattle.battle.id);
      assert.deepEqual(rejoined.battle.participants, ['a', 'b']);
      assert.equal(rejoined.nextSeq, disconnectedSnapshot.nextSeq);
      assert(rejoined.nextSeq >= secondBattle.nextSeq && rejoined.nextSeq <= secondBattle.nextSeq + 1);
    }
    // Crash on the accepted response, before a busy 3D frame can delay the DOM acknowledgement.
    const beforeBattle = await fight(pages[winner], 'dodge', () => server.child.kill('SIGKILL'));
    assert(beforeBattle.battle.iframeRemainingMs > 0);
    assert(beforeBattle.battle.hp > 0 && beforeBattle.battle.hp < 600);
    const savedBattle = await killAndRead(server, pages);
    assert.equal(Object.keys(savedBattle.battles).length, cooperative ? 1 : 2);
    assert(savedBattle.battles[beforeBattle.battle.id].participants[beforeBattle.self].clock.iframeUntil > savedBattle.simTick, 'crash occurred inside live dodge: ' + JSON.stringify({ savedTick: savedBattle.simTick, iframeUntil: savedBattle.battles[beforeBattle.battle.id].participants[beforeBattle.self].clock.iframeUntil }));
    server = await start();
    const bootView = await (await fetch(server.url + '/state', { headers: { Authorization: 'Bearer ' + tokens[winner] } })).json();
    assert.equal(bootView.battle.iframeUntilTick, savedBattle.battles[beforeBattle.battle.id].participants[beforeBattle.self].clock.iframeUntil);
    assert(bootView.battle.strikes >= savedBattle.battles[beforeBattle.battle.id].clock.strikes);
    const otherBoot = await (await fetch(server.url + '/state', { headers: { Authorization: 'Bearer ' + tokens[1 - winner] } })).json();
    assert.equal(otherBoot.battle.id, secondBattle.battle.id);
    assert.equal(otherBoot.battle.hp, secondBattle.battle.hp);
    for (const view of [bootView, otherBoot]) compareClock(savedBattle, view);
    // Independent encounters are twelve metres apart; the follow camera need only frame self.
    // Initial join above still proves both nearby characters are actually visible.
    pages = await connect(server, false);
    recovered = await state(pages[winner]);
    const recoveredOther = await state(pages[1 - winner]);
    compareClock(savedBattle, recovered); compareClock(savedBattle, recoveredOther);
    assert.equal(recoveredOther.battle.id, secondBattle.battle.id);
    compareRecovery(savedBattle, recovered);
    assert.equal(recovered.battle.hp, beforeBattle.battle.hp);
    assert.equal(recovered.battle.iframeUntilTick, beforeBattle.battle.iframeUntilTick);
    await wait(pages[winner], s => s.battle.iframeRemainingMs === 0);
    if (entry === '/play3d' && process.env.GUJIAN2_SCREENSHOTS) {
      await Promise.all(pages.map((page, index) => page.screenshot({ path: join(process.env.GUJIAN2_SCREENSHOTS, (cooperative ? 'cooperative-' : 'parallel-') + index + '.png'), fullPage: true })));
    }
    assert.equal((await send(server, winner, { epoch: beforeBattle.epoch, seq: beforeBattle.nextSeq, type: 'combat', battleId: beforeBattle.battle.id, action: 'heavy' })).status, 409);
    let last;
    for (let i = 0; i < 12 && (await state(pages[winner])).battle; i++) last = await fight(pages[winner], 'heavy');
    const final = await wait(pages[1 - winner], s => s.monsters['trial-1'].status === 'defeated');
    assert.equal(final.monsters['trial-1'].starts, 1);
    assert.equal(final.monsters['trial-1'].settlements, 1);
    assert.equal((await send(server, winner, { epoch: last.epoch, seq: last.nextSeq - 1, type: 'combat', battleId: beforeBattle.battle.id, action: 'heavy' })).status, 409);
    if (cooperative) {
      assert.equal((await state(pages[1 - winner])).battle, null);
      assert.deepEqual(final.monsters['trial-1'].victors, ['a', 'b']);
    } else assert((await state(pages[1 - winner])).battle, 'second encounter remains pending after first settlement');
    const free = await state(pages[winner]);
    await key(pages[winner], 'ArrowUp', true);
    await ticks(pages[winner], 4);
    await stop(pages[winner], 'ArrowUp');
    assert((await state(pages[winner])).players[free.self].z < free.players[free.self].z);
    if (!cooperative) {
      for (let i = 0; i < 12 && (await state(pages[1 - winner])).battle; i++) await fight(pages[1 - winner], 'heavy');
      const bothFinal = await wait(pages[winner], s => Object.values(s.monsters).every(m => m.status === 'defeated'));
      assert(Object.values(bothFinal.monsters).every(m => m.starts === 1 && m.settlements === 1));
    } else {
      assert.equal((await state(pages[winner])).monsters['trial-2'].starts, 0);
    }
    if (entry === '/play3d') {
      await pages[winner].waitForFunction(coop => JSON.parse(document.querySelector('#scene3d').dataset.render).monsters.every(m =>
        m.visible === (coop && m.id === 'trial-2')), cooperative);
    }
    const savedFinal = await killAndRead(server, pages);
    server = await start();
    const settled = await (await fetch(server.url + '/state', { headers: { Authorization: 'Bearer ' + tokens[winner] } })).json();
    compareRecovery(savedFinal, settled);
    assert.equal(settled.monsters['trial-1'].settlements, 1);
    assert.equal(settled.battle, null);
    assert.equal(settled.monsters['trial-2'].settlements, cooperative ? 0 : 1);
    const otherSettled = await (await fetch(server.url + '/state', { headers: { Authorization: 'Bearer ' + tokens[1 - winner] } })).json();
    assert.equal(otherSettled.battle, null);
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
