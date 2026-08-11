/**
 * Shadow Arbitrage — five operator sections.
 *
 * Order matches the operator workflow (v4.2.1): capital → open orders →
 * decisions → venues → configuration. Sections are URL-addressable through
 * `?tab=`. Legacy four- and seven-tab slugs map through `SHADOW_TAB_ALIASES`
 * so old bookmarks still land on the section that now owns their content.
 */
export type ShadowTabId = "accounts" | "book" | "activity" | "venues" | "settings";

export type ShadowTab = {
  id: ShadowTabId;
  labelFa: string;
  /** One line explaining what the section is for, shown as its tooltip. */
  hintFa: string;
};

/** Render order. The first entry is the default landing section. */
export const SHADOW_TABS: ShadowTab[] = [
  {
    id: "accounts",
    labelFa: "سرمایه و حساب",
    hintFa: "خلاصه پرتفوی و موجودی مجازی هر صرافی"
  },
  {
    id: "book",
    labelFa: "سفارش‌ها",
    hintFa: "سفارش‌های باز یا در صف — نه معاملات تکمیل‌شده"
  },
  {
    id: "activity",
    labelFa: "فعالیت‌ها",
    hintFa: "چرا معامله شد یا نشد، و جزئیات معاملات تکمیل‌شده"
  },
  {
    id: "venues",
    labelFa: "وضعیت صرافی‌ها",
    hintFa: "سلامت، کارمزد taker و عمق قابل‌استفاده"
  },
  {
    id: "settings",
    labelFa: "تنظیمات",
    hintFa: "نشست Paper، سیاست‌ها و تنظیمات پیشرفته"
  }
];

export const DEFAULT_SHADOW_TAB: ShadowTabId = "accounts";

/**
 * Where each retired slug goes.
 *
 * Old four-section and seven-tab links must land on the section that now owns
 * their content, never silently on the default.
 */
export const SHADOW_TAB_ALIASES: Record<string, ShadowTabId> = {
  // Former four-section model (4.1.x)
  command: "accounts",
  capital: "settings",
  trades: "book",
  // Former seven-tab model
  overview: "accounts",
  paper: "accounts",
  opportunities: "book",
  analytics: "activity",
  sources: "venues",
  live: "settings",
  // Nested settings views that were promoted
  activity: "activity"
};

const TAB_IDS = new Set<string>(SHADOW_TABS.map((t) => t.id));

export function parseShadowTab(value: string | null | undefined): ShadowTabId {
  if (!value) return DEFAULT_SHADOW_TAB;
  if (TAB_IDS.has(value)) return value as ShadowTabId;
  return SHADOW_TAB_ALIASES[value] ?? DEFAULT_SHADOW_TAB;
}

/** True when the value is a retired slug that resolves to a different section. */
export function isLegacyShadowTab(value: string | null | undefined): boolean {
  return Boolean(value) && !TAB_IDS.has(value as string) && Boolean(SHADOW_TAB_ALIASES[value as string]);
}

export function shadowTabLabel(id: ShadowTabId): string {
  return SHADOW_TABS.find((t) => t.id === id)?.labelFa ?? id;
}

/* ── Settings: configuration only (no Activity) ─────────────────────────── */

export type ShadowSettingsViewId = "paper" | "capital" | "live";

export type ShadowSettingsView = {
  id: ShadowSettingsViewId;
  labelFa: string;
  hintFa: string;
};

export const SHADOW_SETTINGS_VIEWS: ShadowSettingsView[] = [
  {
    id: "paper",
    labelFa: "سیاست Paper",
    hintFa: "مجموعهٔ تأییدشدهٔ شش سیاست حجم‌دهی"
  },
  {
    id: "capital",
    labelFa: "سرمایه و تخصیص",
    hintFa: "طرح سرمایهٔ مجازی و تقسیم بین صرافی‌ها"
  },
  {
    id: "live",
    labelFa: "آمادگی اجرای واقعی",
    hintFa: "شواهد و دروازه‌ها — اجرا پیاده‌سازی نشده است"
  }
];

export const DEFAULT_SHADOW_SETTINGS_VIEW: ShadowSettingsViewId = "paper";

const SETTINGS_VIEW_IDS = new Set<string>(SHADOW_SETTINGS_VIEWS.map((v) => v.id));

export function parseShadowSettingsView(
  value: string | null | undefined
): ShadowSettingsViewId {
  // Former nested "activity" settings view is now a top-level tab.
  if (value === "activity") return DEFAULT_SHADOW_SETTINGS_VIEW;
  if (value && SETTINGS_VIEW_IDS.has(value)) return value as ShadowSettingsViewId;
  return DEFAULT_SHADOW_SETTINGS_VIEW;
}
