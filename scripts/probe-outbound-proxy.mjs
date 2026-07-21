#!/usr/bin/env node
/**
 * Probe OUTBOUND_HTTPS_PROXY against Bonbast (same stack as production http.ts).
 * Usage:
 *   OUTBOUND_HTTPS_PROXY=http://user:pass@host:2053 node scripts/probe-outbound-proxy.mjs
 */
import { HttpsProxyAgent } from "https-proxy-agent";
import https from "node:https";

const proxy =
  process.env.OUTBOUND_HTTPS_PROXY?.trim() ||
  process.env.HTTPS_PROXY?.trim() ||
  process.env.HTTP_PROXY?.trim() ||
  "";

if (!proxy) {
  console.error("Set OUTBOUND_HTTPS_PROXY first (see .env.example)");
  process.exit(2);
}

// Redact password in logs
const redacted = proxy.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@");
console.log("proxy:", redacted);

const agent = new HttpsProxyAgent(proxy);
const url = "https://bonbast.com/";

const started = Date.now();
const req = https.request(
  url,
  {
    method: "GET",
    agent,
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      accept: "text/html",
      "accept-language": "fa-IR,fa;q=0.9"
    }
  },
  (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const ms = Date.now() - started;
      console.log("status:", res.statusCode);
      console.log("bytes:", body.length);
      console.log("ms:", ms);
      const hasParam = /param\s*[:=]\s*"/.test(body);
      console.log("bonbast_param_in_html:", hasParam);
      if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 400 && body.length > 1000) {
        console.log("OK: proxy reaches bonbast.com");
        process.exit(0);
      }
      console.error("FAIL: unexpected response");
      process.exit(1);
    });
  }
);
req.on("error", (err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
req.setTimeout(25_000, () => {
  req.destroy();
  console.error("FAIL: timeout");
  process.exit(1);
});
req.end();
