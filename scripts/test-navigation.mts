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

/** Strip comments so a scan tests behaviour, not documentation. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

/** Only the Phase 8A section of the stylesheet — never an unrelated rule. */
function phase8aCss(): string {
  const css = read("app/globals.css");
  return css.slice(css.indexOf("Phase 8A shell and overview"));
}

await test("8A polish: the desktop tab strip uses the full content width", () => {
  const css = phase8aCss();
  const strip = css.slice(css.indexOf(".sa-tabs {"), css.indexOf(".sa-tab {"));
  assert.ok(strip.includes("display: flex"), "not an inline strip hugging one end");
  assert.ok(strip.includes("width: 100%"));
  assert.ok(strip.includes("justify-content: space-between"));
  const tab = css.slice(css.indexOf(".sa-tab {"), css.indexOf(".sa-tab:hover"));
  assert.ok(tab.includes("flex: 1 1 auto"), "tabs share the available width");

  // Below 900px the strip returns to its natural width and scrolls.
  const narrow = css.slice(css.indexOf("@media (max-width: 900px)"));
  assert.ok(narrow.slice(0, 900).includes("width: max-content"));
  assert.ok(narrow.slice(0, 900).includes("flex: 0 0 auto"));
});

await test("8A polish: mobile tabs snap, fade at the edges and self-scroll", () => {
  const css = phase8aCss();
  const wrap = css.slice(css.indexOf(".sa-tabs-wrap {"), css.indexOf(".sa-tabs {"));
  assert.ok(wrap.includes("scroll-snap-type: x proximity"), "no tab rests half-cut");
  assert.ok(wrap.includes("scroll-padding-inline"));
  const tab = css.slice(css.indexOf(".sa-tab {"), css.indexOf(".sa-tab:hover"));
  assert.ok(tab.includes("scroll-snap-align: center"));
  // Edge affordance.
  const narrow = css.slice(css.indexOf("@media (max-width: 900px)"));
  assert.ok(narrow.slice(0, 1400).includes("mask-image"), "edge fade signals more tabs");

  // The active tab is brought into view when the strip actually scrolls.
  const tabs = read("src/components/shadowArbitrage/ShadowTabs.tsx");
  assert.ok(tabs.includes("scrollIntoView"));
  assert.ok(tabs.includes('inline: "center"'));
  assert.ok(
    tabs.includes("strip.scrollWidth <= strip.clientWidth + 1"),
    "no scrolling when everything already fits"
  );
  assert.ok(tabs.includes("}, [active]);"), "it reacts to the selected tab");
});

await test("8A polish: the status panel is grouped, aligned and ends with progress", () => {
  const ov = read("src/components/shadowArbitrage/OverviewPanel.tsx");
  // Mode + collector + paper form one cluster; cycle time + refresh the other.
  const group = ov.indexOf('className="sa-ov-status-group"');
  const tail = ov.indexOf('className="sa-ov-status-tail"');
  const progress = ov.indexOf('className="sa-ov-progress"');
  assert.ok(group > 0 && tail > group, "the tail follows the cluster");
  assert.ok(progress > tail, "progress is the final row");

  const css = phase8aCss();
  const g = css.slice(css.indexOf(".sa-ov-status-group {"), css.indexOf(".sa-ov-status-tail {"));
  assert.ok(g.includes("border-inline-end"), "a divider separates the cluster");
  const t = css.slice(css.indexOf(".sa-ov-status-tail {"));
  assert.ok(t.slice(0, 220).includes("margin-inline-start: auto"), "the tail aligns to the end");
  const p = css.slice(css.indexOf(".sa-ov-progress {"));
  assert.ok(p.slice(0, 200).includes("border-top"), "progress reads as its own row");
});

await test("8A polish: KPI cards reuse .panel and own only the status rail", () => {
  const ov = read("src/components/shadowArbitrage/OverviewPanel.tsx");
  // The tile IS a shared panel; Shadow adds layout classes on top.
  assert.ok(ov.includes('className={`panel sa-panel sa-ov-card'), "KPI tile is a .panel");
  assert.ok(ov.includes('"panel sa-panel sa-ov-card sa-ov-card-skeleton"'), "so is the skeleton");

  const css = phase8aCss();
  // .sa-ov-card declares layout only — no surface of its own.
  const card = css.slice(css.indexOf(".sa-ov-card {"), css.indexOf(".sa-ov-card-label {"));
  for (const prop of ["background", "box-shadow", "backdrop-filter", "border:"]) {
    assert.equal(card.includes(prop), false, `.sa-ov-card must not declare ${prop}`);
  }
  // Semantics live on a 3px rail, drawn from existing tokens.
  const rail = css.slice(css.indexOf(".sa-ov-card-good::before,"));
  assert.ok(rail.slice(0, 700).includes("width: 3px"));
  assert.ok(rail.slice(0, 700).includes("background: var(--green)"));
  assert.ok(rail.slice(0, 700).includes("background: var(--yellow)"));
  assert.ok(rail.slice(0, 700).includes("background: var(--red)"));
});

await test("8A polish: secondary cards are dense and use existing data only", () => {
  const ov = read("src/components/shadowArbitrage/OverviewPanel.tsx");
  // Paper: a status chip plus exactly three metrics.
  const paperBlock = ov.slice(ov.indexOf("ارزیابی کاغذی"), ov.indexOf("آمادگی حساب و کارمزد"));
  for (const dt of ["وضعیت نشست", "معاملات اجراشده", "ردشده", "سود خالص اقتصادی"]) {
    assert.ok(paperBlock.includes(dt), `paper summary needs ${dt}`);
  }
  // Account readiness: ratio + main blocker, in a two-column list.
  const acctBlock = ov.slice(ov.indexOf("آمادگی حساب و کارمزد"), ov.indexOf("آمادگی اجرای واقعی"));
  assert.ok(acctBlock.includes("<Ratio part={accounts.executable}"));
  assert.ok(acctBlock.includes("مانع اصلی"));
  assert.ok(acctBlock.includes("sa-ov-mini-list-2"));
  // Live readiness: DISARMED + gate ratio + first blocker.
  const liveBlock = ov.slice(ov.indexOf("آمادگی اجرای واقعی"));
  assert.ok(liveBlock.includes("غیرمسلح"));
  assert.ok(liveBlock.includes("<Ratio part={readiness.passed}"));
  assert.ok(liveBlock.includes("نخستین مانع"));

  // Nothing new was invented: the props are unchanged.
  assert.equal(/props\.[a-z]+New|fakeData|sample/i.test(ov), false);
});

await test("8A polish: details actions are restrained glass with a chevron", () => {
  const ov = read("src/components/shadowArbitrage/OverviewPanel.tsx");
  assert.ok(ov.includes("function DetailsAction("));
  assert.ok(ov.includes("<ChevronLeft"), "a directional chevron, pointing onward in RTL");
  assert.ok(ov.includes('from "lucide-react"'), "no new icon library");
  // The bright link style is gone from the secondary cards.
  const secondary = ov.slice(ov.indexOf("sa-ov-secondary"));
  assert.equal(secondary.includes("sa-linkish"), false, "no bright-blue links remain");
  assert.equal((ov.match(/<DetailsAction/g) ?? []).length, 3);

  // The control material is the shared primitive, not a Shadow re-creation.
  assert.ok(ov.includes('className="sa-ov-action glass-control"'), "action reuses .glass-control");
  const css = phase8aCss();
  const action = css.slice(css.indexOf(".sa-ov-action {"), css.indexOf(".sa-ov-action:hover"));
  for (const prop of ["background", "box-shadow", "backdrop-filter", "border:"]) {
    assert.equal(action.includes(prop), false, `.sa-ov-action must not declare ${prop}`);
  }
  assert.ok(action.includes("color: var(--muted)"), "tertiary, not accent-coloured");
  assert.ok(css.includes(".sa-ov-action:focus-visible"), "still keyboard visible");
});

await test("8A polish: dark secondary text is lifted without flattening hierarchy", () => {
  const css = phase8aCss();
  const dark = css.slice(css.indexOf(':root[data-theme="dark"] .sa-ov-card-hint'));
  assert.ok(
    dark.slice(0, 900).includes("color-mix(in srgb, var(--text) 72%, var(--muted))"),
    "the dark lift is derived from existing tokens, not a new literal"
  );
  for (const sel of [
    ".sa-ov-card-label",
    ".sa-ov-status-label",
    ".sa-ov-mini-list dt",
    ".sa-ov-action"
  ]) {
    assert.ok(dark.slice(0, 700).includes(sel), `${sel} must be lifted too`);
  }
  // Hierarchy is preserved: the primary value keeps its own colour and weight.
  const value = css.slice(css.indexOf(".sa-ov-card-value {"));
  assert.ok(value.slice(0, 260).includes("color: var(--text)"));
  assert.ok(value.slice(0, 260).includes("font-weight: 800"));
  // The lift is scoped to Shadow, not applied to the global muted token.
  assert.equal(/:root\[data-theme="dark"\]\s*\{[^}]*--muted/.test(read("app/globals.css")), false);
});

await test("8A polish: mobile spacing tightens without shrinking tap targets", () => {
  const css = phase8aCss();
  const mob = css.slice(css.indexOf("Mobile rhythm:"));
  const block = mob.slice(0, mob.indexOf("The page itself"));
  assert.ok(block.includes(".sa-ov-status"), "padding tightens");
  assert.ok(block.includes(".sa-ov-mini"));
  // Tap targets do not shrink — they grow.
  assert.ok(block.includes("min-height: 28px"), "tertiary action stays tappable");
  assert.ok(block.includes("min-height: 36px"), "tabs stay tappable on touch");
  // Readability is preserved: the value only steps down one size.
  assert.ok(block.includes("font-size: 19px"));
});

/* ── Liquid Glass reuse: Shadow must not fork the OTC material system ────── */

await test("8A glass: every Shadow surface reuses an existing shared primitive", () => {
  const view = read("src/components/ShadowArbitrageView.tsx");
  const tabs = read("src/components/shadowArbitrage/ShadowTabs.tsx");
  const ov = read("src/components/shadowArbitrage/OverviewPanel.tsx");

  // The primitives themselves live in the shared stylesheets, not in Shadow.
  const system = read("app/ios27-design-system.css");
  const globals = read("app/globals.css");
  assert.ok(system.includes(".glass-control {"), "glass-control is a shared primitive");
  assert.ok(system.includes(".glass-tabbar {"), "glass-tabbar is a shared primitive");
  assert.ok(globals.includes(".panel {"), ".panel is the shared card material");

  // Each listed Shadow surface opts into one of them.
  const surfaces: Array<[string, string, string]> = [
    ["warning banner", view, 'sa-warning sa-warning-compact glass-control'],
    ["tab container", tabs, 'className="sa-tabs glass-tabbar"'],
    ["active tab", tabs, 'is-active glass-control'],
    ["KPI card", ov, 'panel sa-panel sa-ov-card'],
    ["loading skeleton", ov, 'panel sa-panel sa-ov-card sa-ov-card-skeleton'],
    ["details action", ov, 'sa-ov-action glass-control'],
    ["empty state", ov, 'panel sa-panel sa-empty']
  ];
  for (const [name, src, needle] of surfaces) {
    assert.ok(src.includes(needle), `${name} must reuse a shared primitive (${needle})`);
  }
  // Status panel and the three secondary cards are .panel already.
  assert.ok(ov.includes('className="panel sa-panel sa-ov-status"'));
  assert.equal((ov.match(/className="panel sa-panel sa-ov-mini"/g) ?? []).length, 3);
});

await test("8A glass: Shadow CSS declares no card material of its own", () => {
  const css = phase8aCss();

  // Nothing in the Shadow section may re-create the glass material.
  assert.equal(/backdrop-filter\s*:/.test(css), false, "blur must come from the primitives");
  assert.equal(/box-shadow\s*:/.test(css), false, "shadows must come from the primitives");

  // The only backgrounds allowed are the reset, the status rail and semantic
  // alert/badge tints — never a card surface.
  const backgrounds = [...css.matchAll(/background\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
  const allowed = [
    "none",
    "var(--green)",
    "var(--yellow)",
    "var(--red)",
    "var(--line)",
    "color-mix(in srgb, var(--red) 16%, transparent)",
    "color-mix(in srgb, var(--red) 10%, transparent)"
  ];
  for (const bg of backgrounds) {
    assert.ok(allowed.includes(bg), `unexpected surface background in Shadow CSS: ${bg}`);
  }

  // No new colour literals: every colour is a token or a mix of tokens.
  const hex = [...new Set([...css.matchAll(/#[0-9a-fA-F]{3,8}/g)].map((m) => m[0]))];
  assert.deepEqual(hex, ["#000"], `only the mask stop may be a literal, found: ${hex.join(", ")}`);
  assert.equal(/rgba?\(\s*\d/.test(css), false, "no raw rgb()/rgba() surface values");

  // Borders that remain are structural dividers, not card outlines.
  const borders = [...css.matchAll(/border[a-z-]*\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
  for (const b of borders) {
    assert.ok(
      b === "0" || b.includes("var(--line-soft)") || b.includes("999px") || b.includes("var(--radius"),
      `unexpected border declaration: ${b}`
    );
  }
});

await test("8A glass: the page inherits the OTC workspace environment", () => {
  // Shadow renders inside the same desk layout and Shell as every other page.
  const layout = read("app/(desk)/layout.tsx");
  assert.ok(layout.includes("<Shell>"), "the desk layout wraps children in Shell");
  const page = read("app/(desk)/shadow-arbitrage/page.tsx");
  assert.equal(page.includes("Shell"), false, "the page must not build its own shell");
  assert.equal(page.includes("background"), false, "nor its own background");

  // The Shadow page sets no page-level background, padding or width of its own:
  // .content in the shared layout owns the workspace environment.
  const css = phase8aCss();
  const pageRule = css.slice(css.indexOf(".sa-page-tabbed {"), css.indexOf(".sa-page-tabbed > *"));
  assert.equal(/background|padding|margin/.test(pageRule), false, "no bespoke workspace chrome");
  assert.ok(read("app/globals.css").includes(".content {"), ".content owns the workspace padding");
});

/* ── the preview must photograph the real app, never a reconstruction ────── */

await test("preview harness renders the production shell, not a rebuilt one", () => {
  const preview = read("scripts/preview-shadow-ui.mts");

  // It drives the real standalone build over HTTP; it does not assemble markup.
  assert.ok(preview.includes("standalone"), "it boots the production bundle");
  assert.ok(preview.includes("/shadow-arbitrage?tab=overview"), "it navigates the real route");
  assert.ok(preview.includes("Page.captureScreenshot"), "a real browser takes the picture");

  // No substitute shell, sidebar, header or icon list may exist here.
  for (const forbidden of [
    "<aside",
    "<nav",
    "sidebar glass-nav",
    "glass-icon-button",
    "sa-tabs",
    "sa-ov-card",
    "<svg",
    "viewBox",
    "brand-title",
    "nav-item"
  ]) {
    assert.equal(preview.includes(forbidden), false, `preview must not contain ${forbidden}`);
  }
  // No replacement navigation list, and no icon imports.
  assert.equal(/lucide-react/.test(preview), false, "no substitute icons");
  assert.equal(/RAIL_ITEMS|NAV_ITEMS|SIDEBAR_ITEMS/.test(preview), false, "no rebuilt nav list");
  // No CSS for shell, sidebar, header or navigation.
  assert.equal(/<style|\.sidebar\s*\{|\.shell\s*\{|\.page-header\s*\{/.test(preview), false);

  // The real components are the ones under test, and they are untouched.
  assert.ok(read("src/components/Shell.tsx").includes("sidebarNavItems"));
  assert.ok(read("app/(desk)/layout.tsx").includes("<Shell>"));
});

await test("preview isolation: throwaway database, no credential, no stored secret", () => {
  const raw = read("scripts/preview-shadow-ui.mts");
  // Scan what the script DOES, not what its comments say it avoids.
  const preview = stripComments(raw);
  // Never the live local database.
  assert.ok(preview.includes("mkdtemp"), "the database directory is temporary");
  assert.ok(preview.includes("pglite:${path.join(dataDir"), "and points at that temp dir");
  assert.equal(preview.includes(".data/"), false, "never the live local database");
  // The secret is generated per run and never written anywhere.
  assert.ok(preview.includes("randomBytes(48)"), "the signing secret is generated");
  assert.equal(/writeFile\([^)]*secret/.test(preview), false, "the secret is never written to disk");
  // A test-only identity with no password: it can mint a session, never log in.
  assert.ok(preview.includes('ADMIN_PASSWORD_HASH: ""'), "no password hash exists");
  assert.equal(/process\.env\.ADMIN_PASSWORD_HASH\s*\?\?/.test(preview), false);
  // The collector never runs inside a screenshot tool.
  assert.ok(preview.includes('SHADOW_COLLECTOR_ENABLED: "false"'));
  // Output is not committed.
  assert.ok(read(".gitignore").includes("preview-out/"));
  // The prose still documents the isolation for a human reader.
  assert.ok(raw.includes("never `.data/`"));
});

await test("preview does not modify production shell, header or tokens", () => {
  // Everything the preview photographs is production code it only imports.
  const preview = read("scripts/preview-shadow-ui.mts");
  for (const productionFile of [
    "src/components/Shell.tsx",
    "src/components/DeskPageHeader.tsx",
    "src/lib/sidebarNav.ts",
    "app/ios27-design-system.css"
  ]) {
    assert.equal(preview.includes(productionFile), false, `preview must not touch ${productionFile}`);
  }
  // And the shipped admin shortcut is still the one the header renders.
  const header = read("src/components/DeskPageHeader.tsx");
  assert.ok(header.includes("<ShadowArbitrageHeaderButton />"));
  assert.ok(
    read("src/components/ShadowArbitrageHeaderButton.tsx").includes('role !== "admin"'),
    "and it is still admin-only"
  );
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
