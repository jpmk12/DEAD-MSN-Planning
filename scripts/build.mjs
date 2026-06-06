// Build step.
//
// This app is plain JavaScript (Node server + vanilla browser JS) — nothing to
// transpile or bundle. But the hosting pipeline (Vite-oriented) expects the
// production build to emit a build-output directory, and tells us where via the
// DIST_DIR env var. So we stage the static frontend (public/) into BOTH ./dist
// (local/default) and $DIST_DIR (what the publish step inspects). The Node
// server still serves public/ at runtime via `npm start`. Never hard-fails — a
// staging error is logged but the build still exits 0.
import { cp, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const src = fileURLToPath(new URL('public', root));
const localDist = fileURLToPath(new URL('dist', root));

const targets = [localDist];
if (process.env.DIST_DIR && process.env.DIST_DIR !== localDist) targets.push(process.env.DIST_DIR);

for (const out of targets) {
  try {
    if (out === localDist) await rm(out, { recursive: true, force: true }); // only clean our own ./dist
    await mkdir(out, { recursive: true });
    await cp(src, out, { recursive: true, filter: (s) => !s.endsWith('.test.js') });
    console.log(`build: staged public/ -> ${out}`);
  } catch (e) {
    console.log(`build: could not stage to ${out}: ${e && e.message ? e.message : e}`);
  }
}
