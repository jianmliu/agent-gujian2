import { createReadStream, realpathSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const pages = {
  '/': ['shared-world.html', 'text/html; charset=utf-8'],
  '/play3d': ['shared-world-3d.html', 'text/html; charset=utf-8'],
  '/shared-world-client.js': ['shared-world-client.js', 'text/javascript; charset=utf-8'],
  '/shared-world-3d.js': ['shared-world-3d.js', 'text/javascript; charset=utf-8'],
};
const modules = new Set(['three.module.js', 'assets.js', 'entities.js']);
const mime = { '.json': 'application/json', '.bin': 'application/octet-stream', '.png': 'image/png' };

export function serveSharedFile(req, res, assets, renderDirectory) {
  if (req.method !== 'GET') return false;
  let file, type;
  const page = pages[req.url];
  if (page) {
    file = fileURLToPath(new URL('../web/' + page[0], import.meta.url));
    type = page[1];
  } else if (req.url.startsWith('/render/') && modules.has(req.url.slice(8))) {
    file = resolve(renderDirectory, req.url.slice(8));
    type = 'text/javascript; charset=utf-8';
  } else if (/^\/assets\/(chars|props)\/[A-Za-z0-9_./-]+$/.test(req.url) ||
             req.url === '/assets/world.colormap.png') {
    try {
      if (req.url.split('/').some(part => part === '.' || part === '..')) return false;
      const root = realpathSync(assets);
      file = realpathSync(resolve(root, req.url.slice(8)));
      if (!file.startsWith(root + sep) || !statSync(file).isFile()) return false;
      type = mime[extname(file)];
      if (!type) return false;
    } catch { return false; }
  } else return false;
  const stream = createReadStream(file);
  stream.on('open', () => {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    stream.pipe(res);
  });
  stream.on('error', () => {
    if (res.headersSent) res.destroy();
    else { res.writeHead(404); res.end('Visual asset unavailable'); }
  });
  return true;
}
