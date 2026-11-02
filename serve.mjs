// Zero-dependency static server for local jamming.
// Serves the project root (so ../Stems WAV fallbacks resolve) and opens at /webapp/.
// Usage:  node webapp/serve.mjs [port]
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, normalize, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8137);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') { res.writeHead(302, { Location: '/webapp/' }); return res.end(); }
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  let st;
  try { st = statSync(file); } catch { res.writeHead(404); return res.end('not found'); }
  if (st.isDirectory()) { res.writeHead(302, { Location: path + '/' }); return res.end(); }
  const audio = /\.(ogg|wav)$/i.test(file);
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': audio ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`Dream Chamber Remixed → http://localhost:${PORT}/webapp/`));
