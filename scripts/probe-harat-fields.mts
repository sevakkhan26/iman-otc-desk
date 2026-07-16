/**
 * Probe raw Navasan/Bonbast fields related to Harat USD.
 * Run: npx tsx scripts/probe-harat-fields.mts
 */
import { BROWSER_UA, fetchPageWithCookies, fetchPostForm, fetchText } from "../src/lib/http.ts";

const FETCH_TIMEOUT_MS = 20_000;
const NAVASAN_CSRF_PREFIX = "2bba8a6abdcae9571d63fefcd1df29bb3a8f5d91http://www.navasan.net/54tf%f";

function extractPhpSessionId(cookies: string, html = ""): string | null {
  const match = `${cookies}\n${html}`.match(/(?:^|;\s*)PHPSESSID=([^;]+)/i);
  return match?.[1]?.trim() || null;
}

function navasanCsrfToken(sessionId: string): string {
  return Buffer.from(`${NAVASAN_CSRF_PREFIX}${sessionId}`, "utf8").toString("base64");
}

async function probeNavasan() {
  console.log("\n=== NAVASAN ===");
  const { cookies: pageCookies, html } = await fetchPageWithCookies("https://www.navasan.net/", FETCH_TIMEOUT_MS);
  const sessionId = extractPhpSessionId(pageCookies, html);
  let cookies = pageCookies;
  if (sessionId && !cookies.includes("PHPSESSID")) cookies = `${cookies}; PHPSESSID=${sessionId}`;

  const urls = [
    `https://www.navasan.net/initrates.php?_=${Date.now()}`,
    sessionId
      ? `https://www.navasan.net/initrates.php?csrf=${encodeURIComponent(navasanCsrfToken(sessionId))}&_=${Date.now()}`
      : null
  ].filter(Boolean) as string[];

  let text = "";
  for (const url of urls) {
    try {
      text = await fetchText(url, FETCH_TIMEOUT_MS, {
        headers: {
          "user-agent": BROWSER_UA,
          accept: "text/javascript, application/javascript, application/json, text/html, */*;q=0.8",
          referer: "https://www.navasan.net/",
          "x-requested-with": "XMLHttpRequest",
          cookie: cookies
        }
      });
      if (text.includes("lastrates") || text.trim().startsWith("{")) break;
    } catch (e) {
      console.log("navasan fetch fail", url, e instanceof Error ? e.message : e);
    }
  }

  let rates: Record<string, { value?: string | number; date?: number }> = {};
  const m = text.match(/var\s+lastrates\s*=\s*(\{[\s\S]*?\});/);
  if (m) rates = JSON.parse(m[1]!) as typeof rates;
  else if (text.trim().startsWith("{")) rates = JSON.parse(text) as typeof rates;

  const keys = Object.keys(rates).filter((k) => /harat|herat|dolar|usd|afg|afn|naghdi/i.test(k));
  keys.sort();
  console.log("matching keys:", keys);
  for (const k of keys) {
    console.log(`  ${k}:`, rates[k]);
  }
  console.log("pair check harat_naghdi:", {
    sell: rates.harat_naghdi_sell,
    buy: rates.harat_naghdi_buy
  });
  console.log("pair check dolar_harat:", {
    sell: rates.dolar_harat_sell,
    buy: rates.dolar_harat_buy
  });
}

async function probeBonbast() {
  console.log("\n=== BONBAST ===");
  const { html, cookies } = await fetchPageWithCookies("https://bonbast.com/", FETCH_TIMEOUT_MS);
  const paramMatch =
    html.match(/param:\s*"([^"]+)"/) || html.match(/param\s*=\s*"([^"]+)"/) || html.match(/"param"\s*:\s*"([^"]+)"/);
  const param = paramMatch?.[1];
  if (!param) {
    console.log("no param found");
    return;
  }
  const payload = await fetchPostForm<Record<string, unknown>>(
    "https://bonbast.com/json",
    { param },
    FETCH_TIMEOUT_MS,
    {
      headers: {
        cookie: cookies,
        referer: "https://bonbast.com/",
        "x-requested-with": "XMLHttpRequest",
        accept: "application/json, text/plain, */*;q=0.8",
        "user-agent": BROWSER_UA
      }
    }
  );
  const keys = Object.keys(payload).sort();
  console.log("all keys:", keys.join(", "));
  const interesting = keys.filter((k) => /harat|herat|usd|afg|afn|dollar/i.test(k));
  console.log("interesting:");
  for (const k of interesting) console.log(`  ${k}:`, payload[k]);
  // dump raw for evidence
  console.log("usd1/usd2:", payload.usd1, payload.usd2);
}

async function main() {
  try {
    await probeNavasan();
  } catch (e) {
    console.error("navasan error", e);
  }
  try {
    await probeBonbast();
  } catch (e) {
    console.error("bonbast error", e);
  }
}

main();
