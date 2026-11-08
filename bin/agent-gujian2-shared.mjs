#!/usr/bin/env node
import { createHash, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { serveSharedFile } from '../src/shared-world-static.js';
import { loadSharedAssets, openSharedWorld, validateSharedIntent } from '../src/shared-world.js';

const { values } = parseArgs({ options: {
  port: { type: 'string', default: '8082' },
  db: { type: 'string' },
  render: { type: 'string' },
  assets: { type: 'string', default: fileURLToPath(new URL('../../Open-Gujian2/assets/', import.meta.url)) },
} });
const port = Number(values.port);
if (!values.db || !/^\d+$/.test(values.port) || !Number.isInteger(port) || port > 65535) {
  throw Error('usage: agent-gujian2-shared --db FILE [--port PORT] [--assets DIR]');
}
const tokens = [process.env.GUJIAN2_PLAYER_A_TOKEN, process.env.GUJIAN2_PLAYER_B_TOKEN];
if (tokens.some(token => typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) || tokens[0] === tokens[1]) {
  throw Error('configure two distinct player tokens (16–128 URL-safe characters)');
}
const hash = value => createHash('sha256').update(value).digest();
const proofs = tokens.map(hash);
const renderDirectory = values.render ?? resolve(values.assets, '../js');
const world = openSharedWorld({
  filename: values.db, assets: loadSharedAssets(values.assets),
  identityId: hash(Buffer.concat(proofs)).toString('hex'),
});

function reply(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function requestBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024) throw Object.assign(Error('intent too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks)); }
  catch { throw Object.assign(Error('invalid JSON'), { status: 400 }); }
}

const server = createServer(async (req, res) => {
  const authority = '127.0.0.1:' + server.address().port;
  if (req.headers.host !== authority || (req.headers.origin && req.headers.origin !== 'http://' + authority)) {
    return reply(res, 403, { error: 'origin refused' });
  }
  if (serveSharedFile(req, res, values.assets, renderDirectory)) return;
  const authorization = req.headers.authorization;
  const match = /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(authorization ?? '');
  const candidate = match && hash(match[1]);
  const index = candidate ? proofs.findIndex(proof => timingSafeEqual(proof, candidate)) : -1;
  if (index < 0) return reply(res, 401, { error: 'player token required' });
  const id = ['a', 'b'][index];
  try {
    if (req.method === 'GET' && req.url === '/terrain') return reply(res, 200, world.terrain());
    if (req.method === 'GET' && req.url === '/state') return reply(res, 200, world.read(id));
    if (req.method !== 'POST' || req.url !== '/intent') return reply(res, 404, { error: 'unknown endpoint' });
    if (req.headers['content-type'] !== 'application/json') return reply(res, 415, { error: 'JSON required' });
    const input = await requestBody(req);
    if (!validateSharedIntent(input)) return reply(res, 400, { error: 'invalid intent' });
    return reply(res, 200, world.submit(id, input));
  } catch (error) {
    if (error.status) return reply(res, error.status, { error: error.message });
    console.error(error.message);
    return reply(res, 503, { error: 'shared world unavailable' });
  }
});
server.on('error', error => { world.close(); console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port })));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => world.close()));
}
