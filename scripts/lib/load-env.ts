// ============================================================
// SONAR v2.0 — Script Environment Loader
// ============================================================
// Reads .env.local from the project root and injects values
// into process.env. Called at the top of every standalone
// script so they can run without inline env var prefixes.
//
// Rules:
//   - Never prints key values to stdout/stderr.
//   - Does not override env vars already set by the shell.
//   - Handles quoted values and escaped newlines (\n → LF).
//   - Silently skips missing .env.local (CI / Vercel supply
//     vars natively; this loader is for local dev runs only).
// ============================================================

import { existsSync, readFileSync } from 'fs';
import { resolve }                  from 'path';

export function loadEnv(relPath = '.env.local'): void {
  const envPath = resolve(process.cwd(), relPath);
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, 'utf8').split('\n');

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    let   val = line.slice(eqIdx + 1).trim();

    // Strip surrounding double or single quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }

    // Expand escaped newlines (multi-line PEM keys, etc.)
    val = val.replace(/\\n/g, '\n');

    // Never override env vars already set (shell or CI takes precedence)
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}
