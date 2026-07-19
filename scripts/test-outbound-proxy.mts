#!/usr/bin/env npx tsx
/**
 * Smoke-test outbound proxy path for Bonbast (no secrets printed).
 * Set OUTBOUND_HTTPS_PROXY before running.
 */
import { shouldUseOutboundProxy } from "../src/lib/http.ts";

const proxy =
  process.env.OUTBOUND_HTTPS_PROXY?.trim() ||
  process.env.HTTPS_PROXY?.trim() ||
  process.env.https_proxy?.trim() ||
  "";

if (!proxy) {
  console.error("Set OUTBOUND_HTTPS_PROXY first (e.g. http://user:pass@host:2053)");
  process.exit(1);
}

// Do not log full proxy URL (may contain password) — only host:port
try {
  const u = new URL(proxy);
  console.log(`proxy host=${u.hostname} port=${u.port || "(default)"} user=${u.username ? "yes" : "no"}`);
} catch {
  console.error("OUTBOUND_HTTPS_PROXY is not a valid URL");
  process.exit(1);
}

console.log("shouldUseOutboundProxy(bonbast.com) =", shouldUseOutboundProxy("bonbast.com"));
console.log("shouldUseOutboundProxy(example.com) =", shouldUseOutboundProxy("example.com"));
console.log("shouldUseOutboundProxy(api.nobitex.ir) =", shouldUseOutboundProxy("api.nobitex.ir"));

const { fetchPageWithCookies } = await import("../src/lib/http.ts");

try {
  const { html, cookies } = await fetchPageWithCookies("https://bonbast.com/", 20_000);
  console.log("bonbast HTML length =", html.length, "cookies =", cookies ? "yes" : "no");
  console.log(html.includes("bonbast") || html.includes("Bonbast") || html.length > 1000 ? "PASS" : "FAIL content");
  process.exit(html.length > 500 ? 0 : 1);
} catch (e) {
  console.error("FAIL", e instanceof Error ? e.message : e);
  process.exit(1);
}
