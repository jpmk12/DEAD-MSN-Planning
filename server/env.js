// Tiny zero-dependency .env loader. Reads KEY=VALUE lines from a .env file at
// the repo root (if present) into process.env, without overriding values that
// are already set by the host environment. Keeps secrets (FAA NOTAM creds) out
// of the codebase while needing no npm packages.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function loadEnv() {
  const path = fileURLToPath(new URL('../.env', import.meta.url));
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return; // no .env — rely on the host's environment
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}
