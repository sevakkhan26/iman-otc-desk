/**
 * Focused PostgreSQL persistence tests (PGlite, isolated temp dir).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(tmpdir(), "otc-pg-test-"));
process.env.DATABASE_URL = `pglite:${dataDir}`;
// Ensure no Redis/file fallbacks influence tests
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.MARKET_SNAPSHOT_STORAGE;
delete process.env.PRICE_ALERTS_STORAGE;
delete process.env.TETHER_API_KEYS_STORAGE;

// Dynamic imports after env is set
const { closeDb, pingDatabase, getDbMode } = await import("../src/db/client.ts");
const { runMigrations } = await import("../src/db/migrate.ts");
const {
  createApiKey,
  authenticateApiKey,
  revokeApiKey,
  hashApiKey,
  listApiKeys,
  updateApiKeyScopes,
  API_KEY_RATE_LIMIT_PER_MINUTE
} = await import("../src/lib/apiKeys/service.ts");
const { pgFindApiKeyByHash } = await import("../src/db/repositories/apiKeys.ts");
const { getSettings, patchSettings, clearSettingsMemCache } = await import("../src/lib/settings.ts");
const {
  createManagedUser,
  listUserAccounts,
  resetUserPassword,
  findManagedUserByUsername,
  clearUserStoreMemCache
} = await import("../src/lib/userStore.ts");
const {
  createAlert,
  listAlerts,
  __resetStoreMemoryForTests
} = await import("../src/lib/priceAlerts/store.ts");
const {
  writeMarketSnapshot,
  readMarketSnapshot,
  pgWithTetherRefreshLock
} = await import("../src/lib/marketSnapshotStore.ts");
const { pgWriteTetherSnapshot } = await import("../src/db/repositories/marketSnapshots.ts");

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error instanceof Error ? error.message : error}`);
    failed += 1;
  }
}

console.log("\nPostgreSQL persistence tests (PGlite)\n");

await test("migrations from empty database", async () => {
  const r = await runMigrations();
  assert.ok(r.applied.includes("0000_init.sql") || r.skipped.includes("0000_init.sql"));
  const ping = await pingDatabase();
  assert.equal(ping.ok, true);
  assert.equal(getDbMode(), "pglite");
});

await test("idempotent migration re-run", async () => {
  const r = await runMigrations();
  assert.equal(r.applied.length, 0);
  assert.ok(r.skipped.includes("0000_init.sql"));
});

await test("settings persistence", async () => {
  clearSettingsMemCache();
  const s = await getSettings();
  assert.equal(s.priceRefreshMinutes, 3);
  await patchSettings({ priceRefreshMinutes: 7 });
  clearSettingsMemCache();
  const s2 = await getSettings();
  assert.equal(s2.priceRefreshMinutes, 7);
});

await test("user create + password reset invalidates session epoch", async () => {
  clearUserStoreMemCache();
  // Need env for authEnvReady if we verify credentials — set minimal
  process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin_test";
  process.env.ADMIN_PASSWORD_HASH =
    process.env.ADMIN_PASSWORD_HASH ||
    "pbkdf2$sha256$100000$dGVzdHNhbHQ$dGVzdGhhc2g"; // may not verify; user store is independent
  process.env.VIEWER_USERNAME = process.env.VIEWER_USERNAME || "viewer_test";
  process.env.AUTH_TOKEN_SECRET =
    process.env.AUTH_TOKEN_SECRET || "x".repeat(40);

  const created = await createManagedUser(
    {
      username: "desk_user_1",
      password: "SecurePass12",
      confirmPassword: "SecurePass12",
      role: "viewer"
    },
    "admin"
  );
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error(created.message);
  const found = await findManagedUserByUsername("desk_user_1");
  assert.ok(found);
  assert.equal(found!.sessionEpoch, 0);
  const reset = await resetUserPassword(
    created.user.id,
    { newPassword: "SecurePass99", confirmPassword: "SecurePass99" },
    "admin"
  );
  assert.equal(reset.ok, true);
  const found2 = await findManagedUserByUsername("desk_user_1");
  assert.equal(found2!.sessionEpoch, 1);
  const accounts = await listUserAccounts();
  assert.ok(accounts.some((a) => a.username === "desk_user_1"));
});

await test("API key create, hash, scopes, revoke", async () => {
  const { publicKey, plaintext } = await createApiKey({
    name: "pg-test-key",
    scopes: ["tether:read", "gold:read"],
    createdBy: "test"
  });
  assert.ok(plaintext.startsWith("otc_live_"));
  assert.deepEqual(publicKey.scopes.sort(), ["gold:read", "tether:read"].sort());
  const hash = hashApiKey(plaintext);
  const row = await pgFindApiKeyByHash(hash);
  assert.ok(row);
  assert.equal(row!.keyHash, hash);
  // scopes update
  const updated = await updateApiKeyScopes(publicKey.id, ["usd:read", "aed:read"]);
  assert.ok(updated);
  assert.deepEqual(updated!.scopes.sort(), ["aed:read", "usd:read"].sort());
  // auth
  const auth = await authenticateApiKey(`Bearer ${plaintext}`);
  // may fail scope check later; authenticate itself should succeed
  assert.equal(auth.ok, true);
  const revoked = await revokeApiKey(publicKey.id);
  assert.ok(revoked?.revokedAt);
  const auth2 = await authenticateApiKey(`Bearer ${plaintext}`);
  assert.equal(auth2.ok, false);
  if (!auth2.ok) assert.equal(auth2.reason, "revoked");
  const listed = await listApiKeys();
  assert.ok(listed.some((k) => k.id === publicKey.id));
});

await test("API key rate limiting (PostgreSQL UPSERT)", async () => {
  const { plaintext } = await createApiKey({
    name: "rate-limit-key",
    scopes: ["tether:read"],
    createdBy: "test"
  });
  let limited = false;
  for (let i = 0; i < API_KEY_RATE_LIMIT_PER_MINUTE + 5; i++) {
    const r = await authenticateApiKey(`Bearer ${plaintext}`);
    if (!r.ok && r.reason === "rate_limited") {
      limited = true;
      break;
    }
  }
  assert.equal(limited, true);
});

await test("alerts persistence", async () => {
  await __resetStoreMemoryForTests();
  const rule = {
    id: "alert_test_1",
    instrument: "USDT_IRT_MEDIAN",
    condition: "above",
    threshold: 200000,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    ownerUsername: "admin",
    ownerRole: "admin"
  } as never;
  await createAlert(rule);
  await __resetStoreMemoryForTests();
  const list = await listAlerts();
  assert.ok(list.some((a) => a.id === "alert_test_1"));
});

await test("canonical snapshot write + dedup", async () => {
  const record = {
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    lastSuccessfulRefreshAt: new Date().toISOString(),
    lastAttemptedRefreshAt: new Date().toISOString(),
    settingsKey: "3|1.5|test",
    refreshIntervalMs: 180_000,
    tetherMarket: {
      summary: {
        median: 100,
        highest: null,
        highestExchange: null,
        lowest: null,
        lowestExchange: null,
        marketSpreadPercent: null,
        bestBuy: null,
        bestBuyExchange: null,
        bestSell: null,
        bestSellExchange: null,
        worstBuy: null,
        worstBuyExchange: null,
        buySpreadPercent: null,
        sellSpreadPercent: null,
        availableCount: 0,
        totalCount: 0
      },
      exchanges: [],
      providers: [],
      settings: {
        outlierThresholdPercent: 1.5,
        marketSpreadAlertThresholdPercent: 1
      },
      generatedAt: new Date().toISOString()
    } as never,
    providers: [],
    quotes: []
  };
  await writeMarketSnapshot(record);
  const id1 = await pgWriteTetherSnapshot(record);
  const id2 = await pgWriteTetherSnapshot(record);
  assert.equal(id1, id2); // content hash dedup
  const read = await readMarketSnapshot();
  assert.ok(read);
  assert.equal(read!.settingsKey, "3|1.5|test");
});

await test("advisory lock single-flight (pglite always acquires)", async () => {
  let ran = 0;
  const r = await pgWithTetherRefreshLock(async () => {
    ran += 1;
    return 42;
  });
  assert.equal(r.acquired, true);
  assert.equal(r.result, 42);
  assert.equal(ran, 1);
});

await test("DATABASE_URL missing fails closed", async () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  // Re-import client is cached — test getDatabaseUrl via dynamic
  const { getDatabaseUrl, DatabaseUnavailableError, closeDb: close } = await import(
    "../src/db/client.ts"
  );
  await close();
  let threw = false;
  try {
    getDatabaseUrl();
  } catch (e) {
    threw = e instanceof DatabaseUnavailableError;
  }
  process.env.DATABASE_URL = prev;
  // re-init
  await import("../src/db/client.ts");
  assert.equal(threw, true);
});

console.log(`\n${passed} passed, ${failed} failed\n`);

await closeDb();
try {
  rmSync(dataDir, { recursive: true, force: true });
} catch {
  /* ignore */
}

process.exit(failed > 0 ? 1 : 0);
