import { COOKIE_MAX_AGE_S, type DeskRole, type SessionClaims } from "@/lib/auth";

const MIN_SECRET_BYTES = 32;

function base64UrlToBytes(value: string): Uint8Array | null {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function readAuthTokenSecret(): string | null {
  const secret = process.env.AUTH_TOKEN_SECRET?.trim();
  if (!secret) return null;
  const byteLength = new TextEncoder().encode(secret).length;
  if (byteLength < MIN_SECRET_BYTES) return null;
  return secret;
}

function isDeskRole(value: unknown): value is DeskRole {
  return value === "admin" || value === "viewer";
}

function isValidClaims(value: unknown): value is SessionClaims {
  if (!value || typeof value !== "object") return false;
  const claims = value as SessionClaims;
  return (
    typeof claims.u === "string" &&
    claims.u.length > 0 &&
    isDeskRole(claims.r) &&
    Number.isFinite(claims.iat) &&
    Number.isFinite(claims.exp) &&
    claims.exp > claims.iat &&
    claims.exp - claims.iat <= COOKIE_MAX_AGE_S + 60
  );
}

async function verifySignature(payloadB64: string, signatureB64: string, secret: string): Promise<boolean> {
  const signature = base64UrlToBytes(signatureB64);
  if (!signature) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signatureCopy = Uint8Array.from(signature);
  return crypto.subtle.verify("HMAC", key, signatureCopy, new TextEncoder().encode(payloadB64));
}

export async function verifySessionToken(token: string | undefined): Promise<SessionClaims | null> {
  if (!token) return null;

  const secret = readAuthTokenSecret();
  if (!secret) return null;

  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;

  const payloadB64 = token.slice(0, separator);
  const signatureB64 = token.slice(separator + 1);

  const signatureValid = await verifySignature(payloadB64, signatureB64, secret);
  if (!signatureValid) return null;

  const payloadBytes = base64UrlToBytes(payloadB64);
  if (!payloadBytes) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }

  if (!isValidClaims(parsed)) return null;
  if (parsed.exp <= Math.floor(Date.now() / 1000)) return null;

  return parsed;
}

export function getSessionRoleFromClaims(claims: SessionClaims | null): DeskRole | null {
  return claims?.r ?? null;
}