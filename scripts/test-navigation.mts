#!/usr/bin/env npx tsx
/**
 * Navigation and role-visibility tests for the Shadow Arbitrage header shortcut.
 *
 * Structural: it asserts what the components declare, not how they paint. No
 * browser, no network, no database.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    failed += 1;
  }
}

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const { sidebarNavItems } = await import("../src/lib/sidebarNav.ts");
const { SHADOW_SHORTCUT_HREF, SHADOW_SHORTCUT_LABEL } = await import(
  "../src/components/ShadowArbitrageHeaderButton.tsx"
);
const { SHADOW_TABS, DEFAULT_SHADOW_TAB, parseShadowTab, shadowTabLabel } = await import(
  "../src/components/shadowArbitrage/tabs.ts"
);

await test("Shadow Arbitrage is completely gone from the sidebar", () => {
  assert.equal(
    sidebarNavItems.some((i) => i.href === "/shadow-arbitrage"),
    false,
    "no sidebar item may point at the shadow route"
  );
  assert.equal(
    sidebarNavItems.some((i) => /آربیتراژ/.test(i.label)),
    false,
    "no sidebar label may mention arbitrage"
  );
  // The rest of the rail is untouched, in the same order.
  assert.deepEqual(
    sidebarNavItems.map((i) => i.href),
    ["/dashboard", "/tether-market", "/gold", "/bubble", "/impact-news", "/forex"]
  );
  // Nothing else was silently made admin-only or public.
  assert.equal(sidebarNavItems.some((i) => i.adminOnly), false);
});

await test("the shortcut targets the shadow route with the exact Persian label", () => {
  assert.equal(SHADOW_SHORTCUT_HREF, "/shadow-arbitrage");
  assert.equal(SHADOW_SHORTCUT_LABEL, "آربیتراژ آزمایشی");

  const src = read("src/components/ShadowArbitrageHeaderButton.tsx");
  // aria-label and tooltip both come from the same constant.
  assert.ok(src.includes("label={SHADOW_SHORTCUT_LABEL}"), "aria-label is the Persian label");
  assert.ok(src.includes("tooltip={SHADOW_SHORTCUT_LABEL}"), "tooltip is the Persian label");
  assert.ok(src.includes("href={SHADOW_SHORTCUT_HREF}"), "navigation is a direct link");
});

await test("the shortcut is admin-only and viewers never see it", () => {
  const src = read("src/components/ShadowArbitrageHeaderButton.tsx");
  // The guard returns before rendering anything at all.
  assert.ok(
    /if \(role !== "admin"\) return null;/.test(src),
    "anything other than admin renders nothing"
  );
  const guardIndex = src.indexOf('role !== "admin"');
  const renderIndex = src.indexOf("<GlassIconButton");
  assert.ok(guardIndex > 0 && guardIndex < renderIndex, "the guard precedes the render");

  // The role source is the session endpoint, not a prop a caller could spoof.
  const hook = read("src/hooks/useDeskRole.ts");
  assert.ok(hook.includes('"/api/auth/me"'));
  assert.ok(hook.includes('credentials: "same-origin"'));
  assert.ok(
    hook.includes("not a security boundary") || hook.includes("NOT a security boundary"),
    "the hook states plainly that it is not the security boundary"
  );
});

await test("route and API protection are unchanged by this UI change", () => {
  // Middleware still gates the page and the API for non-admins.
  const middleware = read("middleware.ts");
  assert.ok(middleware.includes('pathname === "/api/shadow-arbitrage"'));
  assert.ok(middleware.includes('pathname.startsWith("/api/shadow-arbitrage/")'));
  assert.ok(middleware.includes('role === "viewer"'), "viewers are refused in middleware");

  // Every shadow API route still requires an admin session.
  for (const r of [
    "health",
    "matrix",
    "observation",
    "analytics",
    "history",
    "accounts",
    "capital",
    "paper",
    "live-readiness"
  ]) {
    const src = read(`app/api/shadow-arbitrage/${r}/route.ts`);
    assert.ok(src.includes("requireAdminSession"), `${r} must remain admin-only`);
  }
});

await test("the shortcut sits in the header action group beside Account", () => {
  const header = read("src/components/DeskPageHeader.tsx");
  assert.ok(header.includes("<ShadowArbitrageHeaderButton />"));

  const group = header.slice(header.indexOf('role="group"'));
  const profile = group.indexOf("<ProfileMenu />");
  const shortcut = group.indexOf("<ShadowArbitrageHeaderButton />");
  const theme = group.indexOf("<ThemeToggleButton />");
  assert.ok(profile > 0 && shortcut > profile, "the shortcut follows the Account button");
  assert.ok(shortcut < theme, "and stays inside the same action group, before Theme");

  // No divider was inserted between Account and the shortcut: they read as a pair.
  const between = group.slice(profile, shortcut);
  assert.equal(between.includes("header-actions-divider"), false);
});

await test("the shortcut reuses the shared glass control, adding no new styling", () => {
  const src = read("src/components/ShadowArbitrageHeaderButton.tsx");
  // Same component the Theme, Account and Alerts controls use.
  assert.ok(src.includes('from "@/components/ui/GlassIconButton"'));
  const theme = read("src/components/ThemeToggleButton.tsx");
  assert.ok(theme.includes('from "@/components/ui/GlassIconButton"'), "same control as Theme");

  // No bespoke class, style or size.
  assert.equal(/className=/.test(src), false, "no custom class");
  assert.equal(/style=\{/.test(src), false, "no inline style");
  assert.equal(/width|height|px/.test(src.replace(/size=\{18\}/g, "")), false, "no custom sizing");

  // The icon is the one the sidebar used, from the library already installed.
  assert.ok(src.includes("GitCompareArrows"));
  assert.ok(src.includes('from "lucide-react"'), "no new icon library");
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  const iconLibs = Object.keys(pkg.dependencies).filter((d) =>
    /icon|heroicons|feather|phosphor|tabler/i.test(d)
  );
  assert.deepEqual(iconLibs, [], "no icon package was added");

  // Icon geometry matches the other header controls exactly.
  assert.ok(src.includes("size={18}") && src.includes("strokeWidth={1.75}"));
  assert.ok(theme.includes("size={18}") && theme.includes("strokeWidth={1.75}"));
});

await test("the active state is the shared restrained one, not a new treatment", () => {
  const src = read("src/components/ShadowArbitrageHeaderButton.tsx");
  assert.ok(src.includes("active={active}"));
  assert.ok(
    src.includes('pathname === SHADOW_SHORTCUT_HREF') &&
      src.includes("startsWith(`${SHADOW_SHORTCUT_HREF}/`)"),
    "active on the page and its subroutes"
  );

  // It resolves to the existing is-active rule; no new CSS was introduced.
  const button = read("src/components/ui/GlassIconButton.tsx");
  assert.ok(button.includes('active && "is-active"'));
  const css = read("app/ios27-design-system.css");
  assert.ok(css.includes(".glass-icon-button.is-active"));
  assert.ok(css.includes(':root[data-theme="dark"] .glass-icon-button.is-active'));
  assert.ok(css.includes("selection rim only"), "restrained: a rim, not a fill");
});

await test("the link variant is a real square control on every breakpoint", () => {
  const css = read("app/ios27-design-system.css");
  const block = css.slice(css.indexOf(".glass-icon-button,\na.glass-icon-button {"));
  const rules = block.slice(0, block.indexOf("}"));
  // Anchors get the identical box as buttons — square, fixed, tap-target sized.
  assert.ok(rules.includes("width: 44px"));
  assert.ok(rules.includes("height: 44px"));
  assert.ok(rules.includes("min-width: 44px"));
  assert.ok(rules.includes("min-height: 44px"));
  assert.ok(rules.includes("border-radius: var(--radius-md)"));

  // The group never wraps or hides controls; it stays on one row and can shrink.
  const globals = read("app/globals.css");
  const group = globals.slice(globals.indexOf(".page-header--desk .header-actions"));
  const groupRules = group.slice(0, group.indexOf("}"));
  assert.ok(groupRules.includes("flex-wrap: nowrap"));
  assert.ok(groupRules.includes("min-width: 0"));

  // Reduced-transparency users still get a solid, visible control.
  assert.ok(css.includes("prefers-reduced-transparency"));
});

await test("no page, layout, API, database or backend logic was touched", () => {
  // The shortcut only navigates; it holds no data logic at all.
  const src = read("src/components/ShadowArbitrageHeaderButton.tsx");
  for (const t of ["fetch(", "useEffect", "useState", "api/shadow-arbitrage"]) {
    assert.equal(src.includes(t), false, `the shortcut must not contain ${t}`);
  }
  // The Shadow page itself still renders exactly what it did.
  const view = read("src/components/ShadowArbitrageView.tsx");
  for (const panel of [
    "ObservationHeader",
    "SummaryCards",
    "OpportunityTable",
    "SourceTable",
    "AccountReadiness",
    "CapitalSimulator",
    "PaperExecution",
    "LiveReadiness"
  ]) {
    assert.ok(view.includes(`<${panel}`), `${panel} must still be on the page`);
  }
  assert.equal(view.includes("ShadowArbitrageHeaderButton"), false, "the page is unaware of it");
});


/* ── Phase 8A — tab shell and Overview presentation ──────────────────────── */

await test("8A the seven tabs exist in order with Persian labels", () => {
  assert.deepEqual(
    SHADOW_TABS.map((t) => t.id),
    ["overview", "opportunities", "sources", "capital", "paper", "live", "analytics"]
  );
  assert.deepEqual(
    SHADOW_TABS.map((t) => t.labelFa),
    [
      "نمای کلی",
      "فرصت‌ها",
      "منابع و کارمزدها",
      "تخصیص سرمایه",
      "اجرای کاغذی",
      "آمادگی اجرای واقعی",
      "تحلیل و تاریخچه"
    ]
  );
  // Every tab carries a Persian one-line explanation for its tooltip.
  for (const t of SHADOW_TABS) {
    assert.ok(t.hintFa.length > 10, `${t.id} needs a hint`);
    assert.equal(/[a-zA-Z]{4,}/.test(t.labelFa), false, "labels are Persian, not codes");
  }
});

await test("8A the default tab is Overview and unknown values fall back to it", () => {
  assert.equal(DEFAULT_SHADOW_TAB, "overview");
  assert.equal(SHADOW_TABS[0].id, DEFAULT_SHADOW_TAB);
  assert.equal(parseShadowTab(null), "overview");
  assert.equal(parseShadowTab(undefined), "overview");
  assert.equal(parseShadowTab(""), "overview");
  assert.equal(parseShadowTab("nope"), "overview");
  assert.equal(parseShadowTab("../etc"), "overview");
  // A known slug round-trips exactly.
  for (const t of SHADOW_TABS) {
    assert.equal(parseShadowTab(t.id), t.id);
    assert.equal(shadowTabLabel(t.id), t.labelFa);
  }
});

await test("8A the tab lives in the URL so back, forward and refresh restore it", () => {
  const view = read("src/components/ShadowArbitrageView.tsx");
  // The selected tab is derived from the query string, never from local state.
  assert.ok(view.includes('parseShadowTab(searchParams.get("tab"))'));
  assert.equal(/useState[^\n]*tab/i.test(view), false, "the tab must not be component state");
  // Selecting writes it back to the URL.
  assert.ok(view.includes('params.set("tab", next)'));
  assert.ok(view.includes("router.replace("));
  assert.ok(view.includes("scroll: false"), "switching tabs must not jump the page");

  // useSearchParams needs a Suspense boundary to build.
  const page = read("app/(desk)/shadow-arbitrage/page.tsx");
  assert.ok(page.includes("<Suspense"));
});

await test("8A every existing section survives, in its correct tab", () => {
  const view = read("src/components/ShadowArbitrageView.tsx");
  const sectionTab: Array<[string, string]> = [
    ["OverviewPanel", "overview"],
    ["SummaryCards", "opportunities"],
    ["OpportunityTable", "opportunities"],
    ["SourceTable", "sources"],
    ["AccountReadiness", "sources"],
    ["CapitalSimulator", "capital"],
    ["PaperExecution", "paper"],
    ["LiveReadiness", "live"],
    ["ObservationHeader", "analytics"],
    ["AnalyticsPanels", "analytics"]
  ];
  for (const [component, tab] of sectionTab) {
    assert.ok(view.includes(`<${component}`), `${component} must still be rendered`);
    const guard = view.lastIndexOf(`tab === "${tab}"`, view.indexOf(`<${component}`));
    assert.ok(guard > 0, `${component} must sit inside the ${tab} tab`);
  }
  // The drawer stays outside the panels so a selected row survives a tab change.
  assert.ok(view.includes("<OpportunityDrawer"));
  const drawerIndex = view.indexOf("<OpportunityDrawer");
  const panelEnd = view.lastIndexOf("</div>");
  assert.ok(drawerIndex < panelEnd + 200, "drawer is rendered at page level");
});

await test("8A the Shadow warning is permanent and the red Live warning is not", () => {
  const view = read("src/components/ShadowArbitrageView.tsx");
  // The compact Shadow warning sits above the tabs, so it shows on every tab.
  const warnIndex = view.indexOf("sa-warning-compact");
  const tabsIndex = view.indexOf("<ShadowTabs");
  assert.ok(warnIndex > 0 && warnIndex < tabsIndex, "the Shadow warning precedes the tabs");
  assert.equal(view.includes("SHADOW_WARNING_FA"), true);

  // The red live banner belongs to LiveReadiness, which only the live tab mounts.
  assert.equal(
    (view.match(/<LiveReadiness/g) ?? []).length,
    1,
    "LiveReadiness is mounted exactly once"
  );
  const liveGuard = view.lastIndexOf('tab === "live"', view.indexOf("<LiveReadiness"));
  assert.ok(liveGuard > 0);
  const ui = read("src/components/shadowArbitrage/LiveReadiness.tsx");
  assert.ok(ui.includes("LIVE EXECUTION IS NOT IMPLEMENTED — NO REAL ORDERS"));
  // The banner is not duplicated onto the shell.
  assert.equal(view.includes("LIVE EXECUTION IS NOT IMPLEMENTED"), false);
});

await test("8A the Overview header answers the five required questions", () => {
  const ov = read("src/components/shadowArbitrage/OverviewPanel.tsx");
  for (const [what, needle] of [
    ["Shadow-only status", "فقط پایش آزمایشی"],
    ["collector health", "COLLECTOR_STATE_FA[collectorState]"],
    ["paper status", "اجرای کاغذی"],
    ["last successful cycle", "آخرین چرخهٔ موفق"],
    ["refresh", "onRefresh"],
    ["14-day progress", "پیشرفت دورهٔ ۱۴ روزه"]
  ] as Array<[string, string]>) {
    assert.ok(ov.includes(needle), `the overview header must show ${what}`);
  }
});

await test("8A the Overview shows exactly the four required primary cards", () => {
  const ov = read("src/components/shadowArbitrage/OverviewPanel.tsx");
  const labels = [...ov.matchAll(/label="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(labels, [
    "بهترین فرصت معتبر",
    "فرصت‌های معتبر مثبت",
    "سلامت منابع و جمع‌آورنده",
    "پیشرفت و پوشش مشاهده"
  ]);

  // The grid is capped at four columns and steps down, never past four.
  const css = read("app/globals.css");
  const grid = css.slice(css.indexOf(".sa-ov-grid {"));
  assert.ok(grid.includes("repeat(4, minmax(0, 1fr))"));
  assert.ok(grid.includes("repeat(2, minmax(0, 1fr))"));
  assert.ok(grid.includes("grid-template-columns: minmax(0, 1fr)"));
  assert.equal(/repeat\([5-9], minmax/.test(grid.slice(0, 900)), false, "never more than four");
});

await test("8A secondary summaries exist and real execution stays visibly DISARMED", () => {
  const ov = read("src/components/shadowArbitrage/OverviewPanel.tsx");
  for (const title of ["ارزیابی کاغذی", "آمادگی حساب و کارمزد", "آمادگی اجرای واقعی"]) {
    assert.ok(ov.includes(title), `missing secondary summary: ${title}`);
  }
  assert.ok(ov.includes("غیرمسلح"), "the overview states DISARMED in Persian");
  assert.ok(ov.includes("اجرای واقعی پیاده‌سازی نشده است"));
  // No control on the overview can arm or execute anything.
  for (const term of ["arm", "enable_live", "execute", "go_live", "placeOrder"]) {
    assert.equal(ov.includes(`"${term}"`), false, `overview must not offer ${term}`);
  }
});

await test("8A loading, stale, empty and error states exist without fake values", () => {
  const ov = read("src/components/shadowArbitrage/OverviewPanel.tsx");
  assert.ok(ov.includes("SkeletonCard"), "loading state");
  assert.ok(ov.includes("sa-callout-danger"), "error state");
  assert.ok(ov.includes("قدیمی‌تر از حد انتظار"), "stale state");
  assert.ok(ov.includes("هنوز هیچ داده‌ای برای نمایش وجود ندارد"), "empty state");
  // Unknown values render as an em dash, never as a fabricated number.
  assert.ok(ov.includes('return "—"'), "unknown money renders as a dash");
  assert.ok(ov.includes('coverage === null ? "—"'));
  assert.ok(ov.includes('best ? toman(best.netProfitToman) : "—"'));
  // No placeholder market data anywhere.
  for (const fake of ["lorem", "placeholder", "sampleData", "MOCK", "dummy"]) {
    assert.equal(ov.toLowerCase().includes(fake.toLowerCase()), false, `no ${fake}`);
  }
});

await test("8A Persian is primary and technical codes stay in tooltips or details", () => {
  const ov = read("src/components/shadowArbitrage/OverviewPanel.tsx");
  // Card labels and hints are Persian; raw enum values never reach a label.
  for (const code of ["EXECUTABLE_NOW", "LIVE_VERIFIED", "PROVISIONAL_EVALUATION", "DISARMED"]) {
    assert.equal(ov.includes(`>${code}<`), false, `${code} must not be rendered as visible text`);
  }
  // The status strip uses Persian chips resolved through the label maps.
  assert.ok(ov.includes("COLLECTOR_STATE_FA"));
  assert.ok(ov.includes("TOOLTIP_FA"), "technical explanations are tooltips");
});

await test("8A Shadow styling is scoped and cannot affect other pages", () => {
  const css = read("app/globals.css");
  const phase8a = css.slice(css.indexOf("Phase 8A shell and overview"));
  // Every rule introduced by this phase targets a .sa-* class.
  const selectors = [...phase8a.matchAll(/^(\.[a-z][^{\n,]*|:root\[[^\]]+\][^{\n,]*)\s*[,{]/gm)].map(
    (m) => m[1].trim()
  );
  assert.ok(selectors.length > 10, "the phase adds real rules");
  for (const sel of selectors) {
    assert.ok(/\.sa-/.test(sel), `selector escapes the Shadow scope: ${sel}`);
  }
  // No global element or body rule was added.
  assert.equal(/^\s*(body|html|main|\*)\s*[,{]/m.test(phase8a), false);
});

await test("8A the tab strip scrolls on mobile and the page never overflows", () => {
  const css = read("app/globals.css");
  const wrap = css.slice(css.indexOf(".sa-tabs-wrap {"));
  assert.ok(wrap.slice(0, 400).includes("overflow-x: auto"), "mobile tabs scroll horizontally");
  assert.ok(wrap.slice(0, 400).includes("white-space: nowrap") || css.includes("white-space: nowrap"));
  // .sa-page is a grid, and grid items default to min-width:auto, so one wide
  // child would widen the whole track. minmax(0,1fr) plus min-width:0 is the
  // structural guard; overflow-x:clip alone would only hide such a problem.
  const page = css.slice(css.indexOf(".sa-page-tabbed {"));
  assert.ok(page.slice(0, 260).includes("grid-template-columns: minmax(0, 1fr)"));
  assert.ok(page.slice(0, 260).includes("max-width: 100%"));
  assert.ok(page.slice(0, 260).includes("overflow-x: clip"));
  assert.ok(page.includes(".sa-page-tabbed > * {"), "children may not set their own min-width");
  const guarded = page.slice(page.indexOf(".sa-tabs-wrap,"), page.indexOf(".sa-tabs-wrap,") + 220);
  for (const sel of [".sa-tabpanel", ".sa-ov", ".sa-ov-grid", ".sa-ov-secondary"]) {
    assert.ok(guarded.includes(sel), `${sel} must carry the min-width guard`);
  }
  // Long values wrap rather than clip.
  const card = css.slice(css.indexOf(".sa-ov-card-value {"));
  assert.ok(card.slice(0, 260).includes("overflow-wrap: anywhere"));
});

await test("8A the tab bar is a real tablist and stays keyboard reachable", () => {
  const tabs = read("src/components/shadowArbitrage/ShadowTabs.tsx");
  assert.ok(tabs.includes('role="tablist"'));
  assert.ok(tabs.includes('role="tab"'));
  assert.ok(tabs.includes("aria-selected={selected}"));
  assert.ok(tabs.includes("aria-controls={`sa-panel-${tab.id}`}"));
  assert.ok(tabs.includes("tabIndex={selected ? 0 : -1}"), "roving tab stop");
  assert.ok(tabs.includes("ArrowLeft") && tabs.includes("ArrowRight"));

  const view = read("src/components/ShadowArbitrageView.tsx");
  assert.ok(view.includes('role="tabpanel"'));
  assert.ok(view.includes("aria-labelledby={`sa-tab-${tab}`}"));
});

await test("8A no API, database, calculation or safety logic changed", () => {
  const view = read("src/components/ShadowArbitrageView.tsx");
  // The same read-only endpoints as before, plus two summary reads.
  const endpoints = [...view.matchAll(/\/api\/shadow-arbitrage\/([a-z-]+)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(endpoints)].sort(),
    ["analytics", "history", "live-readiness", "matrix", "observation", "paper"]
  );
  // The only mutating call is the pre-existing pause/resume control.
  const posts = view.match(/method: "POST"/g) ?? [];
  assert.equal(posts.length, 1);
  assert.ok(view.includes('JSON.stringify({ action })'));
  // Every shadow API route is still admin-only.
  for (const r of ["matrix", "observation", "paper", "live-readiness", "capital", "accounts"]) {
    assert.ok(read(`app/api/shadow-arbitrage/${r}/route.ts`).includes("requireAdminSession"));
  }
});

await test("8A ratios are bidi-isolated so RTL cannot reverse them", () => {
  const ov = read("src/components/shadowArbitrage/OverviewPanel.tsx");
  // Every "part of whole" figure goes through one component, not ad-hoc markup.
  assert.ok(ov.includes("function Ratio("));
  assert.ok(ov.includes('className="sa-ratio" dir="ltr"'), "the isolate is explicit in markup");
  assert.equal(
    /\{toFaDigits\([a-zA-Z.]+\)\}\s*<span className="sa-ov-card-of"> \//.test(ov),
    false,
    "no hand-built ratio may remain"
  );
  for (const use of ["<Ratio part={healthySources}", "<Ratio part={accounts.executable}", "<Ratio part={readiness.passed}"]) {
    assert.ok(ov.includes(use), `missing ${use}`);
  }

  const css = read("app/globals.css");
  const rule = css.slice(css.indexOf(".sa-ratio {"));
  assert.ok(rule.slice(0, 220).includes("direction: ltr"));
  assert.ok(rule.slice(0, 220).includes("unicode-bidi: isolate"));
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
