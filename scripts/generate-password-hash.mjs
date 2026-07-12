#!/usr/bin/env node
import { pbkdf2Sync, randomBytes } from "node:crypto";

const ITERATIONS = 200_000;
const SALT_LEN = 16;
const KEY_LEN = 32;
const DIGEST = "sha256";

const password = process.argv[2];
if (!password) {
  console.error("Usage: node scripts/generate-password-hash.mjs <password>");
  process.exit(1);
}

const salt = randomBytes(SALT_LEN);
const derived = pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, DIGEST);
const hash = `pbkdf2$${ITERATIONS}$${salt.toString("hex")}$${derived.toString("hex")}`;
const escapedForDotenv = hash.replace(/\$/g, "\\$");

console.log(hash);
console.error("");
console.error("Production / Vercel: paste the line above as-is.");
console.error("Local .env.local: escape $ for dotenv variable expansion:");
console.error(escapedForDotenv);