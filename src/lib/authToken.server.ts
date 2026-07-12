import "server-only";

import { createHmac } from "node:crypto";
import { COOKIE_MAX_AGE_S, type DeskRole, type SessionClaims } from "@/lib/auth";

const MIN_SECRET_BYTES = 32;

function readAuthTokenSecret(): string | null {
  const secret = process.env.AUTH_TOKEN_SECRET?.trim();
  if (!secret) return null;
  if (Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) return null;
  return secret;
}

export function createSessionToken(username: string, role: DeskRole): string | null {
  const secret = readAuthTokenSecret();
  if (!secret) return null;

  const now = Math.floor(Date.now() / 1000);
  const payload: SessionClaims = {
    u: username,
    r: role,
    iat: now,
    exp: now + COOKIE_MAX_AGE_S
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signatureB64 = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signatureB64}`;
}