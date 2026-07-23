import type { NextConfig } from "next";
import packageJson from "./package.json";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Required for production Docker image (copies server.js + traced deps).
  output: "standalone",
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
    NEXT_PUBLIC_APP_VERSION: packageJson.version
  },
  /**
   * Security / Lighthouse best-practices headers.
   * Document HTML is private (auth desk) but allows bfcache-friendly revalidation;
   * API routes still set no-store themselves.
   */
  async headers() {
    // Tight CSP for Next standalone (inline theme boot + React). No third-party scripts.
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
      "upgrade-insecure-requests"
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
      }
    ];
  }
};

export default nextConfig;
