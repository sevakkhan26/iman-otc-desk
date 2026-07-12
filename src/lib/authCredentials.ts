import "server-only";

import type { DeskRole } from "@/lib/auth";

/** Server-only credential check; never import from client or middleware. */
export function verifyCredentials(username: unknown, password: unknown): DeskRole | null {
  const user = typeof username === "string" ? username : "";
  const pass = typeof password === "string" ? password : "";

  if (user === process.env.ADMIN_USERNAME && pass === process.env.ADMIN_PASSWORD) {
    return "admin";
  }
  if (user === process.env.VIEWER_USERNAME && pass === process.env.VIEWER_PASSWORD) {
    return "viewer";
  }
  return null;
}