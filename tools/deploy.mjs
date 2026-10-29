// Builds dist/ (the static site + Ogg stems) and uploads it to Cloudflare Pages.
// The stems never go through git — they're uploaded straight from this machine.
// Usage:  npm run deploy            (production → hiddenalchemist.com)
//         npm run deploy -- preview (a throwaway preview URL instead)
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PROJECT = 'random-access-jam';
const SITE = ['index.html', 'style.css', 'stems.json', '_headers', 'js', 'stems-ogg'];

for (const f of SITE) {
  if (!existsSync(join(ROOT, f))) {
    console.error(`Missing ${f}.` + (f.startsWith('stems') ? ' Run `npm run stems` first.' : ''));
    process.exit(1);
  }
}
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST);
for (const f of SITE) cpSync(join(ROOT, f), join(DIST, f), { recursive: true });

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const branch = process.argv.includes('preview') ? 'preview' : 'main';
console.log(`Deploying v${version} to Cloudflare Pages (${PROJECT}, branch ${branch})…`);
const r = spawnSync('npx', ['wrangler', 'pages', 'deploy', 'dist', '--project-name', PROJECT, '--branch', branch,
  '--commit-message', `v${version}`, '--commit-dirty=true'], { cwd: ROOT, stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
