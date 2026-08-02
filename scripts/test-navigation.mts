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
const {
  SHADOW_TABS,
  SHADOW_TAB_ALIASES,
  DEFAULT_SHADOW_TAB,
  isLegacyShadowTab,
  parseShadowTab,
  shadowTabLabel
} = await import("../src/components/shadowArbitrage/tabs.ts");

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


/* ── Phase 8C-1 — four operator sections ─────────────────────────────────── */

await test("8C the four operator sections exist in order with Persian labels", () => {
  assert.deepEqual(
    SHADOW_TABS.map((t) => t.id),
    ["command", "capital", "trades", "settings"]
  );
  assert.deepEqual(
    SHADOW_TABS.map((t) => t.labelFa),
    ["مرکز فرماندهی", "سرمایه و تخصیص", "فرصت‌ها و معاملات", "تنظیمات و ایمنی"]
  );
  // Every section carries a Persian one-line explanation for its tooltip.
  for (const t of SHADOW_TABS) {
    assert.ok(t.hintFa.length > 10, `${t.id} needs a hint`);
    assert.equal(/[a-zA-Z]{4,}/.test(t.labelFa), false, "labels are Persian, not codes");
  }
});

await test("8C Command Center is the default and unknown values fall back to it", () => {
  assert.equal(DEFAULT_SHADOW_TAB, "command");
  assert.equal(SHADOW_TABS[0].id, DEFAULT_SHADOW_TAB);
  assert.equal(parseShadowTab(null), "command");
  assert.equal(parseShadowTab(undefined), "command");
  assert.equal(parseShadowTab(""), "command");
  assert.equal(parseShadowTab("nope"), "command");
  assert.equal(parseShadowTab("../etc"), "command");
  // A known slug round-trips exactly.
  for (const t of SHADOW_TABS) {
    assert.equal(parseShadowTab(t.id), t.id);
    assert.equal(shadowTabLabel(t.id), t.labelFa);
  }
});

await test("8C every retired tab URL still resolves, to the section that owns it", () => {
  // The seven Phase 8A slugs, each landing where its content actually went.
  const expected: Record<string, string> = {
    overview: "command",
    paper: "command",
    opportunities: "trades",
    analytics: "trades",
    capital: "capital",
    sources: "settings",
    live: "settings"
  };
  assert.deepEqual({ ...SHADOW_TAB_ALIASES }, expected);
  for (const [legacy, section] of Object.entries(expected)) {
    assert.equal(parseShadowTab(legacy), section, `?tab=${legacy} must land on ${section}`);
    // No retired slug may silently fall through to the default instead.
    if (section !== DEFAULT_SHADOW_TAB) {
      assert.notEqual(parseShadowTab(legacy), DEFAULT_SHADOW_TAB);
    }
  }
  // A retired slug is recognised as such; a current one and junk are not.
  assert.equal(isLegacyShadowTab("overview"), true);
  assert.equal(isLegacyShadowTab("command"), false);
  assert.equal(isLegacyShadowTab(null), false);
  assert.equal(isLegacyShadowTab(""), false);

  // The page rewrites a retired address to the new one, without a history entry.
  const view = read("src/components/ShadowArbitrageView.tsx");
  assert.ok(view.includes("if (!isLegacyShadowTab(rawTab)) return;"));
  assert.ok(view.includes('params.set("tab", tab);'));
  assert.ok(view.includes("router.replace("));
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

await test("8C every existing panel survives, in the section that now owns it", () => {
  const view = read("src/components/ShadowArbitrageView.tsx");
  const sectionTab: Array<[string, string]> = [
    ["CommandCenter", "command"],
    ["OverviewPanel", "command"],
    ["ObservationHeader", "command"],
    ["PaperExecution", "command"],
    ["CapitalSimulator", "capital"],
    ["OpportunitiesPanel", "trades"],
    ["AnalyticsPanels", "trades"],
    ["SourcesPanel", "settings"],
    ["LiveReadiness", "settings"]
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
  const liveGuard = view.lastIndexOf('tab === "settings"', view.indexOf("<LiveReadiness"));
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
  /*
   * Mutating calls, all simulation-only: the pre-existing pause/resume control,
   * and the two Phase 8C-5 allocation actions. Proposing only computes and
   * stores; applying rewrites VIRTUAL balances behind an explicit admin press.
   * None of them can reach an exchange.
   */
  const posts = view.match(/method: "POST"/g) ?? [];
  assert.equal(posts.length, 3);
  assert.ok(view.includes('JSON.stringify({ action })'));
  assert.ok(view.includes('action: "propose_allocation"'));
  assert.ok(view.includes('action: "apply_allocation"'));
  // Applying is idempotent by construction: the key is derived, not random.
  assert.ok(view.includes("idempotencyKey: `apply:${proposal.id}`"));
  assert.equal(/Math\.random\(\)/.test(view), false, "an idempotency key must be deterministic");
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
  const start = css.indexOf("Phase 8B opportunities and sources");
  const end = css.indexOf("Phase 8C command center");
  return css.slice(start, end > start ? end : undefined);
}

/** Only the Phase 8C section — the Command Center. */
function phase8cCss(): string {
  const css = read("app/globals.css");
  return css.slice(css.indexOf("Phase 8C command center"));
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
  assert.ok(preview.includes('process.env.PREVIEW_TABS ?? "command"'));
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
  // Boot and isolation live in the shared runtime both browser tools use.
  const raw = read("scripts/previewRuntime.mts");
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
  // The screenshot tool itself only frames and captures.
  const shots = stripComments(read("scripts/preview-shadow-ui.mts"));
  assert.ok(shots.includes("Page.captureScreenshot"));
  assert.equal(shots.includes("AUTH_TOKEN_SECRET"), false, "it never handles the secret itself");
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
  OPPORTUNITY_PAGE_SIZES,
  OPPORTUNITY_SORTS,
  activeFilterCount,
  evidenceFor,
  filterOpportunities,
  groupOpportunities,
  indexPaperEvidence,
  paginate,
  primaryBlockingReason,
  sortOpportunities,
  summarizeOpportunities
} = await import("../src/components/shadowArbitrage/opportunityModel.ts");

const { buildVenueRows, summarizeVenues, feeExpiryIso, settlementFor } = await import(
  "../src/components/shadowArbitrage/sourcesModel.ts"
);

const { readInt } = await import("../src/components/shadowArbitrage/urlState.ts");

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

  assert.deepEqual(filterOpportunities(rows, f).map((o) => o.id), ["a", "b", "d"]);
  assert.deepEqual(
    filterOpportunities(rows, { ...f, includeCompleted: true }).map((o) => o.id),
    ["a", "b", "c", "d"]
  );
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

  const tied = [
    opp({ id: "z", rawSpreadPercent: 0.5, durationMs: 5 }),
    opp({ id: "a", rawSpreadPercent: 0.5, durationMs: 5 }),
    opp({ id: "m", rawSpreadPercent: 0.5, durationMs: 5 })
  ];
  const once = sortOpportunities(tied, "duration", new Map()).map((o) => o.id);
  const twice = sortOpportunities([...tied].reverse(), "duration", new Map()).map((o) => o.id);
  assert.deepEqual(once, ["a", "m", "z"]);
  assert.deepEqual(once, twice, "input order must not change the result");
  assert.deepEqual(tied.map((o) => o.id), ["z", "a", "m"]);
  for (const s of OPPORTUNITY_SORTS) {
    assert.equal(sortOpportunities(rows, s.key, evidence).length, rows.length);
  }
});

await test("8B pagination is deterministic, complete and self-correcting", () => {
  const rows = Array.from({ length: 48 }, (_, i) => `r${String(i).padStart(2, "0")}`);
  assert.deepEqual([...OPPORTUNITY_PAGE_SIZES], [10, 20, 50]);

  const first = paginate(rows, 1, 20);
  assert.deepEqual(first.rows, rows.slice(0, 20));
  assert.equal(first.page, 1);
  assert.equal(first.pageCount, 3);
  assert.equal(first.total, 48);
  assert.equal(first.from, 1);
  assert.equal(first.to, 20);

  const last = paginate(rows, 3, 20);
  assert.deepEqual(last.rows, rows.slice(40));
  assert.equal(last.from, 41);
  assert.equal(last.to, 48);

  // Every row appears exactly once across the pages — nothing is dropped.
  const walked = [1, 2, 3].flatMap((p) => paginate(rows, p, 20).rows);
  assert.deepEqual(walked, rows);

  // A page beyond the end clamps to the last page instead of showing nothing.
  assert.equal(paginate(rows, 99, 20).page, 3);
  assert.equal(paginate(rows, 0, 20).page, 1);
  assert.equal(paginate(rows, -5, 10).page, 1);
  // An empty list still reports a usable page.
  const empty = paginate([], 4, 10);
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.page, 1);
  assert.equal(empty.pageCount, 1);
  assert.equal(empty.from, 0);
  assert.equal(empty.to, 0);
  // Same input, same output.
  assert.deepEqual(paginate(rows, 2, 10).rows, paginate(rows, 2, 10).rows);

  // URL integers are clamped, never trusted.
  assert.equal(readInt("abc", 1, 1, 50), 1);
  assert.equal(readInt("999", 1, 1, 50), 50);
  assert.equal(readInt("-3", 1, 1, 50), 1);
  assert.equal(readInt("20", 1, 1, 50), 20);
});

await test("8B category, page and page size survive a reload", () => {
  const panel = read("src/components/shadowArbitrage/OpportunitiesPanel.tsx");
  const sources = read("src/components/shadowArbitrage/SourcesPanel.tsx");
  const url = read("src/components/shadowArbitrage/urlState.ts");

  // The view state is read from the query string, not from component state.
  assert.ok(panel.includes('read("cat", "valid")'));
  assert.ok(panel.includes('read("page", "1")'));
  assert.ok(panel.includes('read("per", "20")'));
  assert.ok(sources.includes('read("sv", "health")'));
  assert.ok(sources.includes('read("spage", "1")'));
  assert.equal(/useState[^\n]*\b(page|category|cat)\b/i.test(panel), false, "not local state");

  // Selecting writes it back without stacking history or jumping the page.
  assert.ok(panel.includes('write({ cat: c, page: "1" })'), "category resets paging");
  assert.ok(panel.includes('write({ per: String(n), page: "1" })'), "page size resets paging");
  assert.ok(sources.includes('write({ sv: v.id, spage: "1" })'));
  assert.ok(url.includes("router.replace("));
  assert.ok(url.includes("scroll: false"));

  // Any filter change goes back to page 1.
  const setFn = panel.slice(panel.indexOf("const set = <K extends"), panel.indexOf("const evidence"));
  assert.ok(setFn.includes('write({ page: "1" })'), "filters reset paging");
  const clear = panel.slice(panel.indexOf("const clearAll ="), panel.indexOf("if (error)"));
  assert.ok(clear.includes('write({ page: "1" })'));
});

await test("8B paper evidence is joined exactly, or not at all", () => {
  const index = indexPaperEvidence([
    ledger({ lifecycleId: "lc-1", outcome: "SKIPPED", riskAdjustedPnlToman: 1 }),
    ledger({ lifecycleId: "lc-1", outcome: "FILLED", riskAdjustedPnlToman: 2 })
  ]);
  assert.equal(index.get("lc-1")!.outcome, "FILLED");
  assert.equal(index.get("lc-1")!.riskAdjustedPnlToman, 2);
  assert.equal(index.get("lc-1")!.inventoryDeltaUsdt, -0.0875);

  assert.equal(evidenceFor(opp({ id: "lc-1", sizeUsdt: 25 }), index)!.economicNetPnlToman, 35_000);
  assert.equal(evidenceFor(opp({ id: "lc-1", sizeUsdt: 10 }), index), null);
  assert.equal(evidenceFor(opp({ id: "other" }), index), null);

  const skips = indexPaperEvidence([
    ledger({ outcome: "SKIPPED", occurredAt: "2026-07-30T09:00:00.000Z", rejectionCode: "old" }),
    ledger({ outcome: "SKIPPED", occurredAt: "2026-07-30T11:00:00.000Z", rejectionCode: "new" })
  ]);
  assert.equal(skips.get("lc-1")!.rejectionCode, "new");
});

await test("8B one category at a time, with its count in the segment", () => {
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
  assert.equal(summary.shown, 3);
  assert.equal(summary.bestValidNetToman, 8_663);
  assert.equal(summarizeOpportunities(groupOpportunities([rows[2]])).bestValidNetToman, null);

  const panel = read("src/components/shadowArbitrage/OpportunitiesPanel.tsx");
  // A real tablist with three segments, each carrying its own count.
  assert.ok(panel.includes('role="tablist"') && panel.includes('aria-label="دستهٔ فرصت‌ها"'));
  assert.ok(panel.includes('aria-selected={category === c}'));
  assert.ok(panel.includes('<span className="sa-seg-count">{formatCountFa(groups[c].length)}</span>'));
  // Only the selected category is rendered.
  assert.ok(panel.includes("paginate(groups[category], requestedPage, perPage)"));
  assert.equal(panel.includes("CATEGORY_ORDER.map((group) =>"), false, "categories are not stacked");
});

await test("8B the desktop table keeps only the essential columns", () => {
  const panel = read("src/components/shadowArbitrage/OpportunitiesPanel.tsx");
  const head = panel.slice(panel.indexOf("<thead>"), panel.indexOf("</thead>"));
  const headers = [...head.matchAll(/<th[^>]*>([^<]*)</g)].map((m) => m[1].trim());
  assert.equal((head.match(/<th[\s>/]/g) ?? []).length, 9, "nine columns, no more");
  assert.deepEqual(headers.filter(Boolean), [
    "مسیر",
    "حجم",
    "قیمت خرید / فروش",
    "اسپرد خام",
    "کارمزد شناخته‌شده",
    "سود خالص اقتصادی",
    "سود تعدیل‌شده با بافر",
    "وضعیت و تازگی"
  ]);
  // The secondary figures moved into the drawer and are not in the table.
  const drawer = read("src/components/shadowArbitrage/OpportunityDrawer.tsx");
  for (const moved of ["بافر لغزش و ریسک", "سود نقدی تومانی", "برآورد هزینهٔ بازتوازن"]) {
    assert.equal(head.includes(moved), false, `${moved} must not be a column`);
    assert.ok(drawer.includes(moved), `${moved} must live in the details drawer`);
  }
  // Every row can open that drawer.
  assert.ok(panel.includes('className="sa-btn-details glass-control"'));
  assert.ok(panel.includes("onClick={() => onSelect(o)}"));
});

await test("8B the exact blocking reasons are preserved, never summarised away", () => {
  const reasons = ["stale_sell_source", "fee_unknown", "insufficient_buy_depth"];
  const o = opp({ eligibility: "BLOCKED", blockedReasons: reasons });
  assert.equal(primaryBlockingReason(o), "stale_sell_source");
  assert.equal(primaryBlockingReason(opp({ blockedReasons: [] })), null);

  const panel = read("src/components/shadowArbitrage/OpportunitiesPanel.tsx");
  // The list itself is rendered in full by the drawer, never truncated.
  const drawer = read("src/components/shadowArbitrage/OpportunityDrawer.tsx");
  assert.ok(drawer.includes("o.blockedReasons.map((r, i) =>"));
  assert.equal(/blockedReasons\.slice\(0,\s*\d\)/.test(drawer), false, "reasons must not be capped");
  assert.ok(drawer.includes('className="sa-code"'), "technical codes stay in the drawer");
  // The table leads with the primary reason and explains it in plain Persian.
  assert.ok(panel.includes("title={blockedDetail(primary)}"));
  assert.equal(/<code/.test(panel), false, "no technical codes in the primary UI");
  assert.equal(panel.includes("مسدود شده است"), false, "no generic catch-all reason");
});

await test("8B missing figures render as an em dash with a reason, never as zero", () => {
  const panel = read("src/components/shadowArbitrage/OpportunitiesPanel.tsx");
  const money = panel.slice(panel.indexOf("function Money("));
  assert.ok(money.includes("if (value === null)"));
  assert.ok(money.includes("—"));
  assert.ok(money.includes("title={UNKNOWN_PNL_FA}"), "and it says why it is missing");
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

  assert.equal(nobitex.health, "healthy");
  assert.equal(nobitex.latencyP95Ms, 400);
  assert.equal(nobitex.accountState, "VERIFIED");
  assert.equal(nobitex.takerFeeBps, 25);

  assert.equal(nobitex.buySettlement.feeAsset, "IRT");
  assert.equal(nobitex.sellSettlement.feeAsset, "USDT");
  assert.equal(nobitex.buySettlement.provenance, "ADMIN_CONFIRMED");
  // Arzinja is a confirmed venue now, like the rest.
  assert.equal(arzinja.buySettlement.feeAsset, "IRT");
  assert.equal(arzinja.sellSettlement.feeAsset, "USDT");
  assert.equal(arzinja.sellSettlement.provenance, "ADMIN_CONFIRMED");
  // A venue nobody confirmed still reads as unknown.
  assert.deepEqual(settlementFor("unlisted-venue", "sell"), {
    feeAsset: "UNKNOWN",
    debitMode: "UNKNOWN",
    provenance: "UNKNOWN"
  });

  assert.equal(arzinja.referenceOnly, true);
  assert.ok(read("src/components/shadowArbitrage/SourcesPanel.tsx").includes("فقط مرجع"));

  assert.equal(nobitex.feeExpiresAt, "2026-09-29T00:00:00.000Z");
  assert.equal(feeExpiryIso(null, 90), null);
  assert.equal(feeExpiryIso("2026-07-01T00:00:00.000Z", null), null);

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

await test("8B the sources tab shows venue cards, one dataset at a time", () => {
  const sources = read("src/components/shadowArbitrage/SourcesPanel.tsx");

  // Two datasets behind one segmented control; only the selected one renders.
  assert.ok(sources.includes('role="tablist"') && sources.includes('aria-label="نمای منابع"'));
  assert.ok(sources.includes('labelFa: "سلامت منابع"'));
  assert.ok(sources.includes('labelFa: "حساب‌ها و کارمزدها"'));
  assert.ok(sources.includes('view === "health" ? ('), "one dataset at a time");

  // Cards, not a wide table — the venue grid has no table at all.
  const grid = sources.slice(sources.indexOf('className="panel-body sa-venue-grid"'), sources.indexOf("<Pager"));
  assert.equal(/<table/.test(grid), false, "venues must never be a clipped table");
  assert.ok(sources.includes('className="panel sa-panel sa-venue-card"'));
  assert.ok(sources.includes("<HealthCard") && sources.includes("<AccountCard"));

  // Each card has a header with the Persian name, market and a status chip,
  // plus a details expansion for everything secondary.
  assert.ok(sources.includes("<strong>{row.nameFa}</strong>"));
  assert.ok(sources.includes("{row.marketSymbol ?? \"—\"}"));
  // «جزئیات» is a real glass action, not a bare disclosure triangle.
  assert.ok(sources.includes("function VenueDetails("));
  assert.ok(sources.includes('className="sa-btn-details glass-control"'));
  assert.ok(sources.includes("aria-expanded={open}"));
  assert.equal(sources.includes("<details"), false, "no unstyled native disclosure");
  // Only the essential metrics stay on the card face; the rest is behind it.
  const accountCard = sources.slice(sources.indexOf("function AccountCard("));
  const face = accountCard.slice(0, accountCard.indexOf("<VenueDetails>"));
  assert.equal((face.match(/<Metric/g) ?? []).length, 4, "a compact 2×2 block of metrics");
  const behind = accountCard.slice(accountCard.indexOf("<VenueDetails>"));
  for (const secondary of ["تاریخ تأیید", "انقضای اعتبار", "اقدام لازم", "دلیل مسدودی"]) {
    assert.ok(behind.includes(secondary), `${secondary} belongs in the details block`);
  }

  // Six cards a page, paged with the shared control.
  assert.ok(sources.includes("const VENUES_PER_PAGE = 6"));
  assert.ok(sources.includes("paginate(rows, requestedPage, VENUES_PER_PAGE)"));
  assert.ok(sources.includes("perPage={VENUES_PER_PAGE}"));
});

await test("8B both tabs reuse the shared glass primitives and add no material", () => {
  const op = read("src/components/shadowArbitrage/OpportunitiesPanel.tsx");
  const sr = read("src/components/shadowArbitrage/SourcesPanel.tsx");
  const kit = read("src/components/shadowArbitrage/panelKit.tsx");

  const surfaces: Array<[string, string, string]> = [
    ["KPI card", kit, "panel sa-panel sa-kpi sa-rail-"],
    ["pager control", kit, 'className="sa-btn-page glass-control"'],
    ["pager size control", kit, 'className="sa-segmented glass-tabbar"'],
    ["filter panel", op, 'className="panel sa-panel" aria-label="فیلتر و جست‌وجو"'],
    ["filter input", op, 'className="sa-control glass-control"'],
    ["size segmented control", op, 'className="sa-segmented glass-tabbar"'],
    ["category control", op, 'className="sa-segmented sa-segmented-lg glass-tabbar"'],
    ["active segment", op, "is-active glass-control"],
    ["mobile card", op, 'className="sa-op-card glass-control"'],
    ["details action", op, 'className="sa-btn-details glass-control"'],
    ["mobile disclosure", op, 'className="sa-more-btn glass-control"'],
    ["venue view control", sr, 'className="sa-segmented sa-segmented-lg glass-tabbar"'],
    ["venue card", sr, 'className="panel sa-panel sa-venue-card"']
  ];
  for (const [name, src, needle] of surfaces) {
    assert.ok(src.includes(needle), `${name} must reuse a shared primitive (${needle})`);
  }
  // Every major section is a real panel with a header and a body.
  for (const src of [op, sr]) {
    assert.ok(src.includes("panel-header sa-panel-header"));
    assert.ok(src.includes('<h3 className="panel-title">'));
    assert.ok(src.includes('className="panel-body'));
    assert.equal(/style=\{\{/.test(src), false, "no inline styles");
  }
});

await test("8B Phase 8B CSS declares layout only — no forked material", () => {
  const css = stripComments(phase8bCss());

  assert.equal(/backdrop-filter\s*:/.test(css), false, "blur must come from the primitives");
  assert.equal(/box-shadow\s*:/.test(css), false, "shadows must come from the primitives");

  const backgrounds = [...css.matchAll(/background\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
  const allowed = ["none", "var(--green)", "var(--yellow)", "var(--red)", "var(--line)"];
  for (const bg of backgrounds) {
    assert.ok(allowed.includes(bg), `unexpected surface background in Phase 8B CSS: ${bg}`);
  }
  assert.deepEqual([...new Set([...css.matchAll(/#[0-9a-fA-F]{3,8}/g)].map((m) => m[0]))], []);
  assert.equal(/rgba?\(\s*\d/.test(css), false, "no raw rgb()/rgba() values");

  const borders = [...css.matchAll(/border[a-z-]*\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
  for (const b of borders) {
    assert.ok(
      b === "0" ||
        b.includes("999px") ||
        b.includes("var(--radius") ||
        b.includes("var(--line-soft)"),
      `unexpected border declaration: ${b}`
    );
  }
});

await test("8B the type scale matches the main OTC dashboard", () => {
  const css = stripComments(phase8bCss());
  const globals = read("app/globals.css");

  // The dashboard's own reference values.
  assert.ok(globals.includes("th,\ntd {"), "the shared table rule exists");
  const table = globals.slice(globals.indexOf("th,\ntd {"), globals.indexOf("tr:last-child td"));
  assert.ok(table.includes("font-size: 13px"), "dashboard tables are 13px");
  const metric = globals.slice(globals.indexOf(".metric-label {"), globals.indexOf(".toman-amount {"));
  assert.ok(metric.includes("font-size: 12px"), "dashboard metric labels are 12px");
  assert.ok(metric.includes("font-size: 22px"), "dashboard metric values are 22px");

  // Shadow now uses the same figures rather than shrinking to fit columns.
  const cells = css.slice(css.indexOf(".sa-op-table th,"), css.indexOf(".sa-stack-2 {"));
  assert.ok(cells.includes("font-size: 13px"));
  assert.ok(cells.includes("padding: 12px 10px"));
  const kpi = css.slice(css.indexOf(".sa-kpi-label {"), css.indexOf(".sa-segmented {"));
  assert.ok(kpi.includes("font-size: 12px"));
  assert.ok(kpi.includes("font-size: 22px"));

  // Nothing in the section drops below 12px any more.
  const sizes = [...css.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length > 10);
  assert.equal(
    sizes.filter((n) => n < 12).length,
    0,
    `text must not shrink below 12px: ${sizes.filter((n) => n < 12).join(", ")}`
  );
});

await test("8B the KPI grid is four, two, then a 2×2 block", () => {
  const css = stripComments(phase8bCss());
  const grid = css.slice(css.indexOf(".sa-kpi-grid {"), css.indexOf(".sa-kpi {"));
  assert.ok(grid.includes("grid-template-columns: repeat(4, minmax(0, 1fr))"), "desktop: four");

  const tablet = css.slice(css.indexOf("@media (max-width: 1024px)"));
  assert.ok(tablet.slice(0, 400).includes(".sa-kpi-grid"));
  assert.ok(tablet.slice(0, 400).includes("repeat(2, minmax(0, 1fr))"), "tablet: two");

  // The phone keeps two columns — a compact 2×2 block, not one long column.
  const phone = css.slice(css.indexOf("@media (max-width: 560px)"));
  assert.equal(phone.includes(".sa-kpi-grid"), false, "the 2-column KPI grid carries over");
  assert.ok(phone.includes(".sa-kpi-value"), "only the figure size tightens");

  // Each card carries a label, one number and one supporting line — nothing else.
  const kit = read("src/components/shadowArbitrage/panelKit.tsx");
  const kpi = kit.slice(kit.indexOf("export function Kpi("), kit.indexOf("export function Pager("));
  assert.equal((kpi.match(/sa-kpi-/g) ?? []).length, 4, "label, value, hint and the body wrapper");
});

await test("8B the page never scrolls sideways — only tables and rails do", () => {
  const css = stripComments(phase8bCss());

  const gridTracks = [...css.matchAll(/grid-template-columns\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
  for (const track of gridTracks) {
    assert.ok(
      track.includes("minmax(0,") || track.includes("minmax(190px, 1fr)") || track.includes("minmax(200px, 1fr)"),
      `grid track must be able to shrink: ${track}`
    );
  }
  assert.ok(css.includes("min-width: 0"));
  assert.ok(read("app/globals.css").includes(".sa-table-wrap {"));
  const segmented = css.slice(css.indexOf(".sa-segmented {"), css.indexOf(".sa-seg {"));
  assert.ok(segmented.includes("overflow-x: auto"));

  // Below 768px the wide table is replaced by cards instead of being squeezed.
  const mobile = css.slice(css.indexOf("@media (max-width: 768px)"));
  const head = mobile.slice(0, 900);
  assert.ok(head.includes(".sa-op-table-wrap"));
  assert.ok(head.includes("display: none"));
  assert.ok(head.includes(".sa-op-cards"));
  assert.ok(css.includes(".sa-op-cards {\n  display: none;\n}"), "cards are desktop-hidden");
  // And venue cards drop to a single column, while their metrics stay 2×2.
  assert.ok(head.includes(".sa-venue-grid"));
  const metrics = css.slice(css.indexOf(".sa-venue-metrics {"), css.indexOf(".sa-venue-metric {"));
  assert.ok(metrics.includes("repeat(2, minmax(0, 1fr))"));
  const phone = css.slice(css.indexOf("@media (max-width: 560px)"));
  assert.equal(
    /\.sa-venue-metrics \{[^}]*grid-template-columns/.test(phone),
    false,
    "the 2×2 metric block carries over to the phone"
  );
});

await test("8B mobile reaches the first result without the whole filter form", () => {
  const css = stripComments(phase8bCss());
  const panel = read("src/components/shadowArbitrage/OpportunitiesPanel.tsx");

  // Desktop: one row of controls — search, size, venue, sort — then the chips.
  const body = css.slice(css.indexOf(".sa-filter-body {"), css.indexOf(".sa-field {"));
  assert.ok(body.includes("grid-template-columns: repeat(4, minmax(0, 1fr))"), "four controls in a row");
  assert.ok(body.includes("display: contents"), "the collapsible block joins that row on desktop");
  assert.ok(body.includes("grid-column: 1 / -1"), "the chips get their own full-width row");
  // And the disclosure button only exists on a phone.
  assert.ok(css.includes(".sa-more-btn {\n  display: none;\n}"), "no disclosure button on desktop");

  // Mobile: the button appears and the advanced block collapses by default.
  const mobile = css.slice(css.indexOf("@media (max-width: 768px)"), css.indexOf("@media (max-width: 560px)"));
  assert.ok(mobile.includes(".sa-more-btn"));
  assert.ok(mobile.includes(".sa-advanced {\n    display: none;\n  }"));
  assert.ok(mobile.includes(".sa-filter-body {\n    grid-template-columns: minmax(0, 1fr);\n  }"));
  assert.ok(mobile.includes(".sa-advanced.is-open"));

  // Search and the category control are outside that collapsed block.
  const advancedMarkup = panel.slice(panel.indexOf('className={`sa-advanced'), panel.indexOf("{/* ── category"));
  assert.equal(advancedMarkup.includes('type="search"'), false, "search stays visible");
  assert.equal(advancedMarkup.includes('role="tablist"'), false, "the category control stays visible");
  assert.ok(panel.includes("aria-expanded={advancedOpen}"));
  assert.ok(panel.includes("فیلترهای بیشتر"));
  assert.ok(panel.includes("پاک‌کردن فیلترها"));
});

await test("8B RTL numbers, ratios and route strings are bidi-isolated", () => {
  const css = phase8bCss();
  const rule = css.slice(css.indexOf(".sa-bidi {"));
  assert.ok(rule.slice(0, 120).includes("direction: ltr"));
  assert.ok(rule.slice(0, 120).includes("unicode-bidi: isolate"));

  assert.ok(read("src/components/shadowArbitrage/Bidi.tsx").includes('className="sa-bidi"'));

  const op = read("src/components/shadowArbitrage/OpportunitiesPanel.tsx");
  const sr = read("src/components/shadowArbitrage/SourcesPanel.tsx");
  const kit = read("src/components/shadowArbitrage/panelKit.tsx");
  assert.ok(op.includes("<Bidi>{formatPercentFa(o.rawSpreadPercent, 3, true)}</Bidi>"));
  assert.ok(sr.includes("toFaDigits(summary.healthy)} / ${toFaDigits(summary.total)"));
  assert.ok(sr.includes("p50 ${toFaDigits(row.latencyP50Ms)}ms"));
  assert.ok(kit.includes("toFaDigits(page)} / ${toFaDigits(pageCount)"), "the page ratio is isolated");
});

await test("8B the tabs are keyboard reachable and labelled", () => {
  const op = read("src/components/shadowArbitrage/OpportunitiesPanel.tsx");
  const sr = read("src/components/shadowArbitrage/SourcesPanel.tsx");
  const kit = read("src/components/shadowArbitrage/panelKit.tsx");

  // Every action is a real button, so it is reachable and operable by keyboard.
  assert.equal(/tabIndex=\{0\}/.test(op), false, "no faux-interactive rows");
  assert.ok((op.match(/type="button"/g) ?? []).length >= 6);
  assert.ok(op.includes("aria-label={`جزئیات محاسبهٔ خرید از"));
  assert.ok(op.includes('role="group" aria-label="حجم معامله"'));
  assert.ok(op.includes('aria-label="فیلتر و جست‌وجو"'));
  assert.ok(op.includes("aria-pressed="));
  assert.ok(kit.includes('aria-label="صفحه‌بندی نتایج"'));
  assert.ok(kit.includes("disabled={page <= 1}") && kit.includes("disabled={page >= pageCount}"));
  assert.ok((sr.match(/scope="col"/g) ?? []).length >= 6);
  assert.ok(sr.includes("aria-expanded={editing}"));

  const css = phase8bCss();
  assert.ok(css.includes(".sa-seg:focus-visible"));
  assert.ok(css.includes(".sa-btn-page:focus-visible"));
  assert.ok(css.includes(".sa-control:focus-visible"));
});

await test("8B every data state is explicit and none of them fabricates data", () => {
  const op = read("src/components/shadowArbitrage/OpportunitiesPanel.tsx");
  const sr = read("src/components/shadowArbitrage/SourcesPanel.tsx");

  for (const [name, src] of [["opportunities", op], ["sources", sr]] as const) {
    assert.ok(src.includes("if (error)"), `${name} has an error state`);
    assert.ok(src.includes("loading &&"), `${name} has a loading state`);
    assert.ok(src.includes("sa-empty"), `${name} has an empty state`);
    assert.ok(src.includes("aria-busy"), `${name} announces loading`);
  }
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
    "src/components/shadowArbitrage/panelKit.tsx",
    "src/components/shadowArbitrage/urlState.ts",
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

  const sr = read("src/components/shadowArbitrage/SourcesPanel.tsx");
  const posts = [...sr.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(posts, ["POST"]);
  const endpoints = [...sr.matchAll(/fetch\("([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(endpoints, ["/api/shadow-arbitrage/accounts"]);
  assert.ok(sr.includes("هیچ\n            کلید API یا اطلاعات محرمانه‌ای"));

  const capability = read("src/lib/shadowArbitrage/live/capability.ts");
  assert.ok(capability.includes("export const LIVE_EXECUTION_IMPLEMENTED = false as const"));
  assert.equal(/process\.env/.test(capability), false);
});

await test("8B the mobile opportunity card carries only the agreed fields", () => {
  const panel = read("src/components/shadowArbitrage/OpportunitiesPanel.tsx");
  const cards = panel.slice(panel.indexOf('className="panel-body sa-op-cards"'), panel.indexOf("<Pager"));

  // Route, size, both prices, risk-adjusted PnL, status and details — no more.
  const lines = [...cards.matchAll(/<CardLine\s+label="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(lines, ["قیمت خرید", "قیمت فروش", "سود تعدیل‌شده با بافر"]);
  assert.ok(cards.includes("<Route o={o} />"));
  assert.ok(cards.includes("sa-op-card-size"));
  assert.ok(cards.includes("<Status"));
  assert.ok(cards.includes('className="sa-btn-details glass-control"'));
  // Everything else stays in the drawer.
  const drawer = read("src/components/shadowArbitrage/OpportunityDrawer.tsx");
  for (const moved of ["اسپرد خام", "بافر لغزش و ریسک", "سود نقدی تومانی"]) {
    assert.equal(cards.includes(moved), false, `${moved} must not be on the mobile card`);
    assert.ok(drawer.includes(moved), `${moved} must be in the drawer`);
  }
});

await test("8B pagination is present, readable and operable on both tabs", () => {
  const kit = read("scripts/../src/components/shadowArbitrage/panelKit.tsx");
  const op = read("src/components/shadowArbitrage/OpportunitiesPanel.tsx");
  const sr = read("src/components/shadowArbitrage/SourcesPanel.tsx");
  assert.ok(op.includes("<Pager") && sr.includes("<Pager"), "both tabs page their results");

  // Count, page number, page size and both directions are all rendered.
  assert.ok(kit.includes("sa-pager-count"));
  assert.ok(kit.includes("sa-pager-page"));
  assert.ok(kit.includes("قبلی") && kit.includes("بعدی"));
  assert.ok(kit.includes("disabled={page <= 1}") && kit.includes("disabled={page >= pageCount}"));

  const css = stripComments(phase8bCss());
  // Readable at the dashboard's scale, and it wraps rather than clipping.
  const pager = css.slice(css.indexOf(".sa-pager {"), css.indexOf(".sa-pager-count,"));
  assert.ok(pager.includes("font-size: 13px"));
  assert.ok(pager.includes("flex-wrap: wrap"));
  const btn = css.slice(css.indexOf(".sa-btn-clear,"), css.indexOf(".sa-btn-clear[disabled],"));
  assert.ok(btn.includes("min-height: 36px"), "a comfortable tap target");
  assert.ok(btn.includes("font-size: 13px"));
  // On a phone the row starts at the leading edge instead of stretching apart.
  const mobile = css.slice(css.indexOf("@media (max-width: 768px)"), css.indexOf("@media (max-width: 560px)"));
  assert.ok(mobile.includes(".sa-pager"));
});

await test("8B typography reuses the project's IRANYekan configuration", () => {
  const globals = read("app/globals.css");
  // The face is declared once, globally, and self-hosted.
  const faces = [...globals.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0]);
  assert.ok(faces.length >= 5, "the shared IRANYekan faces exist");
  assert.ok(faces.every((f) => f.includes('font-family: "IRANYekan"')));
  assert.ok(globals.includes('src: url("/fonts/iranyekanweb'), "self-hosted, not a CDN");

  // Shadow declares no font of its own: its controls inherit, nothing else.
  const shadowCss = stripComments(phase8aCss() + phase8bCss() + phase8cCss());
  const families = [...shadowCss.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.deepEqual([...new Set(families)], ["inherit"], "no Shadow-specific font stack");
  assert.equal(/@font-face/.test(shadowCss), false, "no duplicated face");
  assert.equal(/@import|fonts\.googleapis|cdn/i.test(shadowCss), false, "no remote font");

  for (const file of [
    "src/components/shadowArbitrage/OpportunitiesPanel.tsx",
    "src/components/shadowArbitrage/SourcesPanel.tsx",
    "src/components/shadowArbitrage/panelKit.tsx",
    "src/components/shadowArbitrage/OpportunityDrawer.tsx",
    "src/components/shadowArbitrage/CommandCenter.tsx"
  ]) {
    assert.equal(/font-family|fontFamily/.test(read(file)), false, `${file} must not set a font`);
  }

  // The browser-level proof is a real script, wired into the package manifest.
  const fontTest = read("scripts/test-shadow-fonts.mts");
  assert.ok(fontTest.includes("getComputedStyle"), "it reads what the browser resolved");
  assert.ok(fontTest.includes("document.fonts.check"), "and proves the face really loaded");
  assert.ok(fontTest.includes('const EXPECTED = "IRANYekan"'));
  assert.ok(fontTest.includes('{ name: "mobile"'), "desktop and mobile layouts");
  assert.ok(read("package.json").includes('"test:fonts"'));
});

await test("release version: one authoritative public field, valid package metadata", () => {
  const version = JSON.parse(read("version.json")) as {
    appVersion: string;
    packageMetadataVersion: string;
  };
  const pkg = JSON.parse(read("package.json")) as { version: string; private?: boolean };

  // The product's version is exactly what this release is called.
  assert.equal(version.appVersion, "4.1.3.0");

  // Four-part numbers are not SemVer, which is why they cannot live in
  // package.json: the production image validates it during `pnpm install`.
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
  assert.equal(semver.test(version.appVersion), false, "4.1.3.0 is deliberately not SemVer");
  assert.ok(semver.test(pkg.version), `package.json keeps valid SemVer, found ${pkg.version}`);
  assert.equal(pkg.version, version.packageMetadataVersion, "and the two stay in step");
  assert.equal(pkg.private, true, "the package is never published, so its version is metadata only");

  // One source feeds the build, which feeds the UI.
  const config = read("next.config.ts");
  assert.ok(config.includes('import appVersion from "./version.json"'));
  assert.ok(config.includes("NEXT_PUBLIC_APP_VERSION: appVersion.appVersion"));
  assert.equal(config.includes("packageJson.version"), false, "package.json no longer feeds the UI");

  const lib = read("src/lib/version.ts");
  assert.ok(lib.includes("process.env.NEXT_PUBLIC_APP_VERSION"));
  assert.ok(lib.includes("return `v${version}`"), "the label is v + the version, verbatim");

  // Both places a reader sees it come from that one constant.
  assert.ok(read("src/components/Shell.tsx").includes("formatAppVersionLabel()"));
  assert.ok(read("app/login/page.tsx").includes("{APP_VERSION}"));

  // The number appears nowhere else, and the superseded one appears nowhere.
  for (const file of ["next.config.ts", "src/lib/version.ts", "Dockerfile", "package.json"]) {
    assert.equal(read(file).includes("4.13.0"), false, `${file} must not mention 4.13.0`);
  }

  // The build context carries the file (it is not ignored by Docker).
  const dockerignore = read(".dockerignore");
  assert.equal(dockerignore.split("\n").includes("version.json"), false);
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
  assert.ok(selectors.length > 40, "the section must actually contain rules");
  for (const selector of selectors) {
    assert.ok(selector.includes(".sa-"), `unscoped selector leaked into globals: ${selector}`);
  }
});

await test("8B the UI redesign added no backend logic of its own", async () => {
  const uiFiles = [
    "src/components/shadowArbitrage/OpportunitiesPanel.tsx",
    "src/components/shadowArbitrage/SourcesPanel.tsx",
    "src/components/shadowArbitrage/opportunityModel.ts",
    "src/components/shadowArbitrage/sourcesModel.ts",
    "src/components/shadowArbitrage/panelKit.tsx",
    "src/components/shadowArbitrage/urlState.ts"
  ];
  for (const file of uiFiles) {
    const src = read(file);
    for (const forbidden of ["@/db/", "next/server", "drizzle-orm", "@/lib/requireAdmin"]) {
      assert.equal(src.includes(forbidden), false, `${file} must not import ${forbidden}`);
    }
  }

  const { execFileSync } = await import("node:child_process");
  const paths = [
    "app/api",
    "src/db",
    "drizzle",
    "src/lib/shadowArbitrage",
    "src/lib/ops",
    "middleware.ts",
    "instrumentation.node.ts"
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
    /*
     * Phase 8B itself changed no backend file. The admin-evidence import that
     * followed it deliberately did — an append-only confirmation model needs a
     * table, a writer and the routes that read it — so those files are listed
     * explicitly here. Anything else appearing in this diff is unintended drift.
     */
    const evidenceSurface = new Set([
      // append-only admin evidence
      "app/api/shadow-arbitrage/accounts/route.ts",
      "app/api/shadow-arbitrage/capital/route.ts",
      "app/api/shadow-arbitrage/live-readiness/route.ts",
      "app/api/shadow-arbitrage/paper/route.ts",
      "src/db/repositories/shadowArbitrage.ts",
      "src/db/schema.ts",
      "drizzle/0010_shadow_admin_evidence.sql",
      "src/lib/shadowArbitrage/accounts.ts",
      "src/lib/shadowArbitrage/paper/run.ts",
      "src/lib/shadowArbitrage/paper/broker.ts",
      // the simple paper flow: portfolio maths, pure and dependency-free
      "src/lib/shadowArbitrage/paper/portfolio.ts",
      // Phase 8C-3 dynamic sizing: the pure sizer, its wiring into the engine,
      // the orchestration that feeds it the risk context, and its reason code
      "src/lib/shadowArbitrage/paper/sizing.ts",
      "src/lib/shadowArbitrage/paper/engine.ts",
      "src/lib/shadowArbitrage/paper/reasons.ts",
      // Phase 8C-4 liquidity-aware sizing: the book walker, the role-based
      // allocator, and carrying the observed book through to the sizer
      "src/lib/shadowArbitrage/paper/liquidity.ts",
      "src/lib/shadowArbitrage/paper/allocation.ts",
      "src/lib/shadowArbitrage/adapters/base.ts",
      "src/lib/shadowArbitrage/store.ts",
      "src/lib/shadowArbitrage/types.ts",
      // Phase 8C-5 append-only allocation proposals: additive migration and
      // its repository. Simulation only — it moves virtual balances, never funds.
      "drizzle/0011_shadow_allocation_proposals.sql",
      "src/db/repositories/shadowAllocation.ts",
      "src/lib/shadowArbitrage/live/readiness.ts",
      // certifying Tetherland and Arzinja: direction proof, units, freshness,
      // depth, and routing the confirmed fees into the economics
      "src/lib/shadowArbitrage/adapters/base.ts",
      "src/lib/shadowArbitrage/adapters/index.ts",
      "src/lib/shadowArbitrage/adapters/arzinja.ts",
      "src/lib/shadowArbitrage/adapters/tetherland.ts",
      "src/lib/shadowArbitrage/certification.ts",
      "src/lib/shadowArbitrage/collector.ts",
      "src/lib/shadowArbitrage/config.ts",
      "src/lib/shadowArbitrage/calculate.ts",
      "src/lib/shadowArbitrage/fees.ts"
    ]);
    const changed = execFileSync("git", ["diff", "--name-only", baseline, "--", ...paths], {
      encoding: "utf8"
    })
      .trim()
      .split("\n")
      .filter(Boolean)
      .filter((f) => !evidenceSurface.has(f));
    assert.deepEqual(changed, [], `unexpected backend change since v4.12.0: ${changed.join(", ")}`);

    // Whatever those files gained, the safety boundary did not move.
    const capability = read("src/lib/shadowArbitrage/live/capability.ts");
    assert.ok(capability.includes("export const LIVE_EXECUTION_IMPLEMENTED = false as const"));
    for (const file of [...evidenceSurface]) {
      const src = stripComments(read(file));
      for (const banned of [/placeOrder/i, /cancelOrder/i, /\bwithdraw\(/i, /transferFunds/i]) {
        assert.equal(banned.test(src), false, `${file} must not contain ${banned}`);
      }
      // Credential names appear in these routes only as refusal lists.
      if (/privateKey|apiSecret/.test(src)) {
        assert.ok(
          /forbidden|reject|refus/i.test(src),
          `${file} names a credential field outside a refusal list`
        );
      }
    }

    /*
     * next.config.ts is allowed exactly one change: the release version now
     * comes from version.json instead of package.json. Every other line of it
     * — headers, CSP, tracing, external packages — must be identical.
     */
    const configDiff = execFileSync(
      "git",
      ["diff", "-U0", baseline, "--", "next.config.ts"],
      { encoding: "utf8" }
    );
    const touched = configDiff
      .split("\n")
      .filter((l) => /^[+-]/.test(l) && !/^[+-][+-]/.test(l))
      .map((l) => l.slice(1).trim())
      .filter(Boolean);
    for (const line of touched) {
      assert.ok(
        /version|appVersion|packageJson|^\*|^\/\*|^\*\/|^-|^import type/.test(line),
        `next.config.ts changed outside the version wiring: ${line}`
      );
    }
  } else {
    console.log("        (note: tag v4.12.0 unavailable — import boundary checked only)");
  }
});

/* ══ Phase 8C-2 — the Command Center ═════════════════════════════════════════ */

await test("8C the Command Center answers the standing questions on one screen", () => {
  const cc = read("src/components/shadowArbitrage/CommandCenter.tsx");
  // Every required figure has its own labelled card — no drawer, no fold.
  const labels = [...cc.matchAll(/^\s+label="([^"]+)"$/gm)].map((m) => m[1]);
  assert.deepEqual(labels, [
    "سرمایهٔ کل مجازی",
    "سرمایهٔ تخصیص‌یافته",
    "سرمایهٔ آزاد",
    "سود و زیان امروز",
    "سود و زیان کل",
    "بیشترین افت",
    "معاملات انجام‌شده و رد‌شده",
    "فرصت‌های معتبر"
  ]);

  // The best route is disclosed in full, not summarised into one number.
  for (const dt of [
    "صرافی خرید",
    "صرافی فروش",
    "حجم محاسبه‌شده",
    "سرمایهٔ درگیر",
    "سود خالص تعدیل‌شده",
    "حاشیهٔ تعدیل‌شده"
  ]) {
    assert.ok(cc.includes(`<dt>${dt}</dt>`), `the best-opportunity card must state ${dt}`);
  }

  // Status, collector health and last cycle are in the strip above it.
  for (const needle of ["فقط پایش آزمایشی", "COLLECTOR_STATE_FA[collectorState]", "آخرین چرخهٔ موفق"]) {
    assert.ok(cc.includes(needle), `the status strip must show ${needle}`);
  }
});

await test("8C session create, start, pause and stop live in the Command Center", () => {
  const view = read("src/components/ShadowArbitrageView.tsx");
  // The lifecycle controls are passed into the Command Center, not another tab.
  assert.ok(
    view.includes(
      "sessionControls={<PaperSimple parts={{ session: true, summary: false, ledger: false }} />}"
    ),
    "the session panel is the Command Center's control slot"
  );

  const paper = read("src/components/shadowArbitrage/PaperSimple.tsx");
  // Plain Persian for every step of the lifecycle.
  for (const label of [
    "ساخت نشست جدید از طرح فعلی",
    "شروع ارزیابی",
    "توقف موقت",
    "ادامهٔ ارزیابی",
    "پایان‌دادن نشست (حفظ سابقه)"
  ]) {
    assert.ok(paper.includes(label), `missing control label: ${label}`);
  }
  // Each control posts the action the existing API already accepts.
  for (const action of ["create", "start", "pause", "resume", "stop"]) {
    assert.ok(paper.includes(`action: "${action}"`), `missing ${action} action`);
  }
  const route = read("app/api/shadow-arbitrage/paper/route.ts");
  // Phase 8C-5 added exactly two actions, both simulation-only.
  assert.ok(
    route.includes('["create", "start", "pause", "resume", "stop", "propose_allocation", "apply_allocation"]')
  );
  for (const banned of ["place_order", "arm", "go_live", "withdraw", "deposit", "transfer"]) {
    assert.equal(route.includes(`"${banned}"`), false, `no ${banned} action may exist`);
  }

  // The ledger moved to Opportunities & Trades; the same component renders it.
  assert.ok(
    view.includes("<PaperSimple parts={{ session: false, summary: false, ledger: true }} />")
  );
  assert.ok(paper.includes("export type PaperParts"), "the split is a declared contract");
});

await test("8C diagnostics, gates, policies and evidence sit behind one fold", () => {
  const view = read("src/components/ShadowArbitrageView.tsx");
  // LiveReadiness — gates, policies and evidence — is inside a <details>.
  const live = view.indexOf("<LiveReadiness");
  const fold = view.lastIndexOf("sa-advanced-details", live);
  assert.ok(fold > 0 && fold < live, "readiness gates must be inside the advanced disclosure");

  // So are the collector diagnostics and the raw paper-execution panel.
  const advancedSlot = view.slice(view.indexOf("advanced={"), view.indexOf("/>\n        ) : null}\n\n        {/* ── 2."));
  for (const panel of ["ObservationHeader", "OverviewPanel", "PaperExecution"]) {
    assert.ok(advancedSlot.includes(`<${panel}`), `${panel} belongs behind the fold`);
  }
  assert.ok(view.includes("تشخیص‌های پیشرفته"), "the fold is labelled in Persian");

  // Nothing on the primary surface can arm or execute anything.
  const cc = read("src/components/shadowArbitrage/CommandCenter.tsx");
  for (const term of ["arm", "enable_live", "execute", "go_live", "placeOrder"]) {
    assert.equal(cc.includes(`"${term}"`), false, `the Command Center must not offer ${term}`);
  }
  // And it states the boundary in Persian on the landing screen itself.
  assert.ok(cc.includes("غیرمسلح"));
  assert.ok(cc.includes("اجرای واقعی پیاده‌سازی نشده است"));
});

await test("8C-3 the recommendation is the calculated size, not the fixed probe", () => {
  const cc = read("src/components/shadowArbitrage/CommandCenter.tsx");
  // The probe size is no longer what the card recommends.
  assert.equal(cc.includes("toFaDigits(best.sizeUsdt)"), false, "the probe size is not the answer");
  assert.ok(cc.includes("bestSizing.sizing.sizeUsdt"), "the calculated size is");
  assert.ok(cc.includes("<dt>حجم محاسبه‌شده</dt>"));

  // The primary reason sits next to it, on the first screen.
  assert.ok(cc.includes("محدودکنندهٔ اصلی حجم"), "the binding constraint is stated");
  assert.ok(cc.includes("حجمی انتخاب نشد"), "and so is the reason when there is none");

  // Headline figures stay on the card: the size, what it ties up, the result.
  const headline = cc.slice(cc.indexOf("<dt>حجم محاسبه‌شده</dt>"), cc.indexOf("sa-cc-calc"));
  for (const figure of ["capitalInvolvedToman", "riskAdjustedPnlToman", "riskAdjustedEdgePercent"]) {
    assert.ok(headline.includes(figure), `the card must state ${figure}`);
  }

  // The full calculation is one expandable step away, not on the first screen.
  assert.ok(cc.includes("محاسبهٔ کامل حجم و سقف‌های محدودکننده"));
  const detail = cc.slice(cc.indexOf("sa-cc-calc"));
  for (const figure of [
    "liquidityMaxUsdtMicros",
    "policyMaxUsdtMicros",
    "cashPnlIrtToman",
    "sellFeeValueToman",
    "economicNetPnlToman",
    "slippageBufferToman"
  ]) {
    assert.ok(detail.includes(figure), `the detail view must report ${figure}`);
  }
  // Every limiting constraint is listed, with the binding one marked.
  assert.ok(detail.includes("bestSizing.sizing.constraints.map"));
  assert.ok(detail.includes("محدودکننده"));

  // The fixed ladder survives only as a diagnostic probe, unchanged.
  const config = read("src/lib/shadowArbitrage/config.ts");
  assert.ok(config.includes("export const SHADOW_TRADE_SIZES: ShadowTradeSizeUsdt[] = [5, 10, 20, 25];"));
});

await test("8C-3 sizing never invents a risk limit and blocks visibly instead", () => {
  const sizing = read("src/lib/shadowArbitrage/paper/sizing.ts");
  // Every required policy is read through the null-returning accessor.
  assert.ok(sizing.includes("policyValueOrNull("));
  assert.equal(
    /policyValueOrNull\([^)]*\)\s*\?\?\s*\d/.test(sizing),
    false,
    "no numeric fallback may follow a policy lookup"
  );
  for (const key of [
    "max_order_size_usdt",
    "max_venue_exposure_percent",
    "min_risk_adjusted_edge_percent",
    "max_quote_age_ms",
    "max_slippage_bps"
  ]) {
    assert.ok(sizing.includes(`"${key}"`), `${key} must be required`);
    assert.equal(
      new RegExp(`${key}\\s*[:=]\\s*\\d`).test(sizing),
      false,
      `${key} must never be assigned a literal`
    );
  }
  // A blocked size is null, with reasons — never a silent zero or a guess.
  assert.ok(sizing.includes("sizeUsdtMicros: null"));
  assert.ok(sizing.includes('status: "BLOCKED"'));

  // The engine refuses to trade a probe size when sizing did not produce one.
  const engine = read("src/lib/shadowArbitrage/paper/engine.ts");
  assert.ok(engine.includes('skip(c, ["sizing_blocked"]);'));
  assert.ok(engine.includes("sizeUsdt: microsToUsdt(sizing.sizeUsdtMicros)"));

  // And the operator is told, on the landing screen, which policy is missing.
  const cc = read("src/components/shadowArbitrage/CommandCenter.tsx");
  assert.ok(cc.includes("sizing.missingPolicies"));
  assert.ok(cc.includes("هیچ مقدار پیش‌فرضی جایگزین نمی‌شود"));
});

await test("8C-3 sizing stays pure: no database, network, clock or order path", () => {
  const sizing = read("src/lib/shadowArbitrage/paper/sizing.ts");
  for (const banned of ["@/db/", "next/server", "fetch(", "apiKey", "placeOrder", "withdraw"]) {
    assert.equal(sizing.includes(banned), false, `sizing must not contain ${banned}`);
  }
  assert.equal(/Date\.now\(\)|new Date\(\)/.test(sizing), false, "a clock would break replay");
  const capability = read("src/lib/shadowArbitrage/live/capability.ts");
  assert.ok(capability.includes("export const LIVE_EXECUTION_IMPLEMENTED = false as const"));
});

await test("8C unknown figures are em dashes, never invented numbers", () => {
  const cc = read("src/components/shadowArbitrage/CommandCenter.tsx");
  assert.ok(cc.includes('const DASH = <span className="sa-unknown">—</span>'));
  // Every portfolio card falls back to the dash when there is no session.
  assert.ok(cc.includes("session ? <TomanAmount value={session.totalCapitalToman} /> : DASH"));
  assert.ok(cc.includes("summary ? <TomanAmount value={summary.todayPnlToman} /> : DASH"));
  assert.ok(cc.includes("summary ? <TomanAmount value={summary.economicPnlToman} /> : DASH"));
  assert.ok(cc.includes("summary ? <TomanAmount value={summary.drawdownToman} /> : DASH"));
  // Marked value without a mark price stays unknown rather than being guessed.
  assert.ok(cc.includes("بدون قیمت مبنا محاسبه نمی‌شود"));
  /*
   * No fabricated DATA. The bare word "placeholder" is excluded because it is
   * also a legitimate HTML input attribute — the scenario controls use it to
   * label an UNSET cap — so the check targets fake-data identifiers instead.
   */
  for (const fake of ["lorem", "placeholderData", "sampleData", "MOCK", "dummy", "fakeData"]) {
    assert.equal(cc.toLowerCase().includes(fake.toLowerCase()), false, `no ${fake}`);
  }
  // Every `placeholder=` occurrence must be an input attribute, nothing else.
  for (const m of cc.match(/placeholder[^=]*=/g) ?? []) {
    assert.equal(m, "placeholder=", `unexpected placeholder usage: ${m}`);
  }
});

await test("8C ratios are bidi-isolated so RTL cannot reverse them", () => {
  const cc = read("src/components/shadowArbitrage/CommandCenter.tsx");
  assert.ok(cc.includes("function Ratio("));
  assert.ok(cc.includes('className="sa-ratio" dir="ltr"'));
  for (const use of [
    "<Ratio part={summary.filled}",
    "<Ratio part={healthySources}",
    "<Ratio part={accounts.executable}",
    "<Ratio part={readiness.passed}"
  ]) {
    assert.ok(cc.includes(use), `missing ${use}`);
  }
});

await test("8C the Command Center reuses the shared glass primitives only", () => {
  const cc = read("src/components/shadowArbitrage/CommandCenter.tsx");
  for (const [name, needle] of [
    ["KPI card", "panel sa-panel sa-cc-kpi"],
    ["status strip", 'className="panel sa-panel sa-cc-status"'],
    ["best opportunity", 'className="panel sa-panel sa-cc-best"'],
    ["health card", 'className="panel sa-panel sa-cc-mini"'],
    ["refresh action", 'className="sa-cc-action glass-control"'],
    ["advanced fold", 'className="panel sa-panel sa-advanced-details"']
  ] as Array<[string, string]>) {
    assert.ok(cc.includes(needle), `${name} must reuse a shared primitive (${needle})`);
  }
  // The only inline style is the progress bar's own width, which is a value.
  assert.equal((cc.match(/style=\{\{/g) ?? []).length, 1);
  assert.ok(cc.includes('className="sa-progress-fill"'));
});

await test("8C Phase 8C CSS declares layout only — no forked material", () => {
  const css = stripComments(phase8cCss());

  assert.equal(/backdrop-filter\s*:/.test(css), false, "blur must come from the primitives");
  assert.equal(/box-shadow\s*:/.test(css), false, "shadows must come from the primitives");
  assert.deepEqual([...new Set([...css.matchAll(/#[0-9a-fA-F]{3,8}/g)].map((m) => m[0]))], []);
  assert.equal(/rgba?\(\s*\d/.test(css), false, "no raw rgb()/rgba() values");
  assert.equal(/background\s*:/.test(css), false, "no card surface of its own");

  const borders = [...css.matchAll(/border[a-z-]*\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
  for (const b of borders) {
    assert.ok(
      b === "0" || b.includes("999px") || b.includes("var(--radius") || b.includes("var(--line-soft)"),
      `unexpected border declaration: ${b}`
    );
  }

  // Every selector stays inside the Shadow scope.
  const selectors = [...css.matchAll(/^(\.[a-z][^{\n,]*|:root\[[^\]]+\][^{\n,]*)\s*[,{]/gm)].map((m) =>
    m[1].trim()
  );
  assert.ok(selectors.length > 15, "the phase adds real rules");
  for (const sel of selectors) {
    assert.ok(/\.sa-/.test(sel), `selector escapes the Shadow scope: ${sel}`);
  }
  assert.equal(/^\s*(body|html|main|\*)\s*[,{]/m.test(css), false);

  // The dashboard type scale, and nothing below 12px.
  const sizes = [...css.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length > 10);
  assert.equal(sizes.filter((n) => n < 12).length, 0, "text must not shrink below 12px");
  assert.ok(css.includes(".sa-cc-kpi-value {\n  font-size: 22px"), "22px headline numbers");
  assert.ok(css.includes(".sa-cc-kpi-label {\n  font-size: 12px"), "12px labels");
});

await test("8C the Command Center never scrolls the page sideways", () => {
  const css = stripComments(phase8cCss());
  const tracks = [...css.matchAll(/grid-template-columns\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(tracks.length > 4);
  for (const track of tracks) {
    assert.ok(track.includes("minmax(0,"), `grid track must be able to shrink: ${track}`);
  }

  // 4 → 2 → 2: eight cards become a 2×4 block on a phone, not one long column.
  const kpis = css.slice(css.indexOf(".sa-cc-kpis {"), css.indexOf(".sa-cc-kpi {"));
  assert.ok(kpis.includes("repeat(4, minmax(0, 1fr))"));
  const tablet = css.slice(css.indexOf("@media (max-width: 1024px)"));
  assert.ok(tablet.slice(0, 400).includes(".sa-cc-kpis"));
  assert.ok(tablet.slice(0, 400).includes("repeat(2, minmax(0, 1fr))"));
  const phone = css.slice(css.indexOf("@media (max-width: 560px)"));
  assert.equal(phone.includes(".sa-cc-kpis {"), false, "the 2-column block carries over");
  assert.ok(phone.includes("min-height: 36px"), "tap targets grow on touch");

  // Long figures wrap instead of widening the track.
  assert.ok(css.includes(".sa-cc-kpi-value") && css.includes("overflow-wrap: anywhere"));
  // And the page-level guard covers the new containers.
  const globals = read("app/globals.css");
  const guard = globals.slice(globals.indexOf(".sa-tabs-wrap,"), globals.indexOf(".sa-tabs-wrap,") + 260);
  for (const sel of [".sa-cc", ".sa-cc-kpis", ".sa-cc-health"]) {
    assert.ok(guard.includes(sel), `${sel} must carry the min-width guard`);
  }
});

/* ══ Phase 8C close-out — capacity column and lifecycle labels ═══════════════ */

await test("8C the allocation table shows capacity and limiter from venueCapacity()", () => {
  const cc = read("src/components/shadowArbitrage/CommandCenter.tsx");
  assert.ok(cc.includes("<th scope=\"col\">ظرفیت و محدودکننده</th>"));

  // Buy and sell are reported independently, each with its own limiter.
  for (const field of [
    "r.buyCapacityUsdtMicros",
    "r.sellCapacityUsdtMicros",
    "r.buyLimiter",
    "r.sellLimiter",
    "r.buyReason",
    "r.sellReason"
  ]) {
    assert.ok(cc.includes(field), `the column must read ${field} from the stored row`);
  }

  /*
   * Single source: the UI NAMES a limiter, it never decides one. No capacity
   * arithmetic may appear in the component — fee division, depth summation or
   * a min() across caps would mean two implementations that can disagree.
   */
  const table = cc.slice(cc.indexOf("ظرفیت و محدودکننده"));
  for (const banned of ["totalDepthMicros", "validateBook", "orderedLevels", "/ (1 +", "Math.min("]) {
    assert.equal(table.includes(banned), false, `capacity must not be recomputed in the UI: ${banned}`);
  }
  // Labels come from the engine's own maps, not from strings retyped here.
  assert.ok(cc.includes("CAP_LABEL_FA["));
  assert.ok(cc.includes("VENUE_CAPACITY_REASON_FA["));
  assert.ok(cc.includes('from "@/lib/shadowArbitrage/paper/liquidity"'));
});

await test("8C an unavailable side shows its exact reason, never a zero", () => {
  const cc = read("src/components/shadowArbitrage/CommandCenter.tsx");
  // Null capacity renders the reason; it must not fall through to a number.
  assert.ok(cc.includes("r.buyCapacityUsdtMicros === null ? ("));
  assert.ok(cc.includes("r.sellCapacityUsdtMicros === null ? ("));

  // AbanTether's structural case is a first-class reason with its own label.
  const liq = read("src/lib/shadowArbitrage/paper/liquidity.ts");
  assert.ok(liq.includes("quote_only_no_order_book:"));
  assert.ok(
    liq.includes("نقل‌قول تک‌قیمتی — بدون دفتر سفارش (محدودیت ساختاری، نه خرابی)"),
    "it is stated as structural, not as missing or broken"
  );
  // And it is never collapsed into the missing-book reason.
  assert.notEqual(
    liq.match(/quote_only_no_order_book: "([^"]+)"/)?.[1],
    liq.match(/\n  book_missing: "([^"]+)"/)?.[1]
  );
});

await test("8C record type and latest decision are labelled so they cannot contradict", () => {
  const cc = read("src/components/shadowArbitrage/CommandCenter.tsx");
  // The row's own nature.
  assert.ok(cc.includes("نوع رکورد:"));
  assert.ok(cc.includes("پیشنهاد ثبت‌شده — آمادهٔ اعمال"));
  assert.ok(cc.includes("پیش‌نمایش (قابل اعمال نیست)"));
  // What later happened to it.
  assert.ok(cc.includes("آخرین تصمیم ماندگار روی این رکورد:"));
  assert.ok(cc.includes("اعمال شد"));
  assert.ok(cc.includes("رد شد — کهنه"));
  // And an explicit note that the two are different axes.
  assert.ok(cc.includes("هرگز یکدیگر را نقض نمی‌کنند"));
  // Raw enum values are not shown as the primary label.
  assert.equal(cc.includes(">{proposalDecision.decision}<"), false);
});

await test("8C scenario inputs and the proposal survive a hard reload", () => {
  const view = read("src/components/ShadowArbitrageView.tsx");
  // Hydrated from the server payload, not from component memory.
  assert.ok(view.includes("payload.allocation?.proposal"));
  assert.ok(view.includes("setProposal(payload.allocation.proposal)"));
  assert.ok(view.includes("payload.allocation.proposal.scenarioCaps"));
  assert.ok(view.includes("setScenarioCaps(caps)"));

  // The server recovers them from the stored note, so they are durable.
  const route = read("app/api/shadow-arbitrage/paper/route.ts");
  assert.ok(route.includes("SCENARIO ("));
  assert.ok(route.includes("scenarioCaps"));
  assert.ok(route.includes("listProposals(1)"), "the latest proposal is loaded on GET");
  assert.ok(route.includes("listDecisions"), "and its latest decision");
});

await test("8C the capacity column stays inside the page at every width", () => {
  const css = read("app/globals.css");
  // The table lives in the shared scrolling wrapper, so a wide row scrolls
  // inside its own container rather than widening the page.
  const cc = read("src/components/shadowArbitrage/CommandCenter.tsx");
  const table = cc.slice(cc.indexOf("تخصیص فعلی در برابر پیشنهادی") - 800);
  assert.ok(table.includes("sa-table-wrap"), "the allocation table is wrapped");
  const wrap = css.slice(css.indexOf(".sa-table-wrap {"));
  assert.ok(wrap.slice(0, 200).includes("overflow-x: auto"));
  // And the page-level guard still covers the Command Center containers.
  const guard = css.slice(css.indexOf(".sa-tabs-wrap,"), css.indexOf(".sa-tabs-wrap,") + 260);
  for (const sel of [".sa-cc", ".sa-cc-kpis", ".sa-cc-health"]) {
    assert.ok(guard.includes(sel), `${sel} must carry the min-width guard`);
  }
});

await test("8C the four venue facts are counted and shown separately", () => {
  const route = read("app/api/shadow-arbitrage/paper/route.ts");
  /*
   * Capacity and usability are counted PER LEG. Arbitrage needs one venue to
   * buy on and another to sell on, so a venue with one valid leg is a full
   * participant — requiring both directions of the same venue is what wrongly
   * excluded an OTC dealer whose buy leg was perfectly usable.
   */
  for (const key of [
    "kycConfirmed",
    "accountEligible",
    "buyCapacityMeasurable",
    "sellCapacityMeasurable",
    "buyLegUsable",
    "sellLegUsable",
    "participating"
  ]) {
    assert.ok(route.includes(`${key}:`), `the API must count ${key} on its own`);
  }
  assert.ok(route.includes("participates: buyOk || sellOk"), "one valid leg is enough");
  assert.ok(route.includes("quoteOnly:"));
  assert.ok(route.includes("unverified:"));
  assert.ok(route.includes("matrix"), "a per-venue matrix is returned");

  const cc = read("src/components/shadowArbitrage/CommandCenter.tsx");
  for (const label of [
    "احراز هویت تأییدشده",
    "حساب اجراپذیر",
    "ظرفیت خرید قابل اندازه‌گیری",
    "ظرفیت فروش قابل اندازه‌گیری",
    "پای خرید قابل استفاده",
    "پای فروش قابل استفاده",
    "واجد شرکت در حداقل یک مسیر",
    "نقل‌قولی / تأییدنشده"
  ]) {
    assert.ok(cc.includes(label), `missing label: ${label}`);
  }
  // The conflated summary is gone: no single ratio stands for all of them.
  assert.equal(cc.includes("آمادگی حساب و کارمزد"), false, "the merged label is retired");
  // And the matrix shows every fact per venue, including the exact blocker.
  assert.ok(cc.includes("ماتریس صرافی‌ها"));
  for (const col of ["نوع داده", "پای خرید", "پای فروش", "شرکت‌کننده", "مانع دقیق"]) {
    assert.ok(cc.includes(col), `matrix column missing: ${col}`);
  }
});

await test("8C a funded venue is EXPLORATION and AbanTether keeps null book fields", () => {
  // Stripped of comments: the prose explains the rename, the CODE must not use it.
  const alloc = stripComments(read("src/lib/shadowArbitrage/paper/allocation.ts"));
  assert.ok(alloc.includes('"EXPLORATION"'));
  assert.equal(/\bUNUSED\b/.test(alloc), false, "the contradictory label is gone from the code");
  assert.ok(alloc.includes("EXPLORATION: \"اکتشافی"));

  // Quote venues are measured from the quote; no book is ever synthesised.
  const liq = read("src/lib/shadowArbitrage/paper/liquidity.ts");
  assert.ok(liq.includes("function quoteVenueCapacity("));
  assert.ok(liq.includes("export function checkQuote("));
  for (const reason of [
    "quote_capacity_unverified",
    "quote_missing",
    "quote_stale",
    "quote_direction_unverified"
  ]) {
    assert.ok(liq.includes(`${reason}:`), `missing reason: ${reason}`);
  }
  // The adapter still publishes no ladder for a dealer.
  const aban = read("src/lib/shadowArbitrage/adapters/abantether.ts");
  assert.ok(aban.includes('kind: "OTC_QUOTE"'));
  assert.ok(aban.includes("bids: []") && aban.includes("asks: []"));
  assert.ok(aban.includes("depthAvailable: false"));
  // And normalization stores null rather than an empty array.
  const base = read("src/lib/shadowArbitrage/adapters/base.ts");
  assert.ok(base.includes('bookBids: walkable ? cappedLevels(result.bids, "sell") : null'));
});

await test("8C capacity is computed once: no duplicate implementation exists", () => {
  // Stripped of comments: a doc comment may NAME the engine function; the
  // component must never CALL it.
  const cc = stripComments(read("src/components/shadowArbitrage/CommandCenter.tsx"));
  for (const banned of ["checkQuote(", "venueCapacity(", "totalDepthMicros(", "walkBook("]) {
    assert.equal(cc.includes(banned), false, `the UI must not call ${banned}`);
  }
  // Exactly one module owns the calculation.
  const liq = read("src/lib/shadowArbitrage/paper/liquidity.ts");
  assert.equal((liq.match(/export function venueCapacity\(/g) ?? []).length, 1);
  assert.equal((liq.match(/function quoteVenueCapacity\(/g) ?? []).length, 1);
  // And the API calls it rather than reimplementing it.
  const route = read("app/api/shadow-arbitrage/paper/route.ts");
  assert.ok(route.includes("venueCapacity({"));
  assert.equal(/1 \+ [a-zA-Z]*[Ff]eeBps \/ 10_?000/.test(route), false, "no fee maths in the route");
});

/* ══ Phase 8D-B — the Paper Execution tab ════════════════════════════════════ */

await test("8D-B the paper tab is one panel with the permanent banner", () => {
  const pe = read("src/components/shadowArbitrage/PaperExecution.tsx");
  assert.ok(pe.includes('PAPER_BANNER_EN = "PAPER EXECUTION — NO REAL ORDERS OR TRANSFERS"'));
  // Rendered unconditionally — not inside any status branch.
  const banner = pe.slice(pe.indexOf("{PAPER_BANNER_EN}") - 400, pe.indexOf("{PAPER_BANNER_EN}"));
  assert.equal(/\?\s*\($/.test(banner.trim()), false, "the banner is never conditional");

  // One panel, not a competing second one: the view still mounts it once.
  const view = read("src/components/ShadowArbitrageView.tsx");
  assert.equal((view.match(/<PaperExecution/g) ?? []).length, 1);
});

await test("8D-B the session section shows identity, cycles and guarded controls", () => {
  const pe = read("src/components/shadowArbitrage/PaperExecution.tsx");
  for (const label of [
    "<dt>وضعیت</dt>",
    "<dt>حالت</dt>",
    "<dt>شناسهٔ نشست</dt>",
    "<dt>شناسهٔ مشاهده</dt>",
    "<dt>آخرین چرخهٔ ارزیابی‌شده</dt>",
    "<dt>آخرین معاملهٔ انجام‌شده</dt>"
  ]) {
    assert.ok(pe.includes(label), `session section needs ${label}`);
  }
  // Pause/resume are two-step, and they are the ONLY mutations.
  assert.ok(pe.includes('setConfirming("pause")'));
  assert.ok(pe.includes('setConfirming("resume")'));
  assert.ok(pe.includes("بله، انجام بده"));
  const actions = [...pe.matchAll(/action,\s*sessionId|JSON\.stringify\(\{ action/g)];
  assert.ok(actions.length >= 1);
  for (const banned of ['"create"', '"start"', '"stop"', '"apply_allocation"']) {
    assert.equal(pe.includes(banned), false, `the paper tab must not offer ${banned}`);
  }
  // Nothing starts a session on mount: the effect only reads.
  const effect = pe.slice(pe.indexOf("useEffect(() => {"), pe.indexOf("}, [load]);"));
  assert.ok(effect.includes("void load()"));
  assert.equal(/method: "POST"/.test(effect), false, "mounting must never mutate");
  assert.ok(pe.includes("استقرار یا بازکردن این صفحه هرگز نشستی نمی‌سازد"));
});

await test("8D-B the five financial metrics are separate cards, never merged", () => {
  const pe = read("src/components/shadowArbitrage/PaperExecution.tsx");
  for (const [label, field] of [
    ["جریان نقدی تومانی", "stats.cashPnlIrtToman"],
    ["تغییر موجودی تتری", "stats.inventoryDeltaUsdtMicros"],
    ["ارزش تومانی کارمزد تتری", "stats.sellFeeValueToman"],
    ["سود خالص اقتصادی", "stats.economicNetPnlToman"],
    ["سود تعدیل‌شده با ریسک", "stats.riskAdjustedPnlToman"]
  ] as Array<[string, string]>) {
    assert.ok(pe.includes(`label="${label}"`), `missing metric card: ${label}`);
    assert.ok(pe.includes(field), `card must read ${field} from the server`);
  }
  // Cash and economic PnL are never added together anywhere.
  assert.equal(
    /cashPnlIrtToman\s*\+\s*economicNetPnlToman/.test(pe),
    false,
    "cash and economic PnL must never be merged"
  );
  // Secondary metrics exist too.
  for (const label of ["معاملات", "نرخ تبدیل فرصت", "کارمزد پرداخت‌شده"]) {
    assert.ok(pe.includes(`label="${label}"`), `missing secondary metric: ${label}`);
  }
});

await test("8D-B filters, pagination and URL state behave deterministically", () => {
  const pe = read("src/components/shadowArbitrage/PaperExecution.tsx");
  // Every piece of view state lives in the URL, so a reload restores it.
  for (const key of ["pv", "pq", "pout", "preason", "pper", "ppage"]) {
    assert.ok(pe.includes(`"${key}"`), `${key} must be URL state`);
  }
  assert.ok(pe.includes("useShadowViewState()"));
  // Changing a filter returns to page 1; paging never resets a filter.
  assert.ok(pe.includes('write({ ...patch, ppage: "1" })'));
  for (const f of ["pq:", "pout:", "preason:"]) {
    assert.ok(pe.includes(`setFilter({ ${f}`), `${f} must go through setFilter`);
  }
  // An out-of-range page self-corrects inside paginate(), not by clamping here.
  assert.ok(pe.includes("paginate(ledger, rawPage, perPage)"));
  assert.ok(pe.includes("pageSizes={OPPORTUNITY_PAGE_SIZES}"), "10 / 20 / 50");
  assert.ok(pe.includes("<Pager"));
});

await test("8D-B nine venue rows, quote semantics and a details drawer", () => {
  const pe = read("src/components/shadowArbitrage/PaperExecution.tsx");
  // The matrix is the server's, rendered row by row.
  assert.ok(pe.includes("venueSemantics?.matrix"));
  assert.ok(pe.includes("matrix.map((m)"));
  for (const col of ["مدل داده", "نقش", "تومان مجازی", "تتر مجازی", "ظرفیت خرید", "ظرفیت فروش"]) {
    assert.ok(pe.includes(col), `balance view needs ${col}`);
  }
  // A dealer is labelled as an executable quote, never as a book.
  assert.ok(pe.includes('m.dataType === "EXECUTABLE_QUOTE" ? "نقل‌قول اجراپذیر" : "دفتر سفارش"'));
  assert.equal(pe.includes("bookBids"), false, "the tab never touches book fields");

  // The drawer shows both legs and all five figures.
  for (const dt of [
    "<dt>پای خرید</dt>",
    "<dt>پای فروش</dt>",
    "<dt>VWAP خرید / فروش</dt>",
    "<dt>قیمت مرجع</dt>",
    "<dt>بافر ریسک</dt>",
    "<dt>جریان نقدی تومانی</dt>",
    "<dt>تغییر موجودی تتری</dt>",
    "<dt>ارزش تومانی کارمزد تتری</dt>",
    "<dt>سود خالص اقتصادی</dt>",
    "<dt>سود تعدیل‌شده</dt>"
  ]) {
    assert.ok(pe.includes(dt), `drawer needs ${dt}`);
  }
});

await test("8D-B the paper tab recomputes no financial or capacity figure", () => {
  const pe = stripComments(read("src/components/shadowArbitrage/PaperExecution.tsx"));
  // It may not call the engine, and it may not re-derive its arithmetic.
  for (const banned of [
    "venueCapacity(",
    "checkQuote(",
    "walkBook(",
    "totalDepthMicros(",
    "computeRouteSize(",
    "planFill(",
    "buyIrtCapacityMicros(",
    "sellUsdtCapacityMicros("
  ]) {
    assert.equal(pe.includes(banned), false, `the UI must not call ${banned}`);
  }
  // No fee maths, no VWAP maths, no PnL composition in the component.
  assert.equal(/\/ 10_?000/.test(pe), false, "no bps arithmetic in the UI");
  assert.equal(/1 \+ [a-zA-Z]*[Ff]ee/.test(pe), false, "no fee-inclusive division in the UI");
  assert.equal(
    /economicNetPnlToman\s*-\s*[a-zA-Z]/.test(pe),
    false,
    "risk-adjusted PnL is the server's number, not a subtraction here"
  );
  // Dividing by 1e6 to DISPLAY micros is formatting, not computation, and is
  // the only arithmetic allowed; it never feeds another figure.
  assert.ok(pe.includes("/ 1_000_000"), "micros are formatted for display");
});

await test("8D-B unknown values are em dashes carrying their own reason", () => {
  const pe = read("src/components/shadowArbitrage/PaperExecution.tsx");
  assert.ok(pe.includes("function Unknown({ why }"));
  assert.ok(pe.includes('<span className="sa-unknown" title={why}>'));
  // Used for every figure that can genuinely be absent.
  for (const why of [
    "این رکورد اجرا نشده است",
    "کارمزد تأییدشده‌ای برای این سمت ثبت نشده است",
    "قیمت مرجع این چرخه در دسترس نبود",
    "موجودی مجازی برای این صرافی ثبت نشده است"
  ]) {
    assert.ok(pe.includes(why), `missing reason: ${why}`);
  }
  // Loading, error and empty states are explicit.
  assert.ok(pe.includes("در حال بارگذاری وضعیت اجرای کاغذی"));
  assert.ok(pe.includes("sa-callout-danger"));
  assert.ok(pe.includes("با این فیلترها هیچ رکوردی وجود ندارد"));
});

await test("8D-B desktop tables, real mobile cards, and shared primitives only", () => {
  const pe = read("src/components/shadowArbitrage/PaperExecution.tsx");
  assert.ok(pe.includes("sa-paper-desktop"));
  assert.ok(pe.includes("sa-paper-cards"));
  // Cards are real markup, not a restyled table.
  assert.ok(pe.includes('className="panel sa-panel sa-paper-card"'));

  const css = read("app/globals.css");
  const sec = css.slice(css.indexOf("Phase 8D paper execution"));
  assert.ok(sec.includes(".sa-paper-cards {\n  display: none;\n}"), "cards are desktop-hidden");
  const mobile = sec.slice(sec.indexOf("@media (max-width: 768px)"));
  assert.ok(mobile.includes(".sa-paper-desktop"), "tables hide on a phone");
  assert.ok(mobile.includes("min-height: 36px"), "touch targets are 36px");
  // Layout only: no forked material, nothing below 12px.
  assert.equal(/backdrop-filter\s*:/.test(sec), false);
  assert.equal(/box-shadow\s*:/.test(sec), false);
  assert.equal(/background\s*:/.test(sec), false);
  const sizes = [...sec.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
  assert.equal(sizes.filter((n) => n < 12).length, 0, "no text below 12px");
  // Every selector stays inside the Shadow scope.
  const selectors = [...sec.matchAll(/^(\.[a-z][^{\n,]*)\s*[,{]/gm)].map((m) => m[1].trim());
  assert.ok(selectors.length > 3);
  for (const sel of selectors) assert.ok(/\.sa-/.test(sel), `selector escapes scope: ${sel}`);

  // Material comes from the shared primitives.
  for (const needle of ["glass-control", "glass-tabbar", "panel sa-panel"]) {
    assert.ok(pe.includes(needle), `must reuse ${needle}`);
  }
  // No font, no inline style.
  assert.equal(/font-family|fontFamily/.test(pe), false);
  assert.equal(/style=\{\{/.test(pe), false);
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
