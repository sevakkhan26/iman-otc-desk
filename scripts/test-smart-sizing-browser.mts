#!/usr/bin/env npx tsx
/**
 * Browser acceptance for the SMART_CAPITAL_DEPTH sizing panel.
 *
 *   npm run test:smart-sizing-browser
 *
 * A static scan cannot prove what a browser renders, so this boots the real
 * production build against a throwaway database seeded with a 10B session and
 * demonstration risk values, opens the Command Center in Chrome, and reads the
 * rendered text back.
 *
 * It checks three things a screenshot cannot:
 *   1. every figure the phase promised is actually on screen — the selected
 *      volume, the limiting venue balance, the capital cap, the depth cap, the
 *      two-leg VWAP, the risk-adjusted PnL and return, the inventory effect,
 *      the exact reason the next larger size was rejected, the policy name, and
 *      the fixed ladder as a NON-EXECUTABLE baseline;
 *   2. the desktop table and the mobile cards swap at the breakpoint, and both
 *      exist — a phone never gets a sideways-scrolling eight-column table;
 *   3. the page itself never scrolls sideways at 1920, 1440, 1024, 768 or 390,
 *      in light and in dark.
 *
 * Screenshots are written for the review. Nothing here touches production, the
 * local database, a credential, or any exchange.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Cdp, log, preparePage, repoRoot, startPreviewApp } from "./previewRuntime.mts";

const OUT_DIR = process.env.PREVIEW_OUT ?? path.join(repoRoot, "preview-out", "smart-sizing");

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed += 1;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
}

/** The five production widths, light and dark. */
const WIDTHS = [1920, 1440, 1024, 768, 390] as const;
const THEMES = ["light", "dark"] as const;

/** Every label the phase promised on screen, in the panel it belongs to. */
const REQUIRED_TEXT = [
  "SMART_CAPITAL_DEPTH",
  "حجم محاسبه‌شده",
  "موجودی محدودکننده",
  "سقف سرمایه",
  "سقف عمق",
  "VWAP دو پا",
  "سود خالص تعدیل‌شده",
  "حاشیهٔ تعدیل‌شده",
  "اثر بر موجودی",
  "چرا حجم بزرگ‌تر نه؟"
];

/** Labels that live inside the folded calculation disclosure. */
const REQUIRED_DETAIL_TEXT = [
  "نامزدهای حجم",
  "٪ ظرفیت",
  "بازده (bps)",
  "اثر موجودی",
  "مبنای مقایسه",
  "FIXED_PROBE_LADDER",
  "اجرا نمی‌شود",
  "حجم ثابت (تتر)"
];

const evaluate = async <T>(cdp: Cdp, expression: string, awaitPromise = false): Promise<T> => {
  const r = await cdp.send<{ result: { value: T } }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise
  });
  return r.result.value;
};

/** Open every disclosure, because collapsed content has no rendered text. */
const OPEN_DISCLOSURES = `
  document.querySelectorAll("details").forEach((d) => { d.open = true; });
  "opened " + document.querySelectorAll("details[open]").length
`;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const app = await startPreviewApp({
    seed: true,
    seedScript: "scripts/preview-seed-smart-sizing.mts",
    port: Number(process.env.PREVIEW_PORT ?? 3191),
    debugPort: Number(process.env.PREVIEW_DEBUG_PORT ?? 9337)
  });

  try {
    /* ── 1. the API actually decided something ───────────────────────────── */
    const cdp = await app.newPage();
    await preparePage(cdp, app, { width: 1440, height: 1000, theme: "light", mobile: false });
    await cdp.send("Page.navigate", {
      url: `http://127.0.0.1:${app.port}/shadow-arbitrage?tab=command`
    });
    await new Promise((r) => setTimeout(r, 7_000));

    const payload = await evaluate<string>(
      cdp,
      `fetch("/api/shadow-arbitrage/paper", { credentials: "include" })
         .then((r) => r.json())
         .then((j) => {
           const s = j.data?.sizing ?? j.sizing ?? {};
           const sized = (s.routes ?? []).filter((r) => r.sizing.status === "SIZED");
           const best = sized.sort(
             (a, b) =>
               (b.sizing.economics?.riskAdjustedPnlToman ?? 0) -
               (a.sizing.economics?.riskAdjustedPnlToman ?? 0)
           )[0] ?? null;
           return JSON.stringify({
             policy: s.policy ?? null,
             parameters: s.policyParameters ?? null,
             baselineExecutable: s.baselineExecutable,
             missingPolicies: s.missingPolicies ?? [],
             routes: (s.routes ?? []).length,
             sizedRoutes: sized.length,
             best: best && {
               routeKey: best.routeKey,
               sizeUsdt: best.sizing.sizeUsdt,
               policy: best.sizing.policy,
               binding: best.sizing.bindingConstraint,
               limitingSide: best.sizing.capacity?.limitingSide,
               limitingUsable: best.sizing.capacity?.limitingUsableMicros,
               capitalCap: best.sizing.capacity?.capitalCapMicros,
               depthCap: best.sizing.capacity?.depthCapMicros,
               bps: best.sizing.economics?.riskAdjustedReturnBps,
               inventory: best.sizing.inventory?.impactPoints,
               candidates: (best.sizing.candidates ?? []).length,
               nextLarger: best.sizing.selection?.nextLarger?.code ?? null,
               baselineBest: best.sizing.baseline?.bestRiskAdjustedPnlToman ?? null,
               baselineExecutable: best.sizing.baseline?.executable
             }
           });
         })
         .catch((e) => JSON.stringify({ error: String(e) }))`,
      true
    );
    const api = JSON.parse(payload) as Record<string, unknown>;
    const best = api.best as Record<string, unknown> | null;

    check("the API names the sizing policy", api.policy === "SMART_CAPITAL_DEPTH", String(api.policy));
    check("no required risk policy is missing in the fixture", (api.missingPolicies as string[]).length === 0);
    check("at least one route produced a size", (api.sizedRoutes as number) > 0, JSON.stringify(api));
    check("the fixed ladder is flagged non-executable", api.baselineExecutable === false);

    if (best) {
      check("the fill carries the policy name", best.policy === "SMART_CAPITAL_DEPTH");
      check(
        "the chosen size is not a fixed probe size",
        ![5, 10, 20, 25].includes(best.sizeUsdt as number),
        `size=${best.sizeUsdt}`
      );
      check("the limiting side is reported", best.limitingSide === "buy" || best.limitingSide === "sell");
      check("the capital cap is measured", (best.capitalCap as number) > 0);
      check("the depth cap is measured", (best.depthCap as number) > 0);
      check("the return is reported in bps", typeof best.bps === "number");
      check("the inventory effect is measured", typeof best.inventory === "number");
      check("several candidates were evaluated", (best.candidates as number) >= 2);
      check("the baseline is priced too", typeof best.baselineBest === "number");
      check("the baseline is not executable", best.baselineExecutable === false);
      log(
        `best route ${best.routeKey}: ${best.sizeUsdt} USDT, ${best.bps} bps, ` +
          `binding=${best.binding}, nextLarger=${best.nextLarger}`
      );
    }

    /* ── 2. the labels are really on screen ──────────────────────────────── */
    await evaluate<string>(cdp, OPEN_DISCLOSURES);
    await new Promise((r) => setTimeout(r, 1_000));
    const desktopText = await evaluate<string>(
      cdp,
      `document.querySelector(".sa-cc")?.innerText ?? ""`
    );
    for (const needle of [...REQUIRED_TEXT, ...REQUIRED_DETAIL_TEXT]) {
      check(`desktop shows «${needle}»`, desktopText.includes(needle));
    }

    const desktopLayout = await evaluate<string>(
      cdp,
      `JSON.stringify({
         tables: [...document.querySelectorAll(".sa-sz-desktop")]
           .filter((el) => getComputedStyle(el).display !== "none").length,
         cards: [...document.querySelectorAll(".sa-sz-cards")]
           .filter((el) => getComputedStyle(el).display !== "none").length,
         cardCount: document.querySelectorAll(".sa-sz-card").length,
         rows: document.querySelectorAll(".sa-sz-desktop tbody tr").length
       })`
    );
    const dl = JSON.parse(desktopLayout) as Record<string, number>;
    check("desktop renders the candidate tables", dl.tables >= 2, desktopLayout);
    check("desktop hides the mobile cards", dl.cards === 0, desktopLayout);
    check("the candidate table has rows", dl.rows >= 4, desktopLayout);
    cdp.close();

    /* ── 3. mobile cards replace the tables ──────────────────────────────── */
    const mob = await app.newPage();
    await preparePage(mob, app, { width: 390, height: 1400, theme: "light", mobile: true });
    await mob.send("Page.navigate", {
      url: `http://127.0.0.1:${app.port}/shadow-arbitrage?tab=command`
    });
    await new Promise((r) => setTimeout(r, 7_000));
    await evaluate<string>(mob, OPEN_DISCLOSURES);
    await new Promise((r) => setTimeout(r, 1_000));

    const mobileLayout = await evaluate<string>(
      mob,
      `JSON.stringify({
         tables: [...document.querySelectorAll(".sa-sz-desktop")]
           .filter((el) => getComputedStyle(el).display !== "none").length,
         cards: [...document.querySelectorAll(".sa-sz-cards")]
           .filter((el) => getComputedStyle(el).display !== "none").length,
         cardCount: document.querySelectorAll(".sa-sz-card").length,
         heads: [...document.querySelectorAll(".sa-sz-card-head")]
           .map((el) => Math.round(el.getBoundingClientRect().height))
       })`
    );
    const ml = JSON.parse(mobileLayout) as { tables: number; cards: number; cardCount: number; heads: number[] };
    check("mobile hides the desktop tables", ml.tables === 0, mobileLayout);
    check("mobile renders the card lists", ml.cards >= 2, mobileLayout);
    check("mobile renders one card per row", ml.cardCount >= 4, mobileLayout);
    check(
      "mobile card headers stay tappable (36px)",
      ml.heads.length > 0 && ml.heads.every((h) => h >= 36),
      mobileLayout
    );

    const mobileText = await evaluate<string>(mob, `document.querySelector(".sa-cc")?.innerText ?? ""`);
    for (const needle of [...REQUIRED_TEXT, "مبنای مقایسه", "اجرا نمی‌شود"]) {
      check(`mobile shows «${needle}»`, mobileText.includes(needle));
    }
    mob.close();

    /* ── 4. no horizontal overflow, at every width, in both themes ───────── */
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        const page = await app.newPage();
        await preparePage(page, app, {
          width,
          height: width <= 430 ? 1200 : 1100,
          theme,
          mobile: width <= 430
        });
        await page.send("Page.navigate", {
          url: `http://127.0.0.1:${app.port}/shadow-arbitrage?tab=command`
        });
        await new Promise((r) => setTimeout(r, 6_000));
        await page.send("Runtime.evaluate", {
          expression: `document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)})`
        });
        await evaluate<string>(page, OPEN_DISCLOSURES);
        await new Promise((r) => setTimeout(r, 1_200));
        // Frame the sizing panel itself rather than the top of the page.
        await evaluate<string>(
          page,
          `document.querySelector(".sa-cc-best")?.scrollIntoView({ block: "start" }), "ok"`
        );
        await new Promise((r) => setTimeout(r, 600));

        const measured = await evaluate<string>(
          page,
          `JSON.stringify({
             client: document.documentElement.clientWidth,
             scroll: document.documentElement.scrollWidth,
             bodyScroll: document.body.scrollWidth,
             /* Any element wider than the viewport that is NOT inside an
                intentional scroll container is real overflow. */
             wide: [...document.querySelectorAll(".sa-cc *")]
               .filter((el) => el.getBoundingClientRect().width > document.documentElement.clientWidth + 1)
               .filter((el) => !el.closest(".sa-table-wrap"))
               .map((el) => el.className || el.tagName)
               .slice(0, 5)
           })`
        );
        const m = JSON.parse(measured) as {
          client: number;
          scroll: number;
          bodyScroll: number;
          wide: string[];
        };
        check(
          `${width}px ${theme}: the page does not scroll sideways`,
          m.scroll <= m.client + 1 && m.bodyScroll <= m.client + 1,
          `client=${m.client} scroll=${m.scroll} body=${m.bodyScroll}`
        );
        check(
          `${width}px ${theme}: nothing overflows outside a scroll container`,
          m.wide.length === 0,
          m.wide.join(" | ")
        );

        /*
         * The visible viewport only. A full-page capture of this screen with
         * every disclosure open is tens of thousands of pixels tall at a 2x
         * scale factor, and encoding it stalls the CDP call rather than
         * failing — which reads as a hang, not as a slow screenshot.
         */
        const { data } = await page.send<{ data: string }>("Page.captureScreenshot", {
          format: "png"
        });
        const file = path.join(OUT_DIR, `smart-sizing-${width}-${theme}.png`);
        await writeFile(file, Buffer.from(data, "base64"));
        log(`captured ${width}px ${theme} → ${file}`);
        page.close();
      }
    }
  } finally {
    await app.stop();
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  if (failed) process.exit(1);
}

await main();
