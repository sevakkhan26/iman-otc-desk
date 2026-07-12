// Edge-safe auth helpers (middleware + shared constants).

export const AUTH_COOKIE = "otc-auth";

export type DeskRole = "admin" | "viewer";

const SESSION_TOKENS: Record<DeskRole, string> = {
  admin: "otc-desk-session-admin-9f2c41ab7d5e",
  viewer: "otc-desk-session-viewer-8e1b30bc6c4f"
};

const TOKEN_TO_ROLE = new Map<string, DeskRole>(
  (Object.entries(SESSION_TOKENS) as Array<[DeskRole, string]>).map(([role, token]) => [token, role])
);

export function sessionTokenForRole(role: DeskRole): string {
  return SESSION_TOKENS[role];
}

export function getRoleFromCookie(value: string | undefined): DeskRole | null {
  if (!value) return null;
  return TOKEN_TO_ROLE.get(value) ?? null;
}

export function isAuthenticated(cookieValue: string | undefined): boolean {
  return getRoleFromCookie(cookieValue) !== null;
}

export function isAdminRole(role: DeskRole | null): role is "admin" {
  return role === "admin";
}