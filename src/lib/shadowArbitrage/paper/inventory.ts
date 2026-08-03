/**
 * Inventory bands for paper sizing.
 *
 * A venue's inventory is the share of its own value held in USDT rather than
 * toman. Arbitrage moves that share on both legs at once — the buy venue ends
 * up longer USDT, the sell venue shorter — so a sequence of individually
 * profitable trades can quietly turn a market-neutral desk into a directional
 * one. That drift is not visible in PnL until the price moves.
 *
 * The band is measured in PERCENTAGE POINTS of share, not as a ratio of the
 * current holding to its target. A venue that has been drained to almost no
 * USDT has a target ratio it can never divide by; its share, on the other hand,
 * is always defined as long as the venue holds anything at all. Points also
 * make the admin policy readable: «حداکثر انحراف موجودی ۲۰٪» means the USDT
 * share may sit twenty points either side of where the session opened it.
 *
 * The target share is the one the SESSION opened with, per venue — not an
 * average, not a house view. The opening allocation is an approved decision;
 * anything else here would be a limit nobody set.
 *
 * Pure module: no database, no network, no clock. It measures and explains; it
 * cannot move a balance, place an order, or touch a credential.
 */
import { microsToUsdt, type VenueBalance } from "@/lib/shadowArbitrage/paper/broker";
import { mulPriceSizeToman } from "@/lib/shadowArbitrage/money";

/** Where the session opened one venue's USDT share, in percent of venue value. */
export type InventoryTarget = { sourceId: string; targetUsdtSharePercent: number };

export type InventoryModel = {
  /** The session's own valuation price. Null means inventory is unmeasurable. */
  valuationPriceToman: number | null;
  targets: InventoryTarget[];
  /**
   * `max_inventory_deviation_percent`, in percentage POINTS of share.
   * Null means the policy is unset — sizing then fails closed, never defaults.
   */
  maxDeviationPoints: number | null;
};

export type VenueInventory = {
  sourceId: string;
  venueValueToman: number;
  usdtValueToman: number;
  /** usdtValue ÷ venueValue, in percent. */
  usdtSharePercent: number;
  targetUsdtSharePercent: number;
  /** current − target, in percentage points. Signed: positive is USDT-heavy. */
  deviationPoints: number;
  withinBand: boolean;
};

export type InventoryReason =
  | "ok"
  | "no_valuation_price"
  | "no_target"
  | "venue_value_zero"
  | "policy_unset";

export const INVENTORY_REASON_FA: Record<InventoryReason, string> = {
  ok: "انحراف موجودی اندازه‌گیری شد",
  no_valuation_price: "قیمت مبنای نشست در دسترس نیست؛ انحراف موجودی اندازه‌گیری نشد",
  no_target: "سهم هدف تتر برای این صرافی در تخصیص اولیهٔ نشست ثبت نشده است",
  venue_value_zero: "ارزش این صرافی صفر است؛ سهم تتر تعریف نمی‌شود",
  policy_unset: "سیاست «حداکثر انحراف موجودی» تعیین نشده است"
};

/** Round to four decimals so two identical inputs always compare equal. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Measure one venue's inventory against its opening share.
 *
 * Returns the exact reason instead of a number whenever the measurement cannot
 * be made — a venue with no value has no share, and a venue with no recorded
 * opening allocation has no target that anyone approved.
 */
export function measureVenueInventory(
  balance: { sourceId: string; irtToman: number; usdtMicros: number },
  model: InventoryModel
): { ok: true; inventory: VenueInventory } | { ok: false; reason: InventoryReason } {
  if (model.valuationPriceToman === null || !(model.valuationPriceToman > 0)) {
    return { ok: false, reason: "no_valuation_price" };
  }
  if (model.maxDeviationPoints === null) return { ok: false, reason: "policy_unset" };

  const target = model.targets.find((t) => t.sourceId === balance.sourceId);
  if (!target) return { ok: false, reason: "no_target" };

  const usdtValueToman = mulPriceSizeToman(
    model.valuationPriceToman,
    microsToUsdt(balance.usdtMicros)
  );
  const venueValueToman = balance.irtToman + usdtValueToman;
  if (venueValueToman <= 0) return { ok: false, reason: "venue_value_zero" };

  const usdtSharePercent = round4((usdtValueToman / venueValueToman) * 100);
  const deviationPoints = round4(usdtSharePercent - target.targetUsdtSharePercent);

  return {
    ok: true,
    inventory: {
      sourceId: balance.sourceId,
      venueValueToman,
      usdtValueToman,
      usdtSharePercent,
      targetUsdtSharePercent: target.targetUsdtSharePercent,
      deviationPoints,
      withinBand: Math.abs(deviationPoints) <= model.maxDeviationPoints
    }
  };
}

/** Signed movement one fill makes on one venue's balances. */
export type InventoryDelta = {
  sourceId: string;
  deltaIrtToman: number;
  deltaUsdtMicros: number;
};

export type InventoryAssessment = {
  /** False when any input the measurement needs is missing. */
  measurable: boolean;
  reason: InventoryReason;
  reasonFa: string;
  before: VenueInventory[];
  after: VenueInventory[];
  /**
   * Σ|deviation after| − Σ|deviation before|, in percentage points.
   * NEGATIVE means the trade pulls the desk back toward its opening shape;
   * positive means it pushes further away. This is the tie-break input.
   */
  impactPoints: number;
  /** True only when BOTH venues stay inside the band after the fill. */
  withinBand: boolean;
  /** The venue the trade would push out of band. Null when none would be. */
  breachedSourceId: string | null;
  breachDetailFa: string | null;
};

function unmeasurable(reason: InventoryReason): InventoryAssessment {
  return {
    measurable: false,
    reason,
    reasonFa: INVENTORY_REASON_FA[reason],
    before: [],
    after: [],
    impactPoints: 0,
    // Fail closed: an inventory limit that cannot be measured is not satisfied.
    withinBand: false,
    breachedSourceId: null,
    breachDetailFa: INVENTORY_REASON_FA[reason]
  };
}

/**
 * What one fill would do to the inventory of the two venues it touches.
 *
 * Both venues are measured before and after against the SAME model, so the
 * impact figure is a difference of two comparable readings rather than a score.
 * A venue that is already outside its band and would be pushed further out is a
 * breach; a venue outside its band that the trade pulls back toward target is
 * not — that is the whole point of preferring inventory-improving trades.
 */
export function assessInventory(input: {
  balances: VenueBalance[];
  deltas: InventoryDelta[];
  model: InventoryModel;
}): InventoryAssessment {
  if (input.model.valuationPriceToman === null || !(input.model.valuationPriceToman > 0)) {
    return unmeasurable("no_valuation_price");
  }
  if (input.model.maxDeviationPoints === null) return unmeasurable("policy_unset");

  const before: VenueInventory[] = [];
  const after: VenueInventory[] = [];

  for (const delta of input.deltas) {
    const balance = input.balances.find((b) => (b.sourceId as string) === delta.sourceId);
    if (!balance) return unmeasurable("no_target");

    const b = measureVenueInventory(
      { sourceId: delta.sourceId, irtToman: balance.irtToman, usdtMicros: balance.usdtMicros },
      input.model
    );
    if (!b.ok) return unmeasurable(b.reason);

    const a = measureVenueInventory(
      {
        sourceId: delta.sourceId,
        irtToman: balance.irtToman + delta.deltaIrtToman,
        usdtMicros: balance.usdtMicros + delta.deltaUsdtMicros
      },
      input.model
    );
    if (!a.ok) return unmeasurable(a.reason);

    before.push(b.inventory);
    after.push(a.inventory);
  }

  const sumAbs = (rows: VenueInventory[]) =>
    rows.reduce((s, r) => s + Math.abs(r.deviationPoints), 0);
  const impactPoints = round4(sumAbs(after) - sumAbs(before));

  /*
   * A breach is a venue that ends outside the band AND is worse than it started.
   * Ending outside a band it was already outside of, while moving back toward
   * target, is a repair — refusing it would trap the desk in the very imbalance
   * the policy exists to remove.
   */
  let breachedSourceId: string | null = null;
  let breachDetailFa: string | null = null;
  for (let i = 0; i < after.length; i += 1) {
    const a = after[i];
    const b = before[i];
    if (a.withinBand) continue;
    if (Math.abs(a.deviationPoints) <= Math.abs(b.deviationPoints)) continue;
    breachedSourceId = a.sourceId;
    breachDetailFa =
      `${a.sourceId}: سهم تتر از ${b.usdtSharePercent.toFixed(2)}٪ به ${a.usdtSharePercent.toFixed(2)}٪ ` +
      `می‌رفت و انحراف از هدف ${a.targetUsdtSharePercent.toFixed(2)}٪ به ${Math.abs(a.deviationPoints).toFixed(2)} ` +
      `واحد می‌رسید؛ سقف مجاز ${input.model.maxDeviationPoints} واحد است.`;
    break;
  }

  return {
    measurable: true,
    reason: "ok",
    reasonFa: INVENTORY_REASON_FA.ok,
    before,
    after,
    impactPoints,
    withinBand: breachedSourceId === null,
    breachedSourceId,
    breachDetailFa
  };
}

/**
 * Opening USDT shares, derived from the allocations a session actually started
 * with. Rows whose value is zero are omitted rather than given a share of zero:
 * a venue funded with nothing has no approved target, and inventing 0% for it
 * would silently forbid it from ever holding USDT.
 */
export function targetsFromAllocations(
  allocations: Array<{ sourceId: string; irtToman: number; usdtUnits: number }>,
  valuationPriceToman: number
): InventoryTarget[] {
  const out: InventoryTarget[] = [];
  for (const a of allocations) {
    const usdtValue = mulPriceSizeToman(valuationPriceToman, a.usdtUnits);
    const total = a.irtToman + usdtValue;
    if (total <= 0) continue;
    out.push({
      sourceId: a.sourceId,
      targetUsdtSharePercent: round4((usdtValue / total) * 100)
    });
  }
  return out;
}
