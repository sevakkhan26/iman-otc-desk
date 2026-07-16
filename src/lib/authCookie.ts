/**
 * Shared auth cookie identity + protocol-aware Secure flag.
 * Secure must follow the real request protocol (or x-forwarded-proto), never NODE_ENV alone.
 */
import { AUTH_COOKIE, COOKIE_MAX_AGE_S } from "@/lib/auth";

export { AUTH_COOKIE, COOKIE_MAX_AGE_S };

/** Existing cookie name — do not change. */
export const AUTH_COOKIE_NAME = AUTH_COOKIE;

export const AUTH_COOKIE_PATH = "/";
export const AUTH_COOKIE_HTTP_ONLY = true;
export const AUTH_COOKIE_SAME_SITE = "lax" as const;
/** No Domain attribute is configured for this app. */
export const AUTH_COOKIE_DOMAIN: string | undefined = undefined;

export const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private"
} as const;

/** Minimal request shape so helpers stay testable without a full NextRequest. */
export type AuthRequestLike = {
  headers: { get(name: string): string | null };
  nextUrl?: { protocol?: string };
};

/**
 * Detect HTTPS from x-forwarded-proto (proxy/Docker) or the request URL protocol.
 * NODE_ENV is intentionally ignored.
 */
export function isHttpsRequest(request: AuthRequestLike): boolean {
  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();

  if (forwardedProto) {
    return forwardedProto === "https";
  }

  return request.nextUrl?.protocol === "https:";
}

export type AuthCookieBaseOptions = {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  secure: boolean;
  /** Only set when a Domain attribute is configured. */
  domain?: string;
};

export type AuthCookieSetOptions = AuthCookieBaseOptions & {
  maxAge: number;
};

export type AuthCookieClearOptions = AuthCookieBaseOptions & {
  maxAge: 0;
  expires: Date;
};

function baseOptions(request: AuthRequestLike): AuthCookieBaseOptions {
  const options: AuthCookieBaseOptions = {
    httpOnly: AUTH_COOKIE_HTTP_ONLY,
    sameSite: AUTH_COOKIE_SAME_SITE,
    path: AUTH_COOKIE_PATH,
    secure: isHttpsRequest(request)
  };
  if (AUTH_COOKIE_DOMAIN) {
    options.domain = AUTH_COOKIE_DOMAIN;
  }
  return options;
}

/** Options for creating the session cookie after successful login. */
export function authCookieSetOptions(
  request: AuthRequestLike,
  maxAge: number = COOKIE_MAX_AGE_S
): AuthCookieSetOptions {
  return {
    ...baseOptions(request),
    maxAge
  };
}

/** Options for deleting the session cookie on logout (same identity as set). */
export function authCookieClearOptions(request: AuthRequestLike): AuthCookieClearOptions {
  return {
    ...baseOptions(request),
    maxAge: 0,
    expires: new Date(0)
  };
}

/** Shared identity fields that login and logout must keep identical. */
export function authCookieIdentity(request: AuthRequestLike) {
  const base = baseOptions(request);
  return {
    name: AUTH_COOKIE_NAME,
    path: base.path,
    httpOnly: base.httpOnly,
    sameSite: base.sameSite,
    secure: base.secure,
    domain: base.domain
  };
}
