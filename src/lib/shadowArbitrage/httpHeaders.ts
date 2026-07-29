/**
 * Response headers for Shadow Arbitrage endpoints.
 *
 * Every response is admin-only and must never be cached by a browser, a shared
 * cache, or the ArvanCloud/CDN edge in front of production. `private` keeps
 * shared caches out even if an intermediary ignores `no-store`, and `Vary: Cookie`
 * makes it impossible for an authenticated response to be served to a different
 * session.
 */
export const SHADOW_NO_STORE = {
  "cache-control": "private, no-store, no-cache, must-revalidate, max-age=0",
  pragma: "no-cache",
  expires: "0",
  vary: "Cookie",
  // Belt and braces for CDNs that honour their own directives.
  "cdn-cache-control": "no-store",
  "surrogate-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "content-type": "application/json; charset=utf-8"
} as const;
