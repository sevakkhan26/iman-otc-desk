#!/usr/bin/env node
import { randomBytes } from "node:crypto";

const bytes = Number(process.argv[2] ?? 32);
if (!Number.isInteger(bytes) || bytes < 32) {
  console.error("Usage: node scripts/generate-auth-token-secret.mjs [bytes>=32]");
  process.exit(1);
}

console.log(randomBytes(bytes).toString("hex"));