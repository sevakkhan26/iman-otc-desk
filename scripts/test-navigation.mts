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

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
