#!/usr/bin/env npx tsx
/**
 * Browser-level typography test for the Shadow Arbitrage interface.
 *
 *   pnpm test:fonts
 *
 * Static scans cannot prove what a browser actually resolves, so this boots the
 * production build, opens the real route in Chrome and reads
 * `getComputedStyle(...).fontFamily` off every Shadow surface and form control
 * — headings, panels, tables, filters, inputs, selects, buttons, chips,
 * pagination, venue cards, the drawer and the mobile card layout.
 *
 * It asserts two things per element:
 *   1. the resolved family list starts with IRANYekan — the project's existing
 *      self-hosted face, never a Shadow-specific stack;
 *   2. that face is really loaded (`document.fonts.check`), so a silent
 *      fallback to a system font fails the test instead of passing quietly.
 *
 * Nothing here imports a font, adds an @font-face rule or touches the app.
 */
import { preparePage, startPreviewApp } from "./previewRuntime.mts";

const EXPECTED = "IRANYekan";

/**
 * Where to look, and what each selector represents. `only` marks the surfaces
 * that exist on one tab: the filter rail belongs to Opportunities, the venue
 * cards to Sources.
 */
type Target = { label: string; selector: string; only?: "opportunities" | "sources" };

const TARGETS: Target[] = [
  { label: "ریشهٔ صفحهٔ سایه", selector: ".sa-page" },
  { label: "عنوان پنل", selector: ".panel-title" },
  { label: "بدنهٔ پنل", selector: ".panel-body" },
  { label: "کارت KPI", selector: ".sa-kpi-value" },
  { label: "برچسب KPI", selector: ".sa-kpi-label" },
  { label: "کنترل بخش‌بندی", selector: ".sa-seg" },
  { label: "برچسب فیلتر", selector: ".sa-field-label", only: "opportunities" },
  { label: "ورودی جست‌وجو", selector: ".sa-control[type=search]", only: "opportunities" },
  { label: "فهرست کشویی", selector: "select.sa-control", only: "opportunities" },
  { label: "چیپ فیلتر", selector: ".sa-chip-toggle", only: "opportunities" },
  { label: "دکمهٔ پاک‌کردن", selector: ".sa-btn-clear", only: "opportunities" },
  { label: "دکمهٔ جزئیات", selector: ".sa-btn-details" },
  { label: "دکمهٔ صفحه‌بندی", selector: ".sa-btn-page" },
  { label: "شمارندهٔ صفحه‌بندی", selector: ".sa-pager-count" },
  { label: "چیپ وضعیت", selector: ".sa-chip" },
  { label: "سلول جدول", selector: ".sa-table td", only: "sources" },
  { label: "سرستون جدول", selector: ".sa-table th", only: "sources" },
  { label: "جدول فرصت‌ها", selector: ".sa-op-table td", only: "opportunities" },
  { label: "کارت موبایل فرصت", selector: ".sa-op-card", only: "opportunities" },
  { label: "کارت صرافی", selector: ".sa-venue-card", only: "sources" },
  { label: "برچسب سنجهٔ صرافی", selector: ".sa-venue-metric-label", only: "sources" },
  { label: "کشوی محاسبه", selector: ".sa-drawer", only: "opportunities" }
];

type Sample = { label: string; selector: string; family: string; found: boolean };

const VIEWS = [
  { name: "desktop", width: 1440, height: 950, mobile: false },
  { name: "mobile", width: 390, height: 1400, mobile: true }
] as const;

const TABS = ["opportunities", "sources"] as const;

let failed = 0;

function check(view: string, tab: string, sample: Sample) {
  const first = sample.family.split(",")[0]?.trim().replace(/^["']|["']$/g, "") ?? "";
  if (!sample.found) {
    console.log(`  FAIL  ${view}/${tab} · ${sample.label} — not present in the DOM`);
    failed += 1;
    return;
  }
  if (first !== EXPECTED) {
    console.log(`  FAIL  ${view}/${tab} · ${sample.label} → «${sample.family}»`);
    failed += 1;
    return;
  }
  console.log(`  PASS  ${view}/${tab} · ${sample.label}`);
}

async function main() {
  const app = await startPreviewApp({ seed: true });

  try {
    for (const view of VIEWS) {
      for (const tab of TABS) {
        const cdp = await app.newPage();
        await preparePage(cdp, app, { ...view, theme: "light" });
        // The accounts dataset carries the settlement chips and the fee form.
        const url = `http://127.0.0.1:${app.port}/shadow-arbitrage?tab=${tab}${
          tab === "sources" ? "&sv=accounts" : ""
        }`;
        await cdp.send("Page.navigate", { url });
        await new Promise((r) => setTimeout(r, 6_000));

        // Open one calculation drawer so it is measured too.
        if (tab === "opportunities") {
          await cdp.send("Runtime.evaluate", {
            expression: `document.querySelector(".sa-btn-details")?.click()`
          });
          await new Promise((r) => setTimeout(r, 800));
        }

        // Wait for font loading to settle before asking whether the face is there.
        const loaded = await cdp.send<{ result: { value: boolean } }>("Runtime.evaluate", {
          expression: `document.fonts.ready.then(() => document.fonts.check('700 16px "${EXPECTED}"'))`,
          returnByValue: true,
          awaitPromise: true
        });
        if (!loaded.result.value) {
          console.log(`  FAIL  ${view.name}/${tab} · «${EXPECTED}» is not loaded in the browser`);
          failed += 1;
        } else {
          console.log(`  PASS  ${view.name}/${tab} · «${EXPECTED}» is loaded`);
        }

        const scoped = TARGETS.filter((t) => !t.only || t.only === tab);
        const probe = `JSON.stringify(${JSON.stringify(scoped)}.map((t) => {
          const el = document.querySelector(t.selector);
          return {
            label: t.label,
            selector: t.selector,
            found: Boolean(el),
            family: el ? getComputedStyle(el).fontFamily : ""
          };
        }))`;
        const result = await cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
          expression: probe,
          returnByValue: true
        });
        const samples = JSON.parse(result.result.value) as Sample[];
        for (const sample of samples) check(view.name, tab, sample);

        cdp.close();
      }
    }
  } finally {
    await app.stop();
  }

  console.log(`\nResult: ${failed === 0 ? "every Shadow surface resolves to IRANYekan" : `${failed} failed`}\n`);
  if (failed) process.exit(1);
}

await main();
