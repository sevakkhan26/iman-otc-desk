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
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'"
    ].join("; ");

    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: csp },
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
