#!/usr/bin/env npx tsx
/**
 * Unit tests for managed user store (no network).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword } from "../src/lib/passwordHash.ts";
import {
  clearUserStoreMemCache,
  createManagedUser,
  deleteManagedUser,
  findManagedUserByUsername,
  getIdentitySessionEpoch,
  isIdentityStillValid,
  listUserAccounts,
  resetUserPassword,
  setManagedUserEnabled,
  validateUsernamePlain
} from "../src/lib/userStore.ts";
import { clearViewerAuthMemCache } from "../src/lib/viewerAuthStore.ts";

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
  console.log("\n== User store unit tests ==");

  assert("username too short", validateUsernamePlain("ab") !== null);
  assert("username spaces rejected", validateUsernamePlain("bad user") !== null);
  assert("username ok", validateUsernamePlain("trader_01") === null);

  const dir = await mkdtemp(path.join(tmpdir(), "otc-users-"));
  const usersPath = path.join(dir, "desk-users.json");
  const viewerPath = path.join(dir, "viewer-auth.json");
  process.env.DESK_USERS_DATA_FILE = usersPath;
  process.env.VIEWER_AUTH_DATA_FILE = viewerPath;
  process.env.ADMIN_USERNAME = "rootadmin";
  process.env.ADMIN_PASSWORD_HASH = hashPassword("admin-password-xx");
  process.env.VIEWER_USERNAME = "deskviewer";
  process.env.VIEWER_PASSWORD_HASH = hashPassword("viewer-password-xx");
  clearUserStoreMemCache();
  clearViewerAuthMemCache();

  try {
    const listed = await listUserAccounts();
    assert("lists env admin", listed.some((u) => u.id === "env:admin" && u.username === "rootadmin"));
    assert("lists env viewer", listed.some((u) => u.id === "env:viewer" && u.username === "deskviewer"));
    assert("env admin cannot reset password", listed.find((u) => u.id === "env:admin")?.canResetPassword === false);
    assert("env viewer can reset password", listed.find((u) => u.id === "env:viewer")?.canResetPassword === true);

    const created = await createManagedUser(
      {
        username: "trader01",
        password: "secret-pass-01",
        confirmPassword: "secret-pass-01",
        role: "viewer"
      },
      "rootadmin"
    );
    assert("create ok", created.ok === true);
    if (!created.ok) throw new Error(created.message);

    assert("created username", created.user.username === "trader01");
    assert("created role viewer", created.user.role === "viewer");
    assert("created can delete", created.user.canDelete === true);

    const dup = await createManagedUser(
      {
        username: "Trader01",
        password: "secret-pass-02",
        confirmPassword: "secret-pass-02",
        role: "viewer"
      },
      "rootadmin"
    );
    assert("duplicate username rejected", dup.ok === false);

    const reserved = await createManagedUser(
      {
        username: "rootadmin",
        password: "secret-pass-03",
        confirmPassword: "secret-pass-03",
        role: "viewer"
      },
      "rootadmin"
    );
    assert("env admin username reserved", reserved.ok === false);

    const found = await findManagedUserByUsername("TRADER01");
    assert("find case-insensitive", Boolean(found && found.username === "trader01"));
    assert("epoch starts 0", found?.sessionEpoch === 0);
    assert("identity valid at 0", (await isIdentityStillValid("trader01", "viewer", 0)) === true);

    const reset = await resetUserPassword(
      created.user.id,
      { newPassword: "secret-pass-99", confirmPassword: "secret-pass-99" },
      "rootadmin"
    );
    assert("reset ok", reset.ok === true);
    clearUserStoreMemCache();
    const after = await findManagedUserByUsername("trader01");
    assert("epoch bumped", after?.sessionEpoch === 1);
    assert("old session invalid", (await isIdentityStillValid("trader01", "viewer", 0)) === false);
    assert("new session valid", (await isIdentityStillValid("trader01", "viewer", 1)) === true);

    const envViewerReset = await resetUserPassword(
      "env:viewer",
      { newPassword: "viewer-panel-pass1", confirmPassword: "viewer-panel-pass1" },
      "rootadmin"
    );
    assert("env viewer reset ok", envViewerReset.ok === true);
    const viewerEpoch = await getIdentitySessionEpoch("deskviewer", "viewer");
    assert("env viewer epoch bumped", viewerEpoch === 1);

    const disabled = await setManagedUserEnabled(created.user.id, false, "rootadmin");
    assert("disable ok", disabled.ok === true);
    assert("disabled flag", disabled.ok && disabled.user.enabled === false);
    clearUserStoreMemCache();
    assert(
      "disabled session invalid",
      (await isIdentityStillValid("trader01", "viewer", 1)) === false
    );

    const del = await deleteManagedUser(created.user.id);
    assert("delete ok", del.ok === true);
    clearUserStoreMemCache();
    assert("gone after delete", (await findManagedUserByUsername("trader01")) === null);
    assert("cannot delete env admin", (await deleteManagedUser("env:admin")).ok === false);
  } finally {
    clearUserStoreMemCache();
    clearViewerAuthMemCache();
    delete process.env.DESK_USERS_DATA_FILE;
    delete process.env.VIEWER_AUTH_DATA_FILE;
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
