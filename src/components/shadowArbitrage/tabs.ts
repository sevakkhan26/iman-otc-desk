/**
 * Phase 8C-1 — the Shadow Arbitrage section model.
 *
 * Seven equal-weight tabs became four operator sections. The order is the order
 * an operator works in: what is happening now, what money is behind it, what it
 * traded, and finally the settings and safety material that is read rarely.
 *
 * Sections are URL-addressable through `?tab=`, so a reload, a bookmark and the
 * browser's back/forward buttons all land on the same view. The query key keeps
 * its old name on purpose — every link, screenshot script and bookmark that was
 * written against the seven tabs still resolves, through `SHADOW_TAB_ALIASES`.
 */
export type ShadowTabId = "command" | "capital" | "trades" | "settings";

export type ShadowTab = {
  id: ShadowTabId;
  labelFa: string;
  /** One line explaining what the section is for, shown as its tooltip. */
  hintFa: string;
};

/** Render order. The first entry is the default landing section. */
export const SHADOW_TABS: ShadowTab[] = [
  {
    id: "command",
    labelFa: "مرکز فرماندهی",
    hintFa: "وضعیت لحظه‌ای پرتفوی، بهترین فرصت و کنترل نشست کاغذی"
  },
  {
    id: "capital",
    labelFa: "سرمایه و تخصیص",
    hintFa: "طرح سرمایهٔ مجازی و تقسیم آن بین صرافی‌ها"
  },
  {
    id: "trades",
    labelFa: "فرصت‌ها و معاملات",
    hintFa: "فهرست فرصت‌های مشاهده‌شده و دفتر معاملات کاغذی"
  },
  {
    id: "settings",
    labelFa: "تنظیمات و ایمنی",
    hintFa: "سلامت منابع، حساب و کارمزد، و مرزهای ایمنی اجرای واقعی"
  }
];

export const DEFAULT_SHADOW_TAB: ShadowTabId = "command";

/**
 * Where each of the seven old tabs went.
 *
 * This is the backward-compatibility contract, not a convenience: an old link
 * must land on the section that now owns its content, never on the default.
 */
export const SHADOW_TAB_ALIASES: Record<string, ShadowTabId> = {
  overview: "command",
  paper: "command",
  opportunities: "trades",
  analytics: "trades",
  sources: "settings",
  live: "settings",
  capital: "capital"
};

const TAB_IDS = new Set<string>(SHADOW_TABS.map((t) => t.id));

/**
 * Resolve a `?tab=` value.
 *
 * A current slug round-trips, one of the seven retired slugs is redirected to
 * its new home, and anything else falls back to the default rather than erroring.
 */
export function parseShadowTab(value: string | null | undefined): ShadowTabId {
  if (!value) return DEFAULT_SHADOW_TAB;
  if (TAB_IDS.has(value)) return value as ShadowTabId;
  return SHADOW_TAB_ALIASES[value] ?? DEFAULT_SHADOW_TAB;
}

/** True when the value is a retired slug that resolves to a different section. */
export function isLegacyShadowTab(value: string | null | undefined): boolean {
  return Boolean(value) && !TAB_IDS.has(value as string);
}

export function shadowTabLabel(id: ShadowTabId): string {
  return SHADOW_TABS.find((t) => t.id === id)?.labelFa ?? id;
}

/* ── Settings & Safety: three views, not one long table ────────────────────
 *
 * The section used to stack Paper sizing settings, future live-execution
 * policies, evidence thresholds and activity into a single scrolling table.
 * They are read at different times by people asking different questions, and
 * mixing them invited exactly the failure this split removes: configuring one
 * number at a time because the page offered no other shape.
 *
 * Each view is addressable through `?sv=`, so a link, a bookmark and the back
 * button all land where they were pointed.
 */
export type ShadowSettingsViewId = "paper" | "activity" | "live";

export type ShadowSettingsView = {
  id: ShadowSettingsViewId;
  labelFa: string;
  hintFa: string;
};

export const SHADOW_SETTINGS_VIEWS: ShadowSettingsView[] = [
  {
    id: "paper",
    labelFa: "تنظیمات Paper",
    hintFa: "مجموعهٔ تأییدشدهٔ شش سیاست حجم‌دهی که کارگزار کاغذی با آن کار می‌کند"
  },
  {
    id: "activity",
    labelFa: "فعالیت و تصمیم‌ها",
    hintFa: "چه چیزی اجرا شد، چه چیزی رد شد و دقیقاً چرا — فقط خواندنی"
  },
  {
    id: "live",
    labelFa: "آمادگی اجرای واقعی",
    hintFa: "سیاست‌ها، شواهد و دروازه‌های اجرای واقعی — پیاده‌سازی نشده است"
  }
];

export const DEFAULT_SHADOW_SETTINGS_VIEW: ShadowSettingsViewId = "paper";

const SETTINGS_VIEW_IDS = new Set<string>(SHADOW_SETTINGS_VIEWS.map((v) => v.id));

export function parseShadowSettingsView(
  value: string | null | undefined
): ShadowSettingsViewId {
  if (value && SETTINGS_VIEW_IDS.has(value)) return value as ShadowSettingsViewId;
  return DEFAULT_SHADOW_SETTINGS_VIEW;
}
