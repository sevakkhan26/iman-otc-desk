import type { NextConfig } from "next";
import packageJson from "./package.json";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Required for production Docker image (copies server.js + traced deps).
  output: "standalone",
  // Optional isolated cache dir (e.g. OTC_NEXT_DIST=.next-preview) when .next is corrupted.
  ...(process.env.OTC_NEXT_DIST ? { distDir: process.env.OTC_NEXT_DIST } : {}),
  env: {
    NEXT_PUBLIC_APP_VERSION: packageJson.version
  }
};

export default nextConfig;
