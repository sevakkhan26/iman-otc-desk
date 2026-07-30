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
    "OpportunitiesPanel",
    "SourcesPanel",
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
    ["OpportunitiesPanel", "opportunities"],
    ["SourcesPanel", "sources"],
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
  // The same read-only endpoints as before, plus the summary reads. Phase 8B
  // added the existing accounts read; no endpoint was created or changed.
  const endpoints = [...view.matchAll(/\/api\/shadow-arbitrage\/([a-z-]+)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(endpoints)].sort(),
    ["accounts", "analytics", "history", "live-readiness", "matrix", "observation", "paper"]
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
  const start = css.indexOf("Phase 8A shell and overview");
  const end = css.indexOf("Phase 8B opportunities and sources");
  return css.slice(start, end > start ? end : undefined);
}

/** Only the Phase 8B section — the two redesigned tabs. */
function phase8bCss(): string {
  const css = read("app/globals.css");
  return css.slice(css.indexOf("Phase 8B opportunities and sources"));
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
  // It navigates the real route; the tab is a parameter, defaulting to Overview.
  assert.ok(preview.includes("/shadow-arbitrage?tab=${shot.tab}"), "it navigates the real route");
  assert.ok(preview.includes('process.env.PREVIEW_TABS ?? "overview"'));
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


/* ══ Phase 8B — Opportunities and Sources/Fees ═══════════════════════════════ */

const {
  DEFAULT_OPPORTUNITY_FILTERS,
  OPPORTUNITY_SORTS,
  activeFilterCount,
  evidenceFor,
  filterOpportunities,
  groupOpportunities,
  indexPaperEvidence,
  primaryBlockingReason,
  sortOpportunities,
  summarizeOpportunities
} = await import("../src/components/shadowArbitrage/opportunityModel.ts");

const { buildVenueRows, summarizeVenues, feeExpiryIso, settlementFor } = await import(
  "../src/components/shadowArbitrage/sourcesModel.ts"
);

type AnyRecord = Record<string, unknown>;

/** A complete opportunity row; every test overrides only what it cares about. */
function opp(over: AnyRecord = {}): AnyRecord {
  return {
    id: "lc-1",
    routeKey: "nobitex->wallex@25",
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    buySourceName: "نوبیتکس",
    sellSourceName: "والکس",
    sizeUsdt: 25,
    buyVwapToman: 100_000,
    sellVwapToman: 101_000,
    rawSpreadPercent: 1,
    buyFeeToman: 6_250,
    sellFeeToman: 8_837,
    buyFeeBps: 25,
    sellFeeBps: 35,
    totalFeePercent: 0.6,
    slippageBufferToman: 1_250,
    rebalanceCostToman: 0,
    netProfitToman: 8_663,
    netEdgePercent: 0.34,
    buyCostToman: 2_500_000,
    sellProceedsToman: 2_525_000,
    eligibility: "EXECUTABLE_NOW",
    blockedReasons: [],
    firstSeenAt: "2026-07-30T10:00:00.000Z",
    lastSeenAt: "2026-07-30T10:05:00.000Z",
    endedAt: null,
    durationMs: 300_000,
    maxNetEdgePercent: 0.4,
    maxNetProfitToman: 9_000,
    maxRawSpreadPercent: 1.2,
    feeUnknown: false,
    observationCount: 10,
    isActive: true,
    buyAgeMs: 4_000,
    sellAgeMs: 6_000,
    ...over
  };
}

/** A paper ledger row with the five recorded PnL figures. */
function ledger(over: AnyRecord = {}): AnyRecord {
  return {
    lifecycleId: "lc-1",
    routeKey: "nobitex->wallex@25",
    outcome: "FILLED",
    sizeUsdt: 25,
    rejectionCode: null,
    rejectionReason: null,
    buyFeeAsset: "IRT",
    buyFeeDebitMode: "ADD_TO_DEBIT",
    buyFeeProvenance: "ADMIN_CONFIRMED",
    sellFeeAsset: "USDT",
    sellFeeDebitMode: "ADD_TO_DEBIT",
    sellFeeProvenance: "ADMIN_CONFIRMED",
    markPriceToman: 100_000,
    grossSpreadToman: 25_000,
    slippageBufferToman: 1_250,
    cashPnlIrtToman: 43_750,
    inventoryDeltaUsdtMicros: -87_500,
    sellFeeValueToman: 8_750,
    economicNetPnlToman: 35_000,
    riskAdjustedPnlToman: 33_750,
    occurredAt: "2026-07-30T10:05:00.000Z",
    ...over
  };
}

await test("8B filters are exact and combine without surprises", () => {
  const rows = [
    opp({ id: "a", sizeUsdt: 5, buySourceId: "nobitex", sellSourceId: "wallex" }),
    opp({
      id: "b",
      sizeUsdt: 25,
      buySourceId: "bitpin",
      sellSourceId: "tabdeal",
      buySourceName: "بیت‌پین",
      sellSourceName: "تبدیل",
      eligibility: "ACCOUNT_REQUIRED"
    }),
    opp({ id: "c", sizeUsdt: 25, isActive: false }),
    opp({ id: "d", sizeUsdt: 25, feeUnknown: true, netProfitToman: 0 })
  ];
  const f = DEFAULT_OPPORTUNITY_FILTERS;

  // Completed lifecycles are hidden until asked for.
  assert.deepEqual(filterOpportunities(rows, f).map((o) => o.id), ["a", "b", "d"]);
  assert.deepEqual(
    filterOpportunities(rows, { ...f, includeCompleted: true }).map((o) => o.id),
    ["a", "b", "c", "d"]
  );
  // Size, venue, account and net-positive filters.
  assert.deepEqual(filterOpportunities(rows, { ...f, size: "5" }).map((o) => o.id), ["a"]);
  assert.deepEqual(filterOpportunities(rows, { ...f, sourceId: "tabdeal" }).map((o) => o.id), ["b"]);
  assert.deepEqual(
    filterOpportunities(rows, { ...f, currentAccountsOnly: true }).map((o) => o.id),
    ["a", "d"]
  );
  // A fee-unknown row is never counted as net positive; a route that merely
  // needs an account still is, because its fees and net result are known.
  assert.deepEqual(
    filterOpportunities(rows, { ...f, netPositiveOnly: true }).map((o) => o.id),
    ["a", "b"]
  );
  // Search matches the Persian venue name and the ascii id alike.
  assert.deepEqual(filterOpportunities(rows, { ...f, query: "تبدیل" }).map((o) => o.id), ["b"]);
  assert.deepEqual(filterOpportunities(rows, { ...f, query: "bitpin" }).map((o) => o.id), ["b"]);
  assert.deepEqual(filterOpportunities(rows, { ...f, query: "والکس" }).map((o) => o.id), ["a", "d"]);
  assert.deepEqual(filterOpportunities(rows, { ...f, query: "هیچ" }).map((o) => o.id), []);
  assert.equal(activeFilterCount(f), 0);
  assert.equal(activeFilterCount({ ...f, size: "5", netPositiveOnly: true }), 2);
});

await test("8B sorting is deterministic and never invents a missing metric", () => {
  const rows = [
    opp({ id: "low", rawSpreadPercent: 0.2, durationMs: 10, buyAgeMs: 1, sellAgeMs: 1 }),
    opp({ id: "high", rawSpreadPercent: 0.9, durationMs: 90, buyAgeMs: 50, sellAgeMs: 50 }),
    opp({ id: "mid", rawSpreadPercent: 0.5, durationMs: 50, buyAgeMs: 20, sellAgeMs: 20 })
  ];
  const evidence = indexPaperEvidence([
    ledger({ lifecycleId: "mid", riskAdjustedPnlToman: 10_000, economicNetPnlToman: 12_000 }),
    ledger({ lifecycleId: "low", riskAdjustedPnlToman: 90_000, economicNetPnlToman: 95_000 })
  ]);

  // Rows with no recorded figure sort last — they are not treated as zero.
  assert.deepEqual(
    sortOpportunities(rows, "riskAdjusted", evidence).map((o) => o.id),
    ["low", "mid", "high"]
  );
  assert.deepEqual(
    sortOpportunities(rows, "economic", evidence).map((o) => o.id),
    ["low", "mid", "high"]
  );
  assert.deepEqual(
    sortOpportunities(rows, "grossSpread", evidence).map((o) => o.id),
    ["high", "mid", "low"]
  );
  assert.deepEqual(
    sortOpportunities(rows, "freshness", evidence).map((o) => o.id),
    ["low", "mid", "high"]
  );
  assert.deepEqual(
    sortOpportunities(rows, "duration", evidence).map((o) => o.id),
    ["high", "mid", "low"]
  );

  // A tie is broken by raw spread and then by lifecycle id, so repeated renders
  // of the same data are byte-identical.
  const tied = [
    opp({ id: "z", rawSpreadPercent: 0.5, durationMs: 5 }),
    opp({ id: "a", rawSpreadPercent: 0.5, durationMs: 5 }),
    opp({ id: "m", rawSpreadPercent: 0.5, durationMs: 5 })
  ];
  const once = sortOpportunities(tied, "duration", new Map()).map((o) => o.id);
  const twice = sortOpportunities([...tied].reverse(), "duration", new Map()).map((o) => o.id);
  assert.deepEqual(once, ["a", "m", "z"]);
  assert.deepEqual(once, twice, "input order must not change the result");
  // Sorting never mutates the caller's array.
  assert.deepEqual(tied.map((o) => o.id), ["z", "a", "m"]);
  // Every offered sort key is implemented.
  for (const s of OPPORTUNITY_SORTS) {
    assert.equal(sortOpportunities(rows, s.key, evidence).length, rows.length);
  }
});

await test("8B paper evidence is joined exactly, or not at all", () => {
  const index = indexPaperEvidence([
    ledger({ lifecycleId: "lc-1", outcome: "SKIPPED", riskAdjustedPnlToman: 1 }),
    ledger({ lifecycleId: "lc-1", outcome: "FILLED", riskAdjustedPnlToman: 2 })
  ]);
  // A settled fill always wins over a skip, whatever the input order.
  assert.equal(index.get("lc-1")!.outcome, "FILLED");
  assert.equal(index.get("lc-1")!.riskAdjustedPnlToman, 2);

  // Micros are converted to USDT, never rounded to zero.
  assert.equal(index.get("lc-1")!.inventoryDeltaUsdt, -0.0875);

  // The size must match: a figure recorded for another size is not borrowed.
  assert.equal(evidenceFor(opp({ id: "lc-1", sizeUsdt: 25 }), index)!.economicNetPnlToman, 35_000);
  assert.equal(evidenceFor(opp({ id: "lc-1", sizeUsdt: 10 }), index), null);
  assert.equal(evidenceFor(opp({ id: "other" }), index), null);

  // Two skips: the later timestamp wins, deterministically.
  const skips = indexPaperEvidence([
    ledger({ outcome: "SKIPPED", occurredAt: "2026-07-30T09:00:00.000Z", rejectionCode: "old" }),
    ledger({ outcome: "SKIPPED", occurredAt: "2026-07-30T11:00:00.000Z", rejectionCode: "new" })
  ]);
  assert.equal(skips.get("lc-1")!.rejectionCode, "new");
});

await test("8B the three categories keep their exact membership", () => {
  const rows = [
    opp({ id: "valid" }),
    opp({ id: "raw", feeUnknown: true, eligibility: "ACCOUNT_REQUIRED", rawSpreadPercent: 0.4 }),
    opp({ id: "blocked", eligibility: "BLOCKED", blockedReasons: ["fee_unknown", "stale_buy_source"] })
  ];
  const groups = groupOpportunities(rows);
  assert.deepEqual(groups.valid.map((o) => o.id), ["valid"]);
  assert.deepEqual(groups.raw.map((o) => o.id), ["raw"]);
  assert.deepEqual(groups.blocked.map((o) => o.id), ["blocked"]);

  const summary = summarizeOpportunities(groups);
  assert.equal(summary.valid, 1);
  assert.equal(summary.raw, 1);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.shown, 3);
  assert.equal(summary.bestValidNetToman, 8_663);
  // With no valid row there is no "best" — null, never zero.
  assert.equal(summarizeOpportunities(groupOpportunities([rows[2]])).bestValidNetToman, null);
});

await test("8B the exact blocking reasons are preserved, never summarised away", () => {
  const reasons = ["stale_sell_source", "fee_unknown", "insufficient_buy_depth"];
  const o = opp({ eligibility: "BLOCKED", blockedReasons: reasons });
  // The first recorded reason leads; the rest stay available in order.
  assert.equal(primaryBlockingReason(o), "stale_sell_source");
  assert.equal(primaryBlockingReason(opp({ blockedReasons: [] })), null);

  const panel = read("src/components/shadowArbitrage/OpportunitiesPanel.tsx");
  // The complete list is rendered, not a truncated slice of it.
  assert.ok(panel.includes("o.blockedReasons.slice(1)"), "every remaining reason is listed");
  assert.equal(/slice\(0,\s*\d\)/.test(panel), false, "reasons must not be capped");
  // No generic catch-all sentence replaces a real reason.
  assert.equal(panel.includes("مسدود شده است"), false);
  // Technical codes stay out of the primary UI: only the drawer prints them.
  assert.equal(/<code/.test(panel), false, "codes belong in the details drawer");
  assert.ok(read("src/components/shadowArbitrage/OpportunityDrawer.tsx").includes('className="sa-code"'));
  // Each reason chip carries the plain-Persian explanation as its tooltip.
  assert.ok(panel.includes("title={blockedDetail(primary)}"));
});

await test("8B missing figures render as an em dash with a reason, never as zero", () => {
  const panel = read("src/components/shadowArbitrage/OpportunitiesPanel.tsx");
  // The money renderer has exactly one path for null, and it is the em dash.
  const money = panel.slice(panel.indexOf("function Money("));
  assert.ok(money.includes("if (value === null)"));
  assert.ok(money.includes("—"));
  assert.ok(money.includes("title={unknownHint}"), "and it says why it is missing");
  // Nothing falls back to a number.
  assert.equal(/\?\?\s*0\b/.test(panel), false, "no zero fallback for a missing metric");

  const sources = read("src/components/shadowArbitrage/SourcesPanel.tsx");
  assert.equal(/\?\?\s*0\b/.test(sources), false);
  assert.ok(sources.includes('title="کارمزد این صرافی هنوز تأیید نشده است"'));
});

await test("8B the sources tab keeps health and readiness apart, with per-side settlement", () => {
  const rows = buildVenueRows({
    certifications: [
      {
        sourceId: "nobitex",
        sourceName: "نوبیتکس",
        status: "LIVE_VERIFIED",
        marketSymbol: "USDTIRT",
        marketModel: "ORDER_BOOK",
        lastProbeAt: "2026-07-30T10:00:00.000Z",
        lastError: null
      },
      {
        sourceId: "arzinja",
        sourceName: "آرزینجا",
        status: "REFERENCE_ONLY",
        marketSymbol: "USDT",
        marketModel: "REFERENCE",
        lastProbeAt: "2026-07-30T10:00:00.000Z",
        lastError: null
      }
    ] as never,
    health: [
      {
        sourceId: "nobitex",
        sourceName: "نوبیتکس",
        samples: 100,
        uptimePercent: 99.5,
        errorRatePercent: 0.5,
        freshnessPercent: 98,
        latencyP50Ms: 120,
        latencyP95Ms: 400,
        lastError: null,
        lastErrorAt: null,
        rateLimitNote: ""
      }
    ] as never,
    snapshots: [{ sourceId: "nobitex", sourceName: "نوبیتکس", health: "healthy", ageMs: 4_000 }] as never,
    venues: [
      {
        sourceId: "nobitex",
        nameFa: "نوبیتکس",
        accountState: "VERIFIED",
        takerFeeBps: 25,
        feeProvenance: "ADMIN_CONFIRMED",
        feeTier: null,
        officialSourceUrl: null,
        feeVerifiedAt: "2026-07-01T00:00:00.000Z",
        feeStale: false,
        apiCapabilities: ["PUBLIC_MARKET_DATA"],
        requiredAction: "اقدامی لازم نیست.",
        blockingReason: null,
        notes: ""
      },
      {
        sourceId: "arzinja",
        nameFa: "آرزینجا",
        accountState: "REFERENCE_ONLY",
        takerFeeBps: null,
        feeProvenance: "UNKNOWN",
        feeTier: null,
        officialSourceUrl: null,
        feeVerifiedAt: null,
        feeStale: true,
        apiCapabilities: ["NONE_VERIFIED"],
        requiredAction: "اقدامی لازم نیست — این منبع فقط برای مقایسه است.",
        blockingReason: "منبع فقط مرجع است و اجرای آن تأیید نشده.",
        notes: ""
      }
    ] as never,
    feeReverifyDays: 90
  });

  const nobitex = rows.find((r) => r.sourceId === "nobitex")!;
  const arzinja = rows.find((r) => r.sourceId === "arzinja")!;

  // Health facts and readiness facts live on the same row but never merge.
  assert.equal(nobitex.health, "healthy");
  assert.equal(nobitex.latencyP95Ms, 400);
  assert.equal(nobitex.accountState, "VERIFIED");
  assert.equal(nobitex.takerFeeBps, 25);

  // Settlement is per venue AND per side, from the admin-confirmed table.
  assert.equal(nobitex.buySettlement.feeAsset, "IRT");
  assert.equal(nobitex.sellSettlement.feeAsset, "USDT");
  assert.equal(nobitex.buySettlement.provenance, "ADMIN_CONFIRMED");
  assert.equal(arzinja.buySettlement.feeAsset, "UNKNOWN");
  assert.equal(arzinja.sellSettlement.provenance, "UNKNOWN");
  assert.deepEqual(settlementFor("bit24", "sell"), {
    feeAsset: "UNKNOWN",
    debitMode: "UNKNOWN",
    provenance: "UNKNOWN"
  });

  // Arzinja is marked reference-only, semantically and visually.
  assert.equal(arzinja.referenceOnly, true);
  assert.ok(read("src/components/shadowArbitrage/SourcesPanel.tsx").includes("فقط مرجع"));

  // Expiry comes from the confirmation date plus the reported window.
  assert.equal(nobitex.feeExpiresAt, "2026-09-29T00:00:00.000Z");
  assert.equal(feeExpiryIso(null, 90), null);
  assert.equal(feeExpiryIso("2026-07-01T00:00:00.000Z", null), null);

  // A venue the accounts endpoint never described keeps nulls, not defaults.
  const partial = buildVenueRows({
    certifications: [],
    health: [],
    snapshots: [{ sourceId: "bit24", sourceName: "بیت۲۴", health: "degraded", ageMs: 1 }] as never,
    venues: [],
    feeReverifyDays: null
  });
  assert.equal(partial[0].takerFeeBps, null);
  assert.equal(partial[0].accountState, null);
  assert.equal(partial[0].requiredAction, null);

  const summary = summarizeVenues(rows);
  assert.equal(summary.total, 2);
  assert.equal(summary.healthy, 1);
  assert.equal(summary.accountsReady, 1);
  assert.equal(summary.feesCurrent, 1);
  assert.equal(summary.feesUnknown, 1);
  assert.equal(summary.referenceOnly, 1);
});

await test("8B both tabs reuse the shared glass primitives and add no material", () => {
  const op = read("src/components/shadowArbitrage/OpportunitiesPanel.tsx");
  const sr = read("src/components/shadowArbitrage/SourcesPanel.tsx");

  const surfaces: Array<[string, string, string]> = [
    ["opportunity summary", op, 'className="panel sa-panel sa-op-summary"'],
    ["filter rail", op, 'className="panel sa-panel sa-op-filterbar"'],
    ["category group", op, "panel sa-panel sa-op-group"],
    ["size segmented control", op, 'className="sa-op-segmented glass-tabbar"'],
    ["active segment", op, "is-active glass-control"],
    ["filter input", op, "sa-input glass-control sa-op-control"],
    ["filter select", op, "sa-select glass-control sa-op-control"],
    ["mobile card", op, 'className="sa-op-card glass-control"'],
    ["clear action", op, 'className="sa-op-clear glass-control"'],
    ["sources summary", sr, 'className="panel sa-panel sa-sr-summary"'],
    ["health table panel", sr, 'className="panel sa-panel" aria-label="سلامت منبع و داده"'],
    ["readiness table panel", sr, 'className="panel sa-panel" aria-label="آمادگی حساب و کارمزد"']
  ];
  for (const [name, src, needle] of surfaces) {
    assert.ok(src.includes(needle), `${name} must reuse a shared primitive (${needle})`);
  }
  // Panel structure comes from the shared header/body classes.
  assert.ok(op.includes("panel-header sa-panel-header") && op.includes('className="panel-body'));
  assert.ok(sr.includes("panel-header sa-panel-header") && sr.includes('className="panel-body'));
  // No inline styling sneaks a surface in through the back door.
  for (const src of [op, sr]) {
    assert.equal(/style=\{\{/.test(src), false, "no inline styles");
  }
});

await test("8B Phase 8B CSS declares layout only — no forked material", () => {
  const css = stripComments(phase8bCss());

  assert.equal(/backdrop-filter\s*:/.test(css), false, "blur must come from the primitives");
  assert.equal(/box-shadow\s*:/.test(css), false, "shadows must come from the primitives");

  // Backgrounds: only the reset and the semantic status rail.
  const backgrounds = [...css.matchAll(/background\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
  const allowed = ["none", "var(--green)", "var(--yellow)", "var(--red)", "var(--line)"];
  for (const bg of backgrounds) {
    assert.ok(allowed.includes(bg), `unexpected surface background in Phase 8B CSS: ${bg}`);
  }
  // Colours are tokens or mixes of tokens — no new literals.
  assert.deepEqual([...new Set([...css.matchAll(/#[0-9a-fA-F]{3,8}/g)].map((m) => m[0]))], []);
  assert.equal(/rgba?\(\s*\d/.test(css), false, "no raw rgb()/rgba() values");
  // Borders and radii are structural or token-derived only.
  const borders = [...css.matchAll(/border[a-z-]*\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
  for (const b of borders) {
    assert.ok(
      b === "0" || b.includes("999px") || b.includes("var(--radius"),
      `unexpected border declaration: ${b}`
    );
  }
});

await test("8B every new selector is scoped under .sa-*", () => {
  const css = stripComments(phase8bCss());
  // Collect each selector group: lines accumulate until one opens a block.
  const selectors: string[] = [];
  let buffer: string[] = [];
  for (const raw of css.split("\n")) {
    const line = raw.trim();
    if (!line || line === "}" || line.endsWith(";")) {
      buffer = [];
      continue;
    }
    if (line.endsWith("{")) {
      const group = [...buffer, line.slice(0, -1)].join(" ").trim();
      buffer = [];
      if (group.startsWith("@") || !group) continue;
      for (const one of group.split(",")) {
        const selector = one.trim();
        if (selector) selectors.push(selector);
      }
      continue;
    }
    buffer.push(line);
  }
  assert.ok(selectors.length > 30, "the section must actually contain rules");
  for (const selector of selectors) {
    assert.ok(selector.includes(".sa-"), `unscoped selector leaked into globals: ${selector}`);
  }
});

await test("8B the page never scrolls sideways — only tables and rails do", () => {
  const css = phase8bCss();

  // Grid tracks can shrink, so a long cell cannot push the page wider.
  const gridTracks = [...css.matchAll(/grid-template-columns\s*:\s*([^;]+);/g)].map((m) =>
    m[1].trim()
  );
  for (const track of gridTracks) {
    assert.ok(
      track.includes("minmax(0,") || track.includes("minmax(190px, 1fr)"),
      `grid track must be able to shrink: ${track}`
    );
  }
  // Containers opt out of the min-content floor.
  assert.ok(css.includes("min-width: 0"));
  // Horizontal scrolling is delegated to the table wrapper and the segmented rail.
  assert.ok(read("app/globals.css").includes(".sa-table-wrap {"));
  const segmented = css.slice(css.indexOf(".sa-op-segmented {"), css.indexOf(".sa-op-seg {"));
  assert.ok(segmented.includes("overflow-x: auto"));

  // Below 768px the wide table is replaced by cards instead of being squeezed.
  const mobile = css.slice(css.indexOf("@media (max-width: 768px)"));
  assert.ok(mobile.slice(0, 700).includes(".sa-op-table-wrap"));
  assert.ok(mobile.slice(0, 700).includes("display: none"));
  assert.ok(mobile.slice(0, 700).includes(".sa-op-cards"));
  assert.ok(css.includes(".sa-op-cards {\n  display: none;\n}"), "cards are desktop-hidden");
});

await test("8B RTL numbers, ratios and route strings are bidi-isolated", () => {
  const css = phase8bCss();
  const rule = css.slice(css.indexOf(".sa-bidi {"));
  assert.ok(rule.slice(0, 120).includes("direction: ltr"));
  assert.ok(rule.slice(0, 120).includes("unicode-bidi: isolate"));

  const bidi = read("src/components/shadowArbitrage/Bidi.tsx");
  assert.ok(bidi.includes('className="sa-bidi"'));

  // Both tabs use it for percentages, ratios and latency figures.
  const op = read("src/components/shadowArbitrage/OpportunitiesPanel.tsx");
  const sr = read("src/components/shadowArbitrage/SourcesPanel.tsx");
  assert.ok(op.includes("<Bidi>{formatPercentFa(o.rawSpreadPercent, 3, true)}</Bidi>"));
  assert.ok(sr.includes("<Bidi>{formatPercentFa(r.availabilityPercent, 1)}</Bidi>"));
  assert.ok(sr.includes("p50 ${toFaDigits(r.latencyP50Ms)}ms"));
  assert.ok(sr.includes("toFaDigits(summary.healthy)} / ${toFaDigits(summary.total)"));
});

await test("8B the tabs are keyboard reachable and labelled", () => {
  const op = read("src/components/shadowArbitrage/OpportunitiesPanel.tsx");
  const sr = read("src/components/shadowArbitrage/SourcesPanel.tsx");

  // Rows and cards are operable with a keyboard, not click-only.
  assert.equal((op.match(/tabIndex=\{0\}/g) ?? []).length, 2, "table row and mobile card");
  assert.ok(op.includes('e.key === "Enter" || e.key === " "'));
  assert.ok(op.includes("aria-label={`جزئیات محاسبهٔ خرید از"));
  // Filters announce themselves.
  assert.ok(op.includes('role="group" aria-label="حجم معامله"'));
  assert.ok(op.includes('aria-label="فیلترها و مرتب‌سازی"'));
  assert.ok(op.includes("aria-pressed="));
  // Tables carry scoped headers and section labels.
  assert.ok((sr.match(/scope="col"/g) ?? []).length > 10);
  assert.ok(sr.includes('aria-expanded={editing === r.sourceId}'));
  // Focus is visible for every custom control.
  const css = phase8bCss();
  assert.ok(css.includes(".sa-op-seg:focus-visible"));
  assert.ok(css.includes(".sa-op-card:focus-visible"));
});

await test("8B every data state is explicit and none of them fabricates data", () => {
  const op = read("src/components/shadowArbitrage/OpportunitiesPanel.tsx");
  const sr = read("src/components/shadowArbitrage/SourcesPanel.tsx");

  for (const [name, src] of [["opportunities", op], ["sources", sr]] as const) {
    assert.ok(src.includes("if (error)"), `${name} has an error state`);
    assert.ok(src.includes("loading &&"), `${name} has a loading state`);
    assert.ok(src.includes("sa-empty"), `${name} has an empty state`);
    assert.ok(src.includes('aria-busy'), `${name} announces loading`);
  }
  // Stale and partial data are called out rather than presented as current.
  assert.ok(op.includes("stale ?") && op.includes("بودجهٔ تازگی"));
  assert.ok(sr.includes("const partial = venues.length === 0"));
  assert.ok(sr.includes("سلامت منابع همچنان معتبر است"));
});

await test("8B the redesign adds no order, credential, balance or transfer path", () => {
  const files = [
    "src/components/shadowArbitrage/OpportunitiesPanel.tsx",
    "src/components/shadowArbitrage/SourcesPanel.tsx",
    "src/components/shadowArbitrage/opportunityModel.ts",
    "src/components/shadowArbitrage/sourcesModel.ts",
    "src/components/shadowArbitrage/Bidi.tsx",
    "src/components/ShadowArbitrageView.tsx"
  ];
  const banned = [
    /placeOrder/i,
    /cancelOrder/i,
    /createOrder/i,
    /\bwithdraw/i,
    /\bdeposit\(/i,
    /transferFunds/i,
    /apiKey/i,
    /apiSecret/i,
    /privateKey/i,
    /passphrase/i,
    /fetchBalance/i,
    /signRequest/i
  ];
  for (const file of files) {
    const src = stripComments(read(file));
    for (const pattern of banned) {
      assert.equal(pattern.test(src), false, `${file} must not contain ${pattern}`);
    }
  }

  // The only write the redesigned tabs perform is the existing fee-evidence POST.
  const sr = read("src/components/shadowArbitrage/SourcesPanel.tsx");
  const posts = [...sr.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(posts, ["POST"]);
  const endpoints = [...sr.matchAll(/fetch\("([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(endpoints, ["/api/shadow-arbitrage/accounts"]);
  // And it still refuses to carry a secret.
  assert.ok(sr.includes("هیچ کلید API، رمز یا دسترسی حسابی"));

  // Real execution stays unimplemented and disarmed.
  const capability = read("src/lib/shadowArbitrage/live/capability.ts");
  assert.ok(capability.includes("export const LIVE_EXECUTION_IMPLEMENTED = false as const"));
  assert.equal(/process\.env/.test(capability), false);
});

await test("8B the redesign touches presentation only — backend files are untouched", async () => {
  // Structural boundary: no Shadow UI file may reach into the server layer.
  const uiFiles = [
    "src/components/shadowArbitrage/OpportunitiesPanel.tsx",
    "src/components/shadowArbitrage/SourcesPanel.tsx",
    "src/components/shadowArbitrage/opportunityModel.ts",
    "src/components/shadowArbitrage/sourcesModel.ts"
  ];
  for (const file of uiFiles) {
    const src = read(file);
    for (const forbidden of ["@/db/", "next/server", "drizzle-orm", "@/lib/requireAdmin"]) {
      assert.equal(src.includes(forbidden), false, `${file} must not import ${forbidden}`);
    }
  }

  // And the released backend really is byte-identical, proven by git.
  const { execFileSync } = await import("node:child_process");
  const paths = [
    "app/api",
    "src/db",
    "drizzle",
    "src/lib/shadowArbitrage",
    "src/lib/ops",
    "middleware.ts",
    "instrumentation.node.ts",
    "next.config.ts"
  ];
  let baseline = "";
  try {
    baseline = execFileSync("git", ["rev-parse", "--verify", "v4.12.0^{commit}"], {
      encoding: "utf8"
    }).trim();
  } catch {
    baseline = "";
  }
  if (baseline) {
    const changed = execFileSync("git", ["diff", "--name-only", baseline, "--", ...paths], {
      encoding: "utf8"
    }).trim();
    assert.equal(changed, "", `backend files changed since v4.12.0: ${changed}`);
  } else {
    console.log("        (note: tag v4.12.0 unavailable — import boundary checked only)");
  }
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
