import "server-only";

import type { DeskRole } from "@/lib/auth";
import { verifyPassword } from "@/lib/passwordHash";
import {
  findManagedUserByUsername,
  getEnvAdminUsername,
  getEnvViewerUsername
} from "@/lib/userStore";
import { getViewerPasswordHash, getViewerSessionEpoch } from "@/lib/viewerAuthStore";

export type VerifiedIdentity = {
  username: string;
  role: DeskRole;
  /** Embedded in session cookie; invalidates sessions after password rotate. */
  passwordVersion: number;
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
      readUsername(process.env.VIEWER_USERNAME)
  );
}

/**
 * Server-only credential check; never import from client or middleware.
 * Order: env admin → env viewer (file override hash) → managed users file.
 */
export async function verifyCredentials(
  username: unknown,
  password: unknown
): Promise<VerifiedIdentity | null> {
  if (!authEnvReady()) return null;

  const user = typeof username === "string" ? username.trim() : "";
  const pass = typeof password === "string" ? password : "";
  if (!user || !pass) return null;

  const adminUsername = getEnvAdminUsername() ?? readUsername(process.env.ADMIN_USERNAME);
  const adminHash = readPasswordHash(process.env.ADMIN_PASSWORD_HASH);
  const viewerUsername = getEnvViewerUsername() ?? readUsername(process.env.VIEWER_USERNAME);

  if (!adminUsername || !adminHash || !viewerUsername) return null;

  if (user.toLowerCase() === adminUsername.toLowerCase() && verifyPassword(pass, adminHash)) {
    return { username: adminUsername, role: "admin", passwordVersion: 0 };
  }

  if (user.toLowerCase() === viewerUsername.toLowerCase()) {
    const viewerHash = await getViewerPasswordHash();
    if (!viewerHash) return null;
    if (!verifyPassword(pass, viewerHash)) return null;
    const passwordVersion = await getViewerSessionEpoch();
    return { username: viewerUsername, role: "viewer", passwordVersion };
  }

  const managed = await findManagedUserByUsername(user);
  if (managed && managed.enabled && verifyPassword(pass, managed.passwordHash)) {
    return {
      username: managed.username,
      role: managed.role,
      passwordVersion: managed.sessionEpoch
    };
  }

  return null;
}
