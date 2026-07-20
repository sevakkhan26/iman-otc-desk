#!/usr/bin/env npx tsx
/**
 * Unit tests for viewer password store + hash helpers (no network).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword, verifyPassword } from "../src/lib/passwordHash.ts";
import {
  clearViewerAuthMemCache,
  getViewerAuthPublicMeta,
  getViewerPasswordHash,
  getViewerSessionEpoch,
  setViewerPasswordFromAdmin,
  validateViewerPasswordPlain
} from "../src/lib/viewerAuthStore.ts";

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  console.log("\n== Viewer auth unit tests ==");

  const plain = "testPass-12345";
  const hashed = hashPassword(plain);
  assert("hash starts with pbkdf2$", hashed.startsWith("pbkdf2$200000$"));
  assert("verify ok", verifyPassword(plain, hashed) === true);
  assert("verify wrong", verifyPassword("wrong-password", hashed) === false);

  assert("too short rejected", validateViewerPasswordPlain("short") !== null);
  assert("spaces rejected", validateViewerPasswordPlain("bad pass word1") !== null);
  assert("good password accepted", validateViewerPasswordPlain("longEnough9") === null);

  const dir = await mkdtemp(path.join(tmpdir(), "otc-viewer-auth-"));
  process.env.DATABASE_URL = `pglite:${path.join(dir, "pglite")}`;
  process.env.VIEWER_PASSWORD_HASH = hashPassword("env-bootstrap-password-xx");
  const { runMigrations } = await import("../src/db/migrate.ts");
  await runMigrations();
  clearViewerAuthMemCache();

  try {
    assert("epoch starts at 0 (env bootstrap)", (await getViewerSessionEpoch()) === 0);
    assert("meta source env", (await getViewerAuthPublicMeta()).source === "env");

    const envHash = await getViewerPasswordHash();
    assert("uses env hash before override", Boolean(envHash && verifyPassword("env-bootstrap-password-xx", envHash!)));

    const set1 = await setViewerPasswordFromAdmin("panel-password-01", "admin");
    assert("set password ok", set1.ok === true);
    if (set1.ok) assert("epoch bumped to 1", set1.sessionEpoch === 1);

    clearViewerAuthMemCache();
    const overrideHash = await getViewerPasswordHash();
    assert(
      "override wins over env",
      Boolean(overrideHash && verifyPassword("panel-password-01", overrideHash!))
    );
    assert("meta source override", (await getViewerAuthPublicMeta()).source === "override");
    assert("epoch after reload is 1", (await getViewerSessionEpoch()) === 1);

    const set2 = await setViewerPasswordFromAdmin("panel-password-02", "admin");
    assert("second rotate ok", set2.ok === true);
    if (set2.ok) assert("epoch bumped to 2", set2.sessionEpoch === 2);
    clearViewerAuthMemCache();
    const h2 = await getViewerPasswordHash();
    assert("old password invalid", Boolean(h2 && !verifyPassword("panel-password-01", h2!)));
    assert("new password valid", Boolean(h2 && verifyPassword("panel-password-02", h2!)));
  } finally {
    clearViewerAuthMemCache();
    try {
      const { closeDb } = await import("../src/db/client.ts");
      await closeDb();
    } catch {
      /* ignore */
    }
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
