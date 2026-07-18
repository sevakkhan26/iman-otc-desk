/**
 * Live probe for OK-EX + Tetherland (safe diagnostics only — no secrets).
 * Run: npx tsx scripts/probe-okex-tetherland.mts
 */
import { parseOkexIrSpotBook, parseTetherlandUsdtBook } from "../src/lib/providers/domestic.ts";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function probe(name: string, url: string, headers: Record<string, string>) {
  const started = Date.now();
  try {
    const res = await fetch(url, { headers, cache: "no-store", redirect: "follow" });
    const text = await res.text();
    const ctype = res.headers.get("content-type");
    const bodyPreview = text.slice(0, 180).replace(/\s+/g, " ");
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* ignore */
    }
    console.log(
      JSON.stringify(
        {
          name,
          hostPath: new URL(url).host + new URL(url).pathname,
          httpStatus: res.status,
          contentType: ctype,
          ms: Date.now() - started,
          bodyPreview,
          ok: res.ok
        },
        null,
        2
      )
    );
    return { status: res.status, parsed, text };
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          name,
          hostPath: new URL(url).host + new URL(url).pathname,
          error: error instanceof Error ? error.message : String(error),
          ms: Date.now() - started
        },
        null,
        2
      )
    );
    return null;
  }
}

async function main() {
  console.log("=== OK-EX probes ===");
  const okexHeaders = {
    "user-agent": BROWSER_UA,
    accept: "application/json",
    origin: "https://ok-ex.io",
    referer: "https://ok-ex.io/trade/USDT-IRT"
  };
  const book = await probe(
    "okex-spot-book",
    "https://api.ok-ex.io/api/v1/spot/public/books?symbol=USDT-IRT&limit=5",
    okexHeaders
  );
  if (book?.parsed) {
    const n = parseOkexIrSpotBook(book.parsed);
    console.log(
      JSON.stringify(
        {
          name: "okex-normalized",
          buyPrice: n?.buyPrice ?? null,
          sellPrice: n?.sellPrice ?? null,
          midPrice: n ? (n.buyPrice + n.sellPrice) / 2 : null,
          status: n ? "available" : "unavailable"
        },
        null,
        2
      )
    );
  }
  await probe("okex-spot-book-sapi", "https://sapi.ok-ex.io/api/v1/spot/public/books?symbol=USDT-IRT&limit=5", okexHeaders);
  await probe("okex-otc-tickers", "https://azapi.ok-ex.io/api/v1/asset/otc/tickers", okexHeaders);

  console.log("\n=== Tetherland probes ===");
  const tlHeaders = {
    "user-agent": BROWSER_UA,
    accept: "application/json",
    origin: "https://tetherland.com",
    referer: "https://tetherland.com/"
  };
  const market = await probe("tetherland-market-prices", "https://market.tetherland.com/prices", tlHeaders);
  const currencies = await probe("tetherland-currencies", "https://api.tetherland.com/currencies", tlHeaders);
  let anchor: number | null = null;
  if (currencies?.parsed && typeof currencies.parsed === "object") {
    const p = currencies.parsed as {
      data?: { currencies?: { USDT?: { price?: number } } };
    };
    anchor = p.data?.currencies?.USDT?.price ?? null;
    console.log(
      JSON.stringify(
        {
          name: "tetherland-reference-fields",
          price: p.data?.currencies?.USDT?.price ?? null,
          buy_price: (p.data?.currencies?.USDT as { buy_price?: number } | undefined)?.buy_price ?? null,
          sell_price: (p.data?.currencies?.USDT as { sell_price?: number } | undefined)?.sell_price ?? null,
          note: "when buy_price===sell_price===price → reference only"
        },
        null,
        2
      )
    );
  }
  if (market?.parsed) {
    const n = parseTetherlandUsdtBook(market.parsed, anchor);
    console.log(
      JSON.stringify(
        {
          name: "tetherland-normalized",
          realBidAsk: Boolean(n),
          buyPrice: n?.buyPrice ?? null,
          sellPrice: n?.sellPrice ?? null,
          midPrice: n ? (n.buyPrice + n.sellPrice) / 2 : anchor,
          status: n ? "available" : "degraded-reference-only"
        },
        null,
        2
      )
    );
  }
}

void main();
