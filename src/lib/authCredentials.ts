import "server-only";

import type { DeskRole } from "@/lib/auth";
import { verifyPassword } from "@/lib/passwordHash";

export type VerifiedIdentity = {
  username: string;
  role: DeskRole;
};

function stripEnvQuotes(value: string): string {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith("\"") && value.endsWith("\""))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readUsername(envValue: string | undefined): string | null {
  const value = envValue ? stripEnvQuotes(envValue.trim()) : "";
  return value ? value : null;
}

function readPasswordHash(envValue: string | undefined): string | null {
  const value = envValue ? stripEnvQuotes(envValue.trim()) : "";
  if (!value || !value.startsWith("pbkdf2$")) return null;
  return value;
}

function authEnvReady(): boolean {
  const secret = process.env.AUTH_TOKEN_SECRET?.trim();
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) return false;

  return Boolean(
    readUsername(process.env.ADMIN_USERNAME) &&
      readPasswordHash(process.env.ADMIN_PASSWORD_HASH) &&
      readUsername(process.env.VIEWER_USERNAME) &&
      readPasswordHash(process.env.VIEWER_PASSWORD_HASH)
  );
}

/** Server-only credential check; never import from client or middleware. */
export function verifyCredentials(username: unknown, password: unknown): VerifiedIdentity | null {
  if (!authEnvReady()) return null;

  const user = typeof username === "string" ? username.trim() : "";
  const pass = typeof password === "string" ? password : "";
  if (!user || !pass) return null;

  const adminUsername = readUsername(process.env.ADMIN_USERNAME);
  const adminHash = readPasswordHash(process.env.ADMIN_PASSWORD_HASH);
  const viewerUsername = readUsername(process.env.VIEWER_USERNAME);
  const viewerHash = readPasswordHash(process.env.VIEWER_PASSWORD_HASH);

  if (!adminUsername || !adminHash || !viewerUsername || !viewerHash) return null;

  if (user === adminUsername && verifyPassword(pass, adminHash)) {
    return { username: adminUsername, role: "admin" };
  }

  if (user === viewerUsername && verifyPassword(pass, viewerHash)) {
    return { username: viewerUsername, role: "viewer" };
  }

  return null;
}