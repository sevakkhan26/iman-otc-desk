/**
 * Idempotent importer: JSON/file durable state → PostgreSQL.
 *
 * Usage:
 *   DATABASE_URL=postgres://… pnpm exec tsx scripts/import-legacy-to-postgres.mts
 *   DATABASE_URL=postgres://… pnpm exec tsx scripts/import-legacy-to-postgres.mts --dry-run
 *   LEGACY_DATA_DIR=/app/data/price-alerts DATABASE_URL=… pnpm exec tsx scripts/import-legacy-to-postgres.mts
 *
 * Searches multiple roots (production Docker volume + local .data). Never deletes sources.
 * Safe to run twice.
 */
import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { closeDb, getDatabaseUrl, getDbAsync, isPgliteUrl, pingDatabase } from "../src/db/client.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { pgImportApiKeyStoreFile, pgListApiKeyRecords } from "../src/db/repositories/apiKeys.ts";
import {
  pgWriteTetherSnapshot,
  pgReadLatestTetherSnapshot
} from "../src/db/repositories/marketSnapshots.ts";
import { pgGetSettingsJson, pgSaveSettingsJson } from "../src/db/repositories/settings.ts";
import { pgLoadAlertsBundle, pgSaveAlertsBundle } from "../src/db/repositories/alerts.ts";
import { pgListUsers, pgUpsertUser } from "../src/db/repositories/users.ts";
import { __importViewerAuthOverride } from "../src/lib/viewerAuthStore.ts";
import { medianHistorySamples, newsItems, appSettings } from "../src/db/schema.ts";
import type { DeskSettings } from "../src/lib/types.ts";
import type { MarketSnapshotRecord } from "../src/lib/marketSnapshotStore.ts";
import type { ApiKeyStoreFile } from "../src/lib/apiKeys/types.ts";

const dryRun = process.argv.includes("--dry-run");
const skipMigrate = process.argv.includes("--skip-migrate");

/** Collect --data-dir=PATH and LEGACY_DATA_DIR / LEGACY_DATA_DIRS */
function collectDataRoots(): string[] {
  const roots: string[] = [];
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--data-dir=")) {
      roots.push(path.resolve(arg.slice("--data-dir=".length)));
    }
  }
  const single = process.env.LEGACY_DATA_DIR?.trim();
  if (single) roots.push(path.resolve(single));
  const multi = process.env.LEGACY_DATA_DIRS?.trim();
  if (multi) {
    for (const part of multi.split(/[:;,]/)) {
      const p = part.trim();
      if (p) roots.push(path.resolve(p));
    }
  }
  // Production Docker volume (named volume mount)
  roots.push("/app/data/price-alerts");
  // Common host bind if operator mounts volume beside app
  roots.push(path.join(process.cwd(), "app", "data", "price-alerts"));
  // Local / legacy default
  roots.push(path.join(process.cwd(), ".data"));
  roots.push(path.join(process.cwd(), ".data", "price-alerts"));

  // Dedup preserve order
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of roots) {
    const n = path.resolve(r);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

const dataRoots = collectDataRoots();

type CountMap = Record<string, { before: number; imported: number; after: number; skipped: number }>;

const report: {
  startedAt: string;
  dryRun: boolean;
  skipMigrate: boolean;
  databaseUrlMode: string;
  dataRoots: string[];
  filesFound: Record<string, string | null>;
  counts: CountMap;
  errors: string[];
  warnings: string[];
  finishedAt?: string;
  ok: boolean;
} = {
  startedAt: new Date().toISOString(),
  dryRun,
  skipMigrate,
  databaseUrlMode: "",
  dataRoots,
  filesFound: {},
  counts: {},
  errors: [],
  warnings: [],
  ok: false
};

function initCount(key: string, before = 0): void {
  report.counts[key] = { before, imported: 0, after: 0, skipped: 0 };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Find first readable file among roots × relative candidates */
async function findFirstFile(
  label: string,
  relativeCandidates: string[]
): Promise<string | null> {
  for (const root of dataRoots) {
    for (const rel of relativeCandidates) {
      const full = path.isAbsolute(rel) ? rel : path.join(root, rel);
      if (await fileExists(full)) {
        report.filesFound[label] = full;
        return full;
      }
    }
  }
  // Also try absolute paths listed as relativeCandidates when they start with /
  for (const rel of relativeCandidates) {
    if (path.isAbsolute(rel) && (await fileExists(rel))) {
      report.filesFound[label] = rel;
      return rel;
    }
  }
  report.filesFound[label] = null;
  return null;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function importSettings(): Promise<void> {
  initCount("settings");
  const file = await findFirstFile("settings.json", [
    "settings.json",
    path.join("..", "settings.json")
  ]);
  // Also search sibling of price-alerts volume
  if (!file) {
    for (const root of dataRoots) {
      const parent = path.dirname(root);
      const cand = path.join(parent, "settings.json");
      if (await fileExists(cand)) {
        report.filesFound["settings.json"] = cand;
        const data = await readJsonFile<Partial<DeskSettings>>(cand);
        if (data) return applySettings(data);
      }
    }
    // full .data style
    const d = await findFirstFile("settings.json", [
      path.join(process.cwd(), ".data", "settings.json")
    ]);
    if (!d) {
      report.warnings.push("settings.json missing — defaults will apply at runtime");
      return;
    }
    const data = await readJsonFile<Partial<DeskSettings>>(d);
    if (!data) {
      report.warnings.push("settings.json unreadable");
      return;
    }
    return applySettings(data);
  }
  const data = await readJsonFile<Partial<DeskSettings>>(file);
  if (!data) {
    report.warnings.push("settings.json unreadable");
    return;
  }
  return applySettings(data);
}

async function applySettings(data: Partial<DeskSettings>): Promise<void> {
  report.counts.settings!.before = 1;
  if (dryRun) {
    report.counts.settings!.imported = 1;
    return;
  }
  const existing = await pgGetSettingsJson();
  if (existing) report.counts.settings!.skipped = 1;
  await pgSaveSettingsJson(
    {
      providerApiKeys: data.providerApiKeys ?? {},
      openAiApiKey: data.openAiApiKey ?? "",
      priceRefreshMinutes: data.priceRefreshMinutes ?? 3,
      globalMarketRefreshMinutes: data.globalMarketRefreshMinutes ?? 1,
      globalExchangeRefreshMinutes: data.globalExchangeRefreshMinutes ?? 5,
      newsRefreshMinutes: data.newsRefreshMinutes ?? 15,
      intelligenceRefreshMinutes: data.intelligenceRefreshMinutes ?? 60,
      outlierThresholdPercent: data.outlierThresholdPercent ?? 1.5,
      marketSpreadAlertThresholdPercent: data.marketSpreadAlertThresholdPercent ?? 1,
      depegAlertThresholdPercent: data.depegAlertThresholdPercent ?? 0.5,
      enabledSources: data.enabledSources ?? {}
    } as DeskSettings,
    "legacy-import"
  );
  report.counts.settings!.imported = 1;
  report.counts.settings!.after = 1;
}

async function importApiKeys(): Promise<void> {
  initCount("api_keys");
  const file = await findFirstFile("tether-api-keys.json", [
    "tether-api-keys.json",
    path.join(process.cwd(), ".data", "tether-api-keys.json"),
    process.env.TETHER_API_KEYS_DATA_FILE?.trim() || ""
  ].filter(Boolean));
  if (!file) {
    report.warnings.push("tether-api-keys.json missing");
    return;
  }
  const data = await readJsonFile<ApiKeyStoreFile>(file);
  if (!data?.keys) {
    report.warnings.push("tether-api-keys.json invalid");
    return;
  }
  report.counts.api_keys!.before = data.keys.length;
  for (const k of data.keys) {
    if (!/^[0-9a-f]{64}$/i.test(k.keyHash)) {
      report.errors.push(
        `API key hash incompatible (id=${k.id}): expected 64-char hex HMAC. Aborting key import.`
      );
      throw new Error("API_KEY_HASH_INCOMPATIBLE");
    }
  }
  if (dryRun) {
    report.counts.api_keys!.imported = data.keys.length;
    return;
  }
  const n = await pgImportApiKeyStoreFile(data);
  report.counts.api_keys!.imported = n;
  report.counts.api_keys!.skipped = data.keys.length - n;
  report.counts.api_keys!.after = (await pgListApiKeyRecords()).length;
}

async function importUsers(): Promise<void> {
  initCount("users");
  const file = await findFirstFile("desk-users.json", [
    "desk-users.json",
    "price-alerts/desk-users.json",
    process.env.DESK_USERS_DATA_FILE?.trim() || ""
  ].filter(Boolean));
  if (!file) {
    report.warnings.push("desk-users.json missing (env admin/viewer still work)");
    return;
  }
  const data = await readJsonFile<{ users?: Array<Record<string, unknown>> }>(file);
  if (!data?.users) {
    report.warnings.push("desk-users.json empty/invalid");
    return;
  }
  report.counts.users!.before = data.users.length;
  if (dryRun) {
    report.counts.users!.imported = data.users.length;
    return;
  }
  let imported = 0;
  for (const u of data.users) {
    if (
      typeof u.username !== "string" ||
      typeof u.usernameKey !== "string" ||
      typeof u.passwordHash !== "string" ||
      (u.role !== "admin" && u.role !== "viewer")
    ) {
      report.counts.users!.skipped += 1;
      continue;
    }
    await pgUpsertUser({
      id: typeof u.id === "string" ? u.id : undefined,
      username: u.username,
      usernameKey: u.usernameKey,
      passwordHash: u.passwordHash,
      role: u.role,
      isActive: u.enabled !== false,
      credentialVersion: typeof u.sessionEpoch === "number" ? u.sessionEpoch : 0,
      source: "managed",
      updatedBy: typeof u.updatedBy === "string" ? u.updatedBy : "legacy-import"
    });
    imported += 1;
  }
  report.counts.users!.imported = imported;
  report.counts.users!.after = (await pgListUsers()).length;
}

async function importViewerAuth(): Promise<void> {
  initCount("viewer_auth");
  const file = await findFirstFile("viewer-auth.json", [
    "viewer-auth.json",
    "price-alerts/viewer-auth.json",
    process.env.VIEWER_AUTH_DATA_FILE?.trim() || ""
  ].filter(Boolean));
  if (!file) {
    report.warnings.push("viewer-auth.json missing (env VIEWER_PASSWORD_HASH bootstrap only)");
    return;
  }
  const data = await readJsonFile<{
    passwordHash: string;
    sessionEpoch: number;
    updatedAt?: string | null;
    updatedBy?: string | null;
  }>(file);
  if (!data?.passwordHash) {
    report.warnings.push("viewer-auth.json invalid");
    return;
  }
  report.counts.viewer_auth!.before = 1;
  if (dryRun) {
    report.counts.viewer_auth!.imported = 1;
    return;
  }
  await __importViewerAuthOverride({
    passwordHash: data.passwordHash,
    sessionEpoch: data.sessionEpoch ?? 0,
    updatedAt: data.updatedAt ?? null,
    updatedBy: data.updatedBy ?? "legacy-import"
  });
  report.counts.viewer_auth!.imported = 1;
  report.counts.viewer_auth!.after = 1;
}

async function importAlerts(): Promise<void> {
  initCount("price_alerts");
  initCount("alert_notifications");
  const file = await findFirstFile("price-alerts.json", [
    "price-alerts.json",
    "price-alerts/price-alerts.json",
    process.env.PRICE_ALERTS_DATA_FILE?.trim() || ""
  ].filter(Boolean));
  if (!file) {
    report.warnings.push("price-alerts.json missing");
    return;
  }
  const data = await readJsonFile<{ alerts?: unknown[]; notifications?: unknown[] }>(file);
  if (!data) {
    report.warnings.push("price-alerts.json unreadable");
    return;
  }
  const alerts = (data.alerts ?? []) as Array<{ id: string } & Record<string, unknown>>;
  const notifications = (data.notifications ?? []) as Array<
    { id: string; alertId?: string; triggeredAt?: string } & Record<string, unknown>
  >;
  report.counts.price_alerts!.before = alerts.length;
  report.counts.alert_notifications!.before = notifications.length;
  if (dryRun) {
    report.counts.price_alerts!.imported = alerts.length;
    report.counts.alert_notifications!.imported = notifications.length;
    return;
  }
  const existing = await pgLoadAlertsBundle();
  if (existing.alerts.length === 0 && existing.notifications.length === 0) {
    await pgSaveAlertsBundle({ alerts, notifications });
    report.counts.price_alerts!.imported = alerts.length;
    report.counts.alert_notifications!.imported = notifications.length;
  } else {
    const alertMap = new Map(existing.alerts.map((a) => [(a as { id: string }).id, a]));
    for (const a of alerts) {
      if (!alertMap.has(a.id)) {
        alertMap.set(a.id, a);
        report.counts.price_alerts!.imported += 1;
      } else {
        report.counts.price_alerts!.skipped += 1;
      }
    }
    const notifMap = new Map(
      existing.notifications.map((n) => [(n as { id: string }).id, n])
    );
    for (const n of notifications) {
      if (!notifMap.has(n.id)) {
        notifMap.set(n.id, n);
        report.counts.alert_notifications!.imported += 1;
      } else {
        report.counts.alert_notifications!.skipped += 1;
      }
    }
    await pgSaveAlertsBundle({
      alerts: [...alertMap.values()] as Array<{ id: string } & Record<string, unknown>>,
      notifications: [...notifMap.values()] as Array<
        { id: string; alertId?: string; triggeredAt?: string } & Record<string, unknown>
      >
    });
  }
  const after = await pgLoadAlertsBundle();
  report.counts.price_alerts!.after = after.alerts.length;
  report.counts.alert_notifications!.after = after.notifications.length;
}

async function importSnapshot(): Promise<void> {
  initCount("market_snapshots");
  const file = await findFirstFile("market-snapshot.json", [
    "market-snapshot.json",
    process.env.MARKET_SNAPSHOT_DATA_FILE?.trim() || "",
    path.join(process.cwd(), ".data", "market-snapshot.json")
  ].filter(Boolean));
  if (!file) {
    report.warnings.push("market-snapshot.json missing (fresh snapshot will build on first request)");
    return;
  }
  const data = await readJsonFile<MarketSnapshotRecord>(file);
  if (!data?.tetherMarket) {
    report.warnings.push("market-snapshot.json invalid");
    return;
  }
  report.counts.market_snapshots!.before = 1;
  if (dryRun) {
    report.counts.market_snapshots!.imported = 1;
    return;
  }
  const existing = await pgReadLatestTetherSnapshot();
  if (existing) report.counts.market_snapshots!.skipped = 1;
  await pgWriteTetherSnapshot({
    version: 1,
    generatedAt: data.generatedAt,
    lastSuccessfulRefreshAt: data.lastSuccessfulRefreshAt,
    lastAttemptedRefreshAt: data.lastAttemptedRefreshAt,
    settingsKey: data.settingsKey,
    refreshIntervalMs: data.refreshIntervalMs,
    tetherMarket: data.tetherMarket,
    providers: data.providers ?? [],
    quotes: data.quotes ?? []
  });
  report.counts.market_snapshots!.imported = 1;
  report.counts.market_snapshots!.after = (await pgReadLatestTetherSnapshot()) ? 1 : 0;
}

async function importMedianHistory(): Promise<void> {
  initCount("median_history");
  const file = await findFirstFile("median-history.json", [
    "median-history.json",
    path.join(process.cwd(), ".data", "median-history.json")
  ]);
  if (!file) {
    report.warnings.push("median-history.json missing");
    return;
  }
  const data = await readJsonFile<{ samples?: Array<{ t: number; v: number }> }>(file);
  if (!data?.samples?.length) {
    report.warnings.push("median-history.json empty");
    return;
  }
  report.counts.median_history!.before = data.samples.length;
  if (dryRun) {
    report.counts.median_history!.imported = data.samples.length;
    return;
  }
  const db = await getDbAsync();
  let imported = 0;
  for (const s of data.samples) {
    if (!Number.isFinite(s.t) || !Number.isFinite(s.v)) {
      report.counts.median_history!.skipped += 1;
      continue;
    }
    try {
      await db
        .insert(medianHistorySamples)
        .values({ id: randomUUID(), sampledAtMs: s.t, medianValue: String(s.v) })
        .onConflictDoNothing();
      imported += 1;
    } catch {
      report.counts.median_history!.skipped += 1;
    }
  }
  report.counts.median_history!.imported = imported;
}

async function importNews(): Promise<void> {
  initCount("news_items");
  const file = await findFirstFile("impact-news-store.json", [
    "impact-news-store.json",
    path.join(process.cwd(), ".data", "impact-news-store.json")
  ]);
  if (!file) {
    report.warnings.push("impact-news-store.json missing");
    return;
  }
  const data = await readJsonFile<{
    articles?: Record<string, Record<string, unknown>>;
    providers?: Record<string, unknown>;
    updatedAt?: string | null;
  }>(file);
  if (!data?.articles) {
    report.warnings.push("impact-news-store.json invalid");
    return;
  }
  const ids = Object.keys(data.articles);
  report.counts.news_items!.before = ids.length;
  if (dryRun) {
    report.counts.news_items!.imported = ids.length;
    return;
  }
  const db = await getDbAsync();
  let imported = 0;
  for (const [id, article] of Object.entries(data.articles)) {
    try {
      await db
        .insert(newsItems)
        .values({
          id,
          payload: article,
          publishedAt: typeof article.publishedAt === "string" ? article.publishedAt : null,
          updatedAt: new Date().toISOString()
        })
        .onConflictDoNothing();
      imported += 1;
    } catch {
      report.counts.news_items!.skipped += 1;
    }
  }
  await db
    .insert(appSettings)
    .values({
      key: "impact_news_store",
      value: {
        version: 1,
        updatedAt: data.updatedAt ?? null,
        providers: data.providers ?? {}
      },
      updatedBy: "legacy-import",
      updatedAt: new Date().toISOString()
    })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: {
        value: {
          version: 1,
          updatedAt: data.updatedAt ?? null,
          providers: data.providers ?? {}
        },
        updatedAt: new Date().toISOString()
      }
    });
  report.counts.news_items!.imported = imported;
}

async function writeReport(): Promise<string> {
  const outDir = path.join(process.cwd(), ".data");
  await mkdir(outDir, { recursive: true });
  const reportPath = path.join(
    outDir,
    `migration-report-${dryRun ? "dry-" : ""}${Date.now()}.json`
  );
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  return reportPath;
}

async function main() {
  try {
    const url = getDatabaseUrl();
    report.databaseUrlMode = isPgliteUrl(url) ? "pglite" : "postgres";
    console.log(`[import] DATABASE_URL mode: ${report.databaseUrlMode}`);
    console.log(`[import] dry-run: ${dryRun}`);
    console.log(`[import] data roots:`, dataRoots);

    if (!skipMigrate) {
      console.log("[import] running schema migrations…");
      const mig = await runMigrations();
      console.log("[import] migrations applied:", mig.applied, "skipped:", mig.skipped);
    } else {
      console.log("[import] skipping migrations (--skip-migrate)");
    }
    await pingDatabase();
    console.log("[import] database ping OK");

    await importSettings();
    await importApiKeys();
    await importUsers();
    await importViewerAuth();
    await importAlerts();
    await importSnapshot();
    await importMedianHistory();
    await importNews();

    report.ok = report.errors.length === 0;
    report.finishedAt = new Date().toISOString();
    const reportPath = await writeReport();

    console.log("\n=== Migration report ===");
    console.log("Files found:", JSON.stringify(report.filesFound, null, 2));
    console.log("Counts:", JSON.stringify(report.counts, null, 2));
    if (report.warnings.length) console.log("Warnings:", report.warnings);
    if (report.errors.length) console.log("Errors:", report.errors);
    console.log(`Report written: ${reportPath}`);
    console.log(report.ok ? "OK" : "FAILED");
    process.exit(report.ok ? 0 : 1);
  } catch (e) {
    report.ok = false;
    report.errors.push(e instanceof Error ? e.message : String(e));
    report.finishedAt = new Date().toISOString();
    console.error(e);
    try {
      const reportPath = await writeReport();
      console.error("Error report:", reportPath);
    } catch {
      /* ignore */
    }
    process.exit(1);
  } finally {
    await closeDb();
  }
}

main();
