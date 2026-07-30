/**
 * Phase 8A — the Shadow Arbitrage tab model.
 *
 * Tabs are URL-addressable through `?tab=`, so a reload, a bookmark and the
 * browser's back/forward buttons all land on the same view. The slug is a
 * stable ASCII key; the label a reader sees is Persian.
 */
export type ShadowTabId =
  | "overview"
  | "opportunities"
  | "sources"
  | "capital"
  | "paper"
  | "live"
  | "analytics";

export type ShadowTab = {
  id: ShadowTabId;
  labelFa: string;
  /** One line explaining what the tab is for, shown as its tooltip. */
  hintFa: string;
};

/** Render order. The first entry is the default. */
export const SHADOW_TABS: ShadowTab[] = [
  {
    id: "overview",
    labelFa: "نمای کلی",
    hintFa: "وضعیت کلی پایش، سلامت جمع‌آورنده و خلاصهٔ فرصت‌ها"
  },
  {
    id: "opportunities",
    labelFa: "فرصت‌ها",
    hintFa: "فهرست کامل فرصت‌های مشاهده‌شده با جزئیات محاسبه"
  },
  {
    id: "sources",
    labelFa: "منابع و کارمزدها",
    hintFa: "سلامت منابع، گواهی داده و آمادگی حساب و کارمزد"
  },
  {
    id: "capital",
    labelFa: "تخصیص سرمایه",
    hintFa: "شبیه‌ساز تخصیص سرمایهٔ مجازی و توصیهٔ موقت"
  },
  {
    id: "paper",
    labelFa: "اجرای کاغذی",
    hintFa: "نشست اجرای کاغذی، موجودی مجازی و دفتر معاملات"
  },
  {
    id: "live",
    labelFa: "آمادگی اجرای واقعی",
    hintFa: "دروازه‌های آمادگی و حدود ریسک — اجرای واقعی پیاده‌سازی نشده است"
  },
  {
    id: "analytics",
    labelFa: "تحلیل و تاریخچه",
    hintFa: "تحلیل بازهٔ پایش، مسیرها و هزینه‌ها"
  }
];

export const DEFAULT_SHADOW_TAB: ShadowTabId = "overview";

const TAB_IDS = new Set<string>(SHADOW_TABS.map((t) => t.id));

/** Unknown or missing values fall back to the default rather than erroring. */
export function parseShadowTab(value: string | null | undefined): ShadowTabId {
  return value && TAB_IDS.has(value) ? (value as ShadowTabId) : DEFAULT_SHADOW_TAB;
}

export function shadowTabLabel(id: ShadowTabId): string {
  return SHADOW_TABS.find((t) => t.id === id)?.labelFa ?? id;
}
