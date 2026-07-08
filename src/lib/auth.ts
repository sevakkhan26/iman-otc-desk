// Simple local/internal auth for the desk dashboard.
// Constants only (edge-safe) — imported by both middleware and the auth API routes.

export const AUTH_COOKIE = "otc-auth";

// Static session token: fine for a local dashboard, survives server restarts,
// and an httpOnly cookie means the browser never exposes it to page scripts.
export const AUTH_TOKEN = "otc-desk-session-9f2c41ab7d5e";

const AUTH_USERNAME = "admin";
const AUTH_PASSWORD = "1234";

export function checkCredentials(username: unknown, password: unknown): boolean {
  return username === AUTH_USERNAME && password === AUTH_PASSWORD;
}

export function isAuthenticated(cookieValue: string | undefined): boolean {
  return cookieValue === AUTH_TOKEN;
}
