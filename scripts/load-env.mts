/**
 * Minimal .env loader for standalone scripts.
 *
 * `next dev` / `next start` load `.env.local` themselves, but a plain tsx
 * script does not — which is why the collector previously had to be started
 * with an explicit `DATABASE_URL=…` prefix. This gives scripts the same view of
 * the environment as the app, so both always agree on which database is live.
 *
 * Precedence matches Next: a variable already present in the real environment
 * always wins, then `.env.local`, then `.env`.
 * No dependency on @next/env, which is not a top-level package here.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // Strip matching quotes; leave inner content untouched.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Load .env.local then .env from `dir`, without overriding real env vars. */
export function loadLocalEnv(dir: string): string[] {
  const loaded: string[] = [];
  for (const file of [".env.local", ".env"]) {
    const full = path.join(dir, file);
    if (!existsSync(full)) continue;
    let parsed: Record<string, string>;
    try {
      parsed = parseEnvFile(readFileSync(full, "utf8"));
    } catch {
      continue;
    }
    let applied = 0;
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) {
        process.env[k] = v;
        applied += 1;
      }
    }
    loaded.push(`${file} (${applied} var${applied === 1 ? "" : "s"})`);
  }
  return loaded;
}
