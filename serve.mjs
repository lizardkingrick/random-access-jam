// Zero-dependency static server for local development only: it listens on this computer
// (127.0.0.1) and serves the project's parent folder, so never put it behind a proxy. To
// publish the site, use tools/serve.ps1 -Public (or the hosted build).
// Serves the project root (so ../Stems WAV fallbacks resolve) and opens at /webapp/.
// Usage:  node webapp/serve.mjs [port]
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, normalize, extname, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8137);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8',
};

// Answer only names for this computer, so a web page can't reach the server by pointing its own
// domain at 127.0.0.1 (DNS rebinding).
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

createServer((req, res) => {
  if (!LOCAL_HOST.test(req.headers.host || '')) { res.writeHead(403); return res.end(); }
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  if (path === '/') { res.writeHead(302, { Location: '/webapp/' }); return res.end(); }
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(ROOT, path));
  const rel = relative(ROOT, file);
  // No dot files or folders, also not by their Windows aliases: 8.3 short names (GIT~1 is .git),
  // alternate data streams (':') and names Windows trims (a trailing '.' or space).
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split(/[\\/]/).some((s) => /^\.|[~:]|[. ]$/.test(s))) { res.writeHead(403); return res.end(); }
  let st;
  try { st = statSync(file); } catch { res.writeHead(404); return res.end('not found'); }
  if (st.isDirectory()) { res.writeHead(302, { Location: path + '/' }); return res.end(); }
  const audio = /\.(ogg|wav)$/i.test(file);
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': audio ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`Dream Chamber Remixed → http://localhost:${PORT}/webapp/`));
