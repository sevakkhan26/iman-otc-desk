#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function loadLocalEnv() {
  try {
    const contents = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    for (const line of contents.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index < 0) continue;
      const key = trimmed.slice(0, index).trim();
      if (process.env[key]) continue;
      let value = trimmed.slice(index + 1).trim();
      if (
        (value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith("\"") && value.endsWith("\""))
      ) {
        value = value.slice(1, -1);
      }
      value = value.replace(/\\\$/g, "$");
      process.env[key] = value;
    }
  } catch {
    // optional for CI; required vars are validated below
  }
}

loadLocalEnv();

const BASE = process.env.AUTH_TEST_BASE ?? "http://127.0.0.1:3000";
const ADMIN_USER = process.env.ADMIN_USERNAME;
const ADMIN_PASS = process.env.AUTH_TEST_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD;
const VIEWER_USER = process.env.VIEWER_USERNAME;
const VIEWER_PASS = process.env.AUTH_TEST_VIEWER_PASSWORD ?? process.env.VIEWER_PASSWORD;

if (!ADMIN_USER || !ADMIN_PASS || !VIEWER_USER || !VIEWER_PASS) {
  console.error(
    "Set ADMIN_USERNAME, VIEWER_USERNAME, and test passwords via AUTH_TEST_ADMIN_PASSWORD / AUTH_TEST_VIEWER_PASSWORD."
  );
  process.exit(1);
}

async function curl(args) {
  const child = spawn("curl", ["-sS", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const [stdout, stderr] = await Promise.all([
    new Promise((resolve) => {
      let data = "";
      child.stdout.on("data", (chunk) => {
        data += chunk;
      });
      child.on("close", () => resolve(data));
    }),
    new Promise((resolve) => {
      let data = "";
      child.stderr.on("data", (chunk) => {
        data += chunk;
      });
      child.on("close", () => resolve(data));
    })
  ]);
  await once(child, "close");
  if (child.exitCode !== 0) {
    throw new Error(stderr || stdout || `curl failed: ${args.join(" ")}`);
  }
  return stdout.trim();
}

async function status(cookieJar, method, path, body) {
  const args = ["-b", cookieJar, "-c", cookieJar, "-o", "/dev/null", "-w", "%{http_code}", "-X", method, `${BASE}${path}`];
  if (body !== undefined) {
    args.push("-H", "content-type: application/json", "--data", JSON.stringify(body));
  }
  return Number(await curl(args));
}

async function main() {
  const adminJar = "/tmp/otc-admin-auth.jar";
  const viewerJar = "/tmp/otc-viewer-auth.jar";

  const adminLogin = await status(adminJar, "POST", "/api/auth/login", {
    username: ADMIN_USER,
    password: ADMIN_PASS
  });
  const viewerLogin = await status(viewerJar, "POST", "/api/auth/login", {
    username: VIEWER_USER,
    password: VIEWER_PASS
  });

  const checks = [
    ["admin login", adminLogin, 200],
    ["viewer login", viewerLogin, 200],
    ["admin GET settings", await status(adminJar, "GET", "/api/settings"), 200],
    ["admin PATCH settings", await status(adminJar, "PATCH", "/api/settings", { theme: "dark" }), 200],
    ["viewer GET dashboard", await status(viewerJar, "GET", "/api/dashboard"), 200],
    ["viewer GET settings", await status(viewerJar, "GET", "/api/settings"), 403],
    ["viewer PATCH settings", await status(viewerJar, "PATCH", "/api/settings", { theme: "dark" }), 403]
  ];

  for (const [name, actual, expected] of checks) {
    if (actual !== expected) {
      throw new Error(`${name}: expected ${expected}, got ${actual}`);
    }
  }

  process.stdout.write("auth rbac tests passed\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});