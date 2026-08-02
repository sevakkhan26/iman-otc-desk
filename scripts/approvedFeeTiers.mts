/**
 * Phase 8E-B — the fee tiers the administrator approved, as supplied.
 *
 * Kept in its own module so the importer and the test read the SAME list: a
 * test that restates the data it is checking proves nothing, and a list that
 * lives only inside an import script cannot be checked for duplicates at all.
 *
 * Nothing here is inferred. AbanTether names no tier in the supplied evidence,
 * so its label is null rather than a guessed "Base" — an invented tier would
 * match a real fee row and quietly authorise it. Easy Trade and Convert rates
 * are absent rather than assumed to equal the order book.
 */
export type ExecutionModeName = "ORDER_BOOK" | "EASY_TRADE" | "CONVERT" | "OTC_QUOTE";

export type ApprovedFeeTier = {
  sourceId: string;
  tierLabel: string | null;
  makerFeeBps: number | null;
  takerFeeBps: number | null;
  executionMode: ExecutionModeName;
  note?: string;
};

/** The confirmation this import represents. One key, one import. */
export const EVIDENCE_KEY = "admin-tier-2026-08-02";
/** Separate key for the tier-in-force declarations, which land in another table. */
export const TIER_IN_FORCE_KEY = "admin-tier-in-force-2026-08-02";
export const CONFIRMED_AT = "2026-08-02T00:00:00.000Z";
export const CONFIRMED_BY = "otc-iman";
export const VALID_FOR_DAYS = 30;
export const PROVENANCE = "ADMIN_CONFIRMED_SCREENSHOT";

export const APPROVED_FEE_TIERS: ApprovedFeeTier[] = [
  { sourceId: "nobitex", tierLabel: "Base", makerFeeBps: 25, takerFeeBps: 25, executionMode: "ORDER_BOOK" },
  { sourceId: "wallex", tierLabel: "Base Level 1", makerFeeBps: 25, takerFeeBps: 30, executionMode: "ORDER_BOOK" },
  { sourceId: "tabdeal", tierLabel: "VIP1", makerFeeBps: 24, takerFeeBps: 28, executionMode: "ORDER_BOOK" },
  { sourceId: "bitpin", tierLabel: "Base Level 1", makerFeeBps: 30, takerFeeBps: 35, executionMode: "ORDER_BOOK" },
  {
    sourceId: "abantether",
    // The supplied evidence names no tier for this venue. Null, not "Base".
    tierLabel: null,
    makerFeeBps: 30,
    takerFeeBps: 30,
    executionMode: "OTC_QUOTE",
    note: "شواهد ارائه‌شده هیچ پلکانی برای این صرافی نام نبرده است"
  },
  { sourceId: "ramzinex", tierLabel: "Base", makerFeeBps: 20, takerFeeBps: 25, executionMode: "ORDER_BOOK" },
  { sourceId: "bit24", tierLabel: "VIP0", makerFeeBps: 20, takerFeeBps: 20, executionMode: "ORDER_BOOK" },
  { sourceId: "tetherland", tierLabel: "Bronze", makerFeeBps: 45, takerFeeBps: 45, executionMode: "ORDER_BOOK" },
  {
    sourceId: "arzinja",
    tierLabel: "Level 1",
    makerFeeBps: 0,
    takerFeeBps: 0,
    executionMode: "ORDER_BOOK",
    note: "صفر فقط برای حالت دفتر سفارش/معاملهٔ بازار تأیید شده است؛ خرید و فروش آسان و تبدیل شواهد جداگانه لازم دارند"
  }
];
