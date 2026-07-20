#!/usr/bin/env node
/**
 * Pure-Node JSON → Postgres importer (no tsx). Runs inside production Docker.
 *
 * Env:
 *   DATABASE_URL=postgres://…          required
 *   LEGACY_DATA_DIR=/app/data/price-alerts
 *   LEGACY_DATA_DIRS=path1:path2
 *   AUTO_IMPORT_LEGACY=1               required to run (or --force)
 *
 * Never deletes source files. Idempotent (skips existing key hashes / alert ids).
 */
import { access, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const force = process.argv.includes("--force");
const dryRun = process.argv.includes("--dry-run");

function log(...a) {
  console.log("[legacy-data]", ...a);
}

function fail(msg) {
  console.error("[legacy-data] FATAL:", msg);
  process.exit(1);
}

async function exists(p) {
  try {
    await access(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p) {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

function collectRoots() {
  const roots = [];
  const single = process.env.LEGACY_DATA_DIR?.trim();
  if (single) roots.push(path.resolve(single));
  const multi = process.env.LEGACY_DATA_DIRS?.trim();
  if (multi) {
    for (const p of multi.split(/[:;,]/)) {
      if (p.trim()) roots.push(path.resolve(p.trim()));
    }
  }
  roots.push("/app/data/price-alerts");
  roots.push(path.join(ROOT, ".data"));
  roots.push(path.join(ROOT, ".data", "price-alerts"));
  roots.push(path.join(ROOT, "app", "data", "price-alerts"));
  return [...new Set(roots.map((r) => path.resolve(r)))];
}

async function findFile(roots, names) {
  for (const root of roots) {
    for (const name of names) {
      const full = path.isAbsolute(name) ? name : path.join(root, name);
      if (await exists(full)) return full;
    }
  }
  return null;
}

function toUuid(id) {
  if (
    typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  ) {
    return id.toLowerCase();
  }
  if (typeof id === "string" && /^[0-9a-f]{32}$/i.test(id)) {
    const h = id.toLowerCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return randomUUID();
}

function contentHash(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function main() {
  const enabled =
    force ||
    process.env.AUTO_IMPORT_LEGACY === "1" ||
    process.env.RUN_LEGACY_IMPORT === "1";
  if (!enabled) {
    log("skip (set AUTO_IMPORT_LEGACY=1 or pass --force)");
    return;
  }

  const url = (process.env.DATABASE_URL || "").trim();
  if (!url || url.startsWith("pglite")) {
    fail("DATABASE_URL must be a real postgres:// URL for production import");
  }

  const roots = collectRoots();
  log("roots:", roots.join(" | "));

  const sql = postgres(url, { max: 2, prepare: false, connect_timeout: 20 });
  const report = {
    startedAt: new Date().toISOString(),
    dryRun,
    files: {},
    counts: {},
    warnings: [],
    errors: []
  };

  try {
    await sql`SELECT 1`;
    log("db connected");

    // --- settings ---
    {
      const f = await findFile(roots, ["settings.json"]);
      report.files.settings = f;
      if (f) {
        const data = await readJson(f);
        if (data && !dryRun) {
          await sql`
            INSERT INTO app_settings (key, value, updated_by, updated_at)
            VALUES ('desk_settings', ${sql.json(data)}, 'legacy-import', now())
            ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
          `;
          report.counts.settings = 1;
          log("settings imported");
        } else if (data) {
          report.counts.settings = 1;
          log("settings (dry-run)");
        }
      } else {
        report.warnings.push("settings.json not found");
      }
    }

    // --- api keys ---
    {
      const f = await findFile(roots, [
        "tether-api-keys.json",
        process.env.TETHER_API_KEYS_DATA_FILE || ""
      ].filter(Boolean));
      report.files.apiKeys = f;
      if (f) {
        const data = await readJson(f);
        const keys = Array.isArray(data?.keys) ? data.keys : [];
        let imported = 0;
        let skipped = 0;
        for (const k of keys) {
          if (!k?.keyHash || !/^[0-9a-f]{64}$/i.test(k.keyHash)) {
            skipped += 1;
            continue;
          }
          const id = toUuid(k.id);
          if (dryRun) {
            imported += 1;
            continue;
          }
          const existing = await sql`
            SELECT id FROM api_keys WHERE key_hash = ${k.keyHash} LIMIT 1
          `;
          if (existing.length) {
            skipped += 1;
            continue;
          }
          await sql`
            INSERT INTO api_keys (
              id, name, key_prefix, key_suffix, key_hash,
              expires_at, revoked_at, last_used_at, created_by, created_at, updated_at
            ) VALUES (
              ${id}::uuid,
              ${String(k.name || "imported")},
              ${String(k.keyPrefix || "")},
              ${String(k.keySuffix || "")},
              ${String(k.keyHash)},
              ${k.expiresAt || null},
              ${k.revokedAt || null},
              ${k.lastUsedAt || null},
              ${k.createdBy || "legacy-import"},
              ${k.createdAt || new Date().toISOString()},
              ${new Date().toISOString()}
            )
            ON CONFLICT (id) DO NOTHING
          `;
          const scopes = Array.isArray(k.scopes)
            ? k.scopes
            : k.scope
              ? [k.scope]
              : ["tether:read"];
          for (const scope of scopes) {
            await sql`
              INSERT INTO api_key_scopes (api_key_id, scope)
              VALUES (${id}::uuid, ${String(scope)})
              ON CONFLICT DO NOTHING
            `;
          }
          imported += 1;
        }
        report.counts.api_keys = { imported, skipped, source: keys.length };
        log("api_keys imported", imported, "skipped", skipped);
      } else {
        report.warnings.push("tether-api-keys.json not found");
      }
    }

    // --- users ---
    {
      const f = await findFile(roots, [
        "desk-users.json",
        process.env.DESK_USERS_DATA_FILE || ""
      ].filter(Boolean));
      report.files.users = f;
      if (f) {
        const data = await readJson(f);
        const users = Array.isArray(data?.users) ? data.users : [];
        let imported = 0;
        for (const u of users) {
          if (!u?.usernameKey || !u?.passwordHash) continue;
          if (dryRun) {
            imported += 1;
            continue;
          }
          const id = toUuid(u.id);
          await sql`
            INSERT INTO users (
              id, username, username_key, password_hash, role, is_active,
              credential_version, source, created_at, updated_at, updated_by
            ) VALUES (
              ${id}::uuid,
              ${String(u.username)},
              ${String(u.usernameKey)},
              ${String(u.passwordHash)},
              ${String(u.role || "viewer")},
              ${u.enabled !== false},
              ${Number(u.sessionEpoch) || 0},
              'managed',
              ${u.createdAt || new Date().toISOString()},
              ${new Date().toISOString()},
              ${u.updatedBy || "legacy-import"}
            )
            ON CONFLICT (username_key) DO UPDATE SET
              password_hash = EXCLUDED.password_hash,
              role = EXCLUDED.role,
              is_active = EXCLUDED.is_active,
              credential_version = EXCLUDED.credential_version,
              updated_at = now()
          `;
          imported += 1;
        }
        report.counts.users = imported;
        log("users imported", imported);
      } else {
        report.warnings.push("desk-users.json not found (env admin/viewer ok)");
      }
    }

    // --- viewer auth ---
    {
      const f = await findFile(roots, [
        "viewer-auth.json",
        process.env.VIEWER_AUTH_DATA_FILE || ""
      ].filter(Boolean));
      report.files.viewerAuth = f;
      if (f) {
        const data = await readJson(f);
        if (data?.passwordHash && !dryRun) {
          await sql`
            INSERT INTO app_settings (key, value, updated_by, updated_at)
            VALUES (
              'viewer_auth_override',
              ${sql.json({
                passwordHash: data.passwordHash,
                sessionEpoch: data.sessionEpoch ?? 0,
                updatedAt: data.updatedAt ?? null,
                updatedBy: data.updatedBy ?? "legacy-import"
              })},
              'legacy-import',
              now()
            )
            ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = now()
          `;
          report.counts.viewer_auth = 1;
          log("viewer_auth imported");
        }
      } else {
        report.warnings.push("viewer-auth.json not found");
      }
    }

    // --- alerts ---
    {
      const f = await findFile(roots, [
        "price-alerts.json",
        process.env.PRICE_ALERTS_DATA_FILE || ""
      ].filter(Boolean));
      report.files.alerts = f;
      if (f) {
        const data = await readJson(f);
        const alerts = Array.isArray(data?.alerts) ? data.alerts : [];
        const notifications = Array.isArray(data?.notifications) ? data.notifications : [];
        let aImp = 0;
        let nImp = 0;
        if (!dryRun) {
          for (const a of alerts) {
            if (!a?.id) continue;
            await sql`
              INSERT INTO price_alerts (id, payload, created_at, updated_at)
              VALUES (
                ${String(a.id)},
                ${sql.json(a)},
                ${a.createdAt || new Date().toISOString()},
                ${new Date().toISOString()}
              )
              ON CONFLICT (id) DO UPDATE
              SET payload = EXCLUDED.payload, updated_at = now()
            `;
            aImp += 1;
          }
          for (const n of notifications) {
            if (!n?.id) continue;
            await sql`
              INSERT INTO alert_notifications (id, alert_id, payload, triggered_at, created_at)
              VALUES (
                ${String(n.id)},
                ${n.alertId ? String(n.alertId) : null},
                ${sql.json(n)},
                ${n.triggeredAt || null},
                ${new Date().toISOString()}
              )
              ON CONFLICT (id) DO UPDATE
              SET payload = EXCLUDED.payload
            `;
            nImp += 1;
          }
        } else {
          aImp = alerts.length;
          nImp = notifications.length;
        }
        report.counts.alerts = aImp;
        report.counts.notifications = nImp;
        log("alerts", aImp, "notifications", nImp);
      } else {
        report.warnings.push("price-alerts.json not found");
      }
    }

    // --- market snapshot ---
    {
      const f = await findFile(roots, [
        "market-snapshot.json",
        process.env.MARKET_SNAPSHOT_DATA_FILE || ""
      ].filter(Boolean));
      report.files.snapshot = f;
      if (f) {
        const data = await readJson(f);
        if (data?.tetherMarket) {
          const hash = contentHash({
            summary: data.tetherMarket.summary,
            exchanges: data.tetherMarket.exchanges,
            settingsKey: data.settingsKey
          });
          if (!dryRun) {
            const existing = await sql`
              SELECT id FROM market_snapshots
              WHERE market_type = 'tether' AND content_hash = ${hash}
              LIMIT 1
            `;
            if (!existing.length) {
              const id = randomUUID();
              const payload = {
                tetherMarket: data.tetherMarket,
                providers: data.providers ?? [],
                quotes: data.quotes ?? []
              };
              await sql`
                INSERT INTO market_snapshots (
                  id, market_type, generated_at, server_time, is_stale,
                  summary, payload, content_hash, settings_key, refresh_interval_ms,
                  last_successful_refresh_at, last_attempted_refresh_at, created_at
                ) VALUES (
                  ${id}::uuid,
                  'tether',
                  ${data.generatedAt || new Date().toISOString()},
                  ${new Date().toISOString()},
                  false,
                  ${sql.json(data.tetherMarket.summary || {})},
                  ${sql.json(payload)},
                  ${hash},
                  ${data.settingsKey || null},
                  ${data.refreshIntervalMs || 180000},
                  ${data.lastSuccessfulRefreshAt || null},
                  ${data.lastAttemptedRefreshAt || null},
                  now()
                )
              `;
              report.counts.snapshot = 1;
              log("market snapshot imported");
            } else {
              report.counts.snapshot = 0;
              log("market snapshot already present (hash match)");
            }
          } else {
            report.counts.snapshot = 1;
          }
        }
      } else {
        report.warnings.push("market-snapshot.json not found — first live refresh will create one");
      }
    }

    // --- median history ---
    {
      const f = await findFile(roots, ["median-history.json"]);
      report.files.median = f;
      if (f) {
        const data = await readJson(f);
        const samples = Array.isArray(data?.samples) ? data.samples : [];
        let n = 0;
        if (!dryRun) {
          for (const s of samples) {
            if (!Number.isFinite(s?.t) || !Number.isFinite(s?.v)) continue;
            await sql`
              INSERT INTO median_history_samples (id, sampled_at_ms, median_value)
              VALUES (${randomUUID()}::uuid, ${s.t}, ${String(s.v)})
              ON CONFLICT DO NOTHING
            `;
            n += 1;
          }
        } else n = samples.length;
        report.counts.median = n;
        log("median samples", n);
      }
    }

    // --- news ---
    {
      const f = await findFile(roots, ["impact-news-store.json"]);
      report.files.news = f;
      if (f) {
        const data = await readJson(f);
        const articles = data?.articles && typeof data.articles === "object" ? data.articles : {};
        let n = 0;
        if (!dryRun) {
          for (const [id, article] of Object.entries(articles)) {
            await sql`
              INSERT INTO news_items (id, payload, published_at, updated_at)
              VALUES (
                ${id},
                ${sql.json(article)},
                ${article?.publishedAt || null},
                now()
              )
              ON CONFLICT (id) DO NOTHING
            `;
            n += 1;
          }
          await sql`
            INSERT INTO app_settings (key, value, updated_by, updated_at)
            VALUES (
              'impact_news_store',
              ${sql.json({
                version: 1,
                updatedAt: data.updatedAt ?? null,
                providers: data.providers ?? {}
              })},
              'legacy-import',
              now()
            )
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
          `;
        } else n = Object.keys(articles).length;
        report.counts.news = n;
        log("news items", n);
      }
    }

    report.finishedAt = new Date().toISOString();
    report.ok = true;

    try {
      const outDir = path.join(ROOT, ".data");
      await mkdir(outDir, { recursive: true });
      const out = path.join(outDir, `legacy-import-report-${Date.now()}.json`);
      await writeFile(out, JSON.stringify(report, null, 2));
      log("report", out);
    } catch {
      log("report write skipped (read-only fs)");
    }

    log("DONE", JSON.stringify(report.counts));
  } catch (e) {
    report.errors.push(e instanceof Error ? e.message : String(e));
    console.error(e);
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main();
