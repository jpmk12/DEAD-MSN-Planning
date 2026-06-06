// Build step.
//
// This app is plain JavaScript (Node server + vanilla browser JS) — there is
// nothing to transpile or bundle. But some hosting pipelines expect `npm run
// build` to emit a build-output directory, so we stage the static frontend
// (public/) into dist/. The server still serves public/ at runtime via
// `npm start`; dist/ exists purely so platforms that look for a build artifact
// (or serve a static dir) find the same assets.
import { cp, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const src = fileURLToPath(new URL('public', root));
const out = fileURLToPath(new URL('dist', root));

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
// Stage everything except test files (they shouldn't ship to the browser/CDN).
await cp(src, out, { recursive: true, filter: (s) => !s.endsWith('.test.js') });
console.log('build: staged public/ -> dist/');
