// Builds dist/ (the static site + Ogg stems) and uploads it to Cloudflare
// (Workers static assets, configured in wrangler.jsonc).
// The stems never go through git — they're uploaded straight from this machine.
// Usage:  npm run deploy            (production → dreamchamberremixed.xyz)
//         npm run deploy -- preview (upload a version with a preview URL; live site untouched)
//         npm run deploy -- --config <file> (another Cloudflare account or domain)
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const SITE = ['index.html', 'style.css', 'solid.css', 'manifest.webmanifest', 'icons', 'stems.json', '_headers', 'js', 'stems-ogg'];
const OPTIONAL = ['covers']; // album covers, if you've built them (npm run covers)

for (const f of SITE) {
  if (!existsSync(join(ROOT, f))) {
    console.error(`Missing ${f}.` + (f.startsWith('stems') ? ' Run `npm run stems` first.' : ''));
    process.exit(1);
  }
}
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST);
for (const f of SITE) cpSync(join(ROOT, f), join(DIST, f), { recursive: true });
for (const f of OPTIONAL) if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(DIST, f), { recursive: true });

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const preview = process.argv.includes('preview');
console.log(`${preview ? 'Uploading preview of' : 'Deploying'} v${version} to Cloudflare…`);
const args = preview ? ['versions', 'upload'] : ['deploy'];
// Another account or domain: npm run deploy -- --config my-wrangler.jsonc
const cfg = process.argv.indexOf('--config');
if (cfg > 0 && process.argv[cfg + 1]) args.push('--config', `"${process.argv[cfg + 1]}"`);
const r = spawnSync('npx', ['wrangler', ...args, '--message', `"v${version}"`], { cwd: ROOT, stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
