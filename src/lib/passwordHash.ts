import "server-only";

import { pbkdf2Sync, timingSafeEqual } from "node:crypto";

const EXPECTED_PREFIX = "pbkdf2";
const EXPECTED_ITERATIONS = 200_000;
const EXPECTED_KEY_LEN = 32;
const MIN_SALT_HEX_LEN = 32; // 16 bytes
const DIGEST = "sha256";

export type ParsedPasswordHash = {
  iterations: number;
  salt: Buffer;
  hash: Buffer;
};

export function parsePasswordHash(stored: string): ParsedPasswordHash | null {
  const parts = stored.trim().split("$");
  if (parts.length !== 4) return null;
  if (parts[0] !== EXPECTED_PREFIX) return null;

  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations !== EXPECTED_ITERATIONS) return null;

  const saltHex = parts[2];
  const hashHex = parts[3];
  if (!/^[0-9a-f]+$/i.test(saltHex) || saltHex.length < MIN_SALT_HEX_LEN) return null;
  if (!/^[0-9a-f]+$/i.test(hashHex) || hashHex.length !== EXPECTED_KEY_LEN * 2) return null;

  try {
    const salt = Buffer.from(saltHex, "hex");
    const hash = Buffer.from(hashHex, "hex");
    if (salt.length < 16 || hash.length !== EXPECTED_KEY_LEN) return null;
    return { iterations, salt, hash };
  } catch {
    return null;
  }
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parsed = parsePasswordHash(storedHash);
  if (!parsed) return false;

  const derived = pbkdf2Sync(password, parsed.salt, parsed.iterations, parsed.hash.length, DIGEST);
  if (derived.length !== parsed.hash.length) return false;
  return timingSafeEqual(derived, parsed.hash);
}