import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
/*
 * The public application version is its own file, not package.json's `version`.
 *
 * This release is numbered 4.1.5.0, which is not valid SemVer, and the
 * production image runs `pnpm install --frozen-lockfile` against package.json
 * before the source is copied in — an invalid `version` there would fail the
 * deploy. package.json keeps a valid SemVer for package metadata; version.json
 * is the single authoritative public version the product displays.
 */
import appVersion from "./version.json";

/** Pin project root — parent ~/package-lock.json made Next pick wrong workspace root. */
const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Required for production Docker image (copies server.js + traced deps).
  output: "standalone",
  // Keep tracing/dev root inside this package (not monorepo parent).
  outputFileTracingRoot: projectRoot,
  // Optional isolated cache dir (e.g. OTC_NEXT_DIST=.next-preview) when .next is corrupted.
  ...(process.env.OTC_NEXT_DIST ? { distDir: process.env.OTC_NEXT_DIST } : {}),
  // Keep native/WASM DB drivers unbundled — bundling breaks PGlite path/WASM resolution
  // (TypeError: path argument … Received an instance of URL) under Next.js.
  serverExternalPackages: [
    "@electric-sql/pglite",
    "postgres",
    "drizzle-orm",
    "drizzle-orm/postgres-js",
    "drizzle-orm/pglite"
  ],
  env: {
    NEXT_PUBLIC_APP_VERSION: appVersion.appVersion
  },
  /**
   * Security / Lighthouse best-practices headers.
   * Document HTML is private (auth desk) but allows bfcache-friendly revalidation;
   * API routes still set no-store themselves.
   */
  async headers() {
    // Tight CSP for Next standalone (inline theme boot + React). No third-party scripts.
    // Do NOT set upgrade-insecure-requests: breaks plain HTTP LAN/IP (no TLS on :443).
    // Dev (webpack/React Refresh) needs 'unsafe-eval' or login client JS dies with EvalError.
    const isDev = process.env.NODE_ENV !== "production";
    const scriptSrc = isDev
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self' 'unsafe-inline'";
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      scriptSrc,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "manifest-src 'self'"
    ].join("; ");

    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
          },
          { key: "Content-Security-Policy", value: csp },
          // HTTPS only (behind Caddy/Arvan TLS)
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload"
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          // Prefer revalidate over no-store so authenticated pages can use bfcache when allowed
          { key: "Cache-Control", value: "private, no-cache, must-revalidate" }
        ]
      },
      {
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, private" }
        ]
      },
      {
        // Shadow Arbitrage is admin-only. Never let ArvanCloud/CDN or any shared
        // cache retain an authenticated admin response, and never index it.
        source: "/shadow-arbitrage",
        headers: [
          { key: "Cache-Control", value: "private, no-store, no-cache, must-revalidate, max-age=0" },
          { key: "CDN-Cache-Control", value: "no-store" },
          { key: "Surrogate-Control", value: "no-store" },
          { key: "Vary", value: "Cookie" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" }
        ]
      },
      {
        source: "/shadow-arbitrage/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, no-cache, must-revalidate, max-age=0" },
          { key: "CDN-Cache-Control", value: "no-store" },
          { key: "Surrogate-Control", value: "no-store" },
          { key: "Vary", value: "Cookie" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" }
        ]
      },
      {
        source: "/api/shadow-arbitrage/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, no-cache, must-revalidate, max-age=0" },
          { key: "CDN-Cache-Control", value: "no-store" },
          { key: "Surrogate-Control", value: "no-store" },
          { key: "Vary", value: "Cookie" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" }
        ]
      }
    ];
  }
};

export default nextConfig;
