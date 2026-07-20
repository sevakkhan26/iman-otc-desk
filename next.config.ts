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
  }
};

export default nextConfig;
