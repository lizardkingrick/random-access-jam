// Bundles the parts of Three.js the stage uses into js/vendor/three.min.js (one file, no build step
// for the site). Run after changing the imports at the top of js/stage-pyramid.js.
// Usage:  npm install --no-save three@0.187.0 && node tools/build-three.mjs
import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(ROOT, 'js/stage-pyramid.js'), 'utf8');
const names = src.match(/import \{([\s\S]*?)\} from '\.\/vendor\/three\.min\.js'/)[1];
buildSync({
  stdin: { contents: `export {${names}} from 'three';`, resolveDir: ROOT },
  bundle: true, minify: true, format: 'esm', target: 'es2020', legalComments: 'none',
  banner: { js: '// Three.js (MIT, see LICENSE in this folder), trimmed by tools/build-three.mjs' },
  outfile: resolve(ROOT, 'js/vendor/three.min.js'),
});
