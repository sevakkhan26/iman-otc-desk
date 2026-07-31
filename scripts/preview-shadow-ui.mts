#!/usr/bin/env npx tsx
/**
 * Shadow UI preview — screenshots of the REAL application.
 *
 *   pnpm preview:shadow
 *
 * It boots the production standalone build and photographs `/shadow-arbitrage`
 * through a real browser. There is no reconstructed shell here: the sidebar,
 * the header, the navigation items and the icons are whatever `Shell.tsx`,
 * `DeskPageHeader.tsx` and `sidebarNav.ts` actually render. This file adds no
 * markup and no CSS of its own — if the shell looks wrong in a screenshot, the
 * application looks wrong.
 *
 * Boot, isolation and the test-only session live in `previewRuntime.mts`.
 *
 * Environment:
 *   PREVIEW_SEED=1      fill the throwaway database with demonstration data
 *   PREVIEW_TABS=a,b    which Shadow tabs to photograph (default: overview);
 *                       a tab may carry its own query, e.g. "sources&sv=accounts"
 *   PREVIEW_VIEWS=x,y   which viewports to use (default: all four)
 *   PREVIEW_HEIGHT=n    override the viewport height, to frame a longer section
 *   PREVIEW_SCROLL_TO=s scroll that CSS selector into view before capturing
 *   PREVIEW_FULLPAGE=1  capture the whole tab instead of the first screen
 *   PREVIEW_MEASURE=1   report page width vs scroll width at every breakpoint
 *   PREVIEW_OUT=dir     where the PNGs go (default: ./preview-out)
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Cdp, log, preparePage, repoRoot, startPreviewApp } from "./previewRuntime.mts";

const OUT_DIR = process.env.PREVIEW_OUT ?? path.join(repoRoot, "preview-out");

/** The production breakpoints this preview is judged at. */
const VIEWPORTS = [
  { name: "desktop-light", width: 1440, height: 900, theme: "light", mobile: false },
  { name: "desktop-dark", width: 1440, height: 900, theme: "dark", mobile: false },
  { name: "mobile-light", width: 390, height: 1200, theme: "light", mobile: true },
  { name: "mobile-dark", width: 390, height: 1200, theme: "dark", mobile: true }
] as const;

/**
 * Tabs to photograph. `PREVIEW_TABS` narrows the list; the default is the tab
 * shell's own default so an unchanged run keeps producing the same four files.
 */
const TABS = (process.env.PREVIEW_TABS ?? "overview")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** `PREVIEW_VIEWS` narrows the viewport list to the ones a review asked for. */
const WANTED_VIEWS = (process.env.PREVIEW_VIEWS ?? "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const HEIGHT_OVERRIDE = Number(process.env.PREVIEW_HEIGHT ?? 0);
const SCROLL_TO = process.env.PREVIEW_SCROLL_TO ?? "";

const SHOTS = TABS.flatMap((tab) =>
  VIEWPORTS.filter((v) => !WANTED_VIEWS.length || WANTED_VIEWS.includes(v.name)).map((v) => ({
    ...v,
    height: HEIGHT_OVERRIDE > 0 ? HEIGHT_OVERRIDE : v.height,
    tab,
    // A single-tab run keeps the historical file names.
    file:
      TABS.length === 1 && tab === "overview"
        ? v.name
        : `${tab.replace(/[^a-z0-9]+/gi, "-")}-${v.name}`
  }))
);

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const app = await startPreviewApp({ seed: process.env.PREVIEW_SEED === "1" });

  try {
    for (const shot of SHOTS) {
      const cdp = await app.newPage();
      await preparePage(cdp, app, shot);

      await cdp.send("Page.navigate", {
        url: `http://127.0.0.1:${app.port}/shadow-arbitrage?tab=${shot.tab}`
      });
      // Let the client mount, resolve the role and settle its first paint.
      await new Promise((r) => setTimeout(r, 6_000));
      await cdp.send("Runtime.evaluate", {
        expression: `document.documentElement.setAttribute("data-theme", ${JSON.stringify(shot.theme)})`
      });
      await new Promise((r) => setTimeout(r, 1_200));

      // Frame a section that sits below the fold, e.g. the pagination controls.
      if (SCROLL_TO) {
        await cdp.send("Runtime.evaluate", {
          expression: `document.querySelector(${JSON.stringify(SCROLL_TO)})?.scrollIntoView({ block: "end" })`
        });
        await new Promise((r) => setTimeout(r, 800));
      }

      const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        // PREVIEW_FULLPAGE=1 captures the whole tab, not just the first screen.
        captureBeyondViewport: process.env.PREVIEW_FULLPAGE === "1"
      });
      const file = path.join(OUT_DIR, `${shot.file}.png`);
      await writeFile(file, Buffer.from(data, "base64"));
      log(`captured ${shot.file} → ${file}`);
      cdp.close();
    }

    /*
     * Objective layout check: the page itself must never scroll sideways at any
     * supported width. Only an inner table or rail may. Reported, not asserted,
     * so a preview run never silently "passes" a broken layout.
     */
    if (process.env.PREVIEW_MEASURE === "1") {
      for (const tab of TABS) {
        for (const width of [1920, 1440, 1024, 768, 390]) {
          const cdp: Cdp = await app.newPage();
          await preparePage(cdp, app, {
            width,
            height: 900,
            theme: "light",
            mobile: width <= 430
          });
          await cdp.send("Page.navigate", {
            url: `http://127.0.0.1:${app.port}/shadow-arbitrage?tab=${tab}`
          });
          await new Promise((r) => setTimeout(r, 5_000));
          const measured = await cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
            expression: `JSON.stringify({
              client: document.documentElement.clientWidth,
              scroll: document.documentElement.scrollWidth,
              bodyScroll: document.body.scrollWidth,
              cards: document.querySelectorAll(".sa-op-card").length,
              tableVisible: [...document.querySelectorAll(".sa-op-table-wrap")]
                .filter((el) => getComputedStyle(el).display !== "none").length,
              pager: [...document.querySelectorAll(".sa-pager")]
                .filter((el) => el.getBoundingClientRect().height > 0).length
            })`,
            returnByValue: true
          });
          log(`measure ${tab} @${width}px → ${measured.result.value}`);
          cdp.close();
        }
      }
    }
  } finally {
    await app.stop();
  }

  log("done — every pixel above came from the real Shell, header and navigation");
}

await main();
