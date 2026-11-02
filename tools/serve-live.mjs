// Local server for working on the app without the stems on this machine: serves this folder and
// streams the stems and covers from the live site. Nothing is saved to disk.
// Usage:  node tools/serve-live.mjs [port]
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, normalize, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8138);
const LIVE = 'https://hiddenalchemist.com';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (/^\/(stems-ogg|covers)\//.test(path)) {
    const up = await fetch(LIVE + req.url).catch(() => null);
    if (!up || !up.ok) { res.writeHead(up ? up.status : 502); return res.end(); }
    const headers = { 'Content-Type': up.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' };
    if (up.headers.get('content-length')) headers['Content-Length'] = up.headers.get('content-length'); // compressed responses have none
    res.writeHead(200, headers);
    for await (const chunk of up.body) res.write(chunk);
    return res.end();
  }
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  let st;
  try { st = statSync(file); } catch { res.writeHead(404); return res.end('not found'); }
  if (st.isDirectory()) { res.writeHead(302, { Location: path + '/' }); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`Dream Chamber Remixed (live stems) → http://localhost:${PORT}/`));
