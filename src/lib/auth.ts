// Edge-safe auth constants and shared types.

export const AUTH_COOKIE = "otc-auth";

export const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60; // 30 days

export type DeskRole = "admin" | "viewer";

export type SessionClaims = {
  u: string;
  r: DeskRole;
  iat: number;
  exp: number;
  /**
   * Viewer password/session epoch at login time.
   * Admin tokens use 0. Mismatch with store → session invalid (password rotated).
   */
  pv?: number;
};

export const INVALID_CREDENTIALS_MESSAGE = "نام کاربری یا رمز عبور اشتباه است";

export function isAdminRole(role: DeskRole | null): role is "admin" {
  return role === "admin";
}