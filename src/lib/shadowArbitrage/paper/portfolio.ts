/**
 * Virtual portfolio maths for the simple paper-trading flow.
 *
 * Pure functions: no database, no network, no clock of their own. Two jobs:
 *
 *  1. propose an allocation of a total virtual capital across venues, and check
 *     that whatever the admin edits still adds up to exactly that total;
 *  2. summarise how a running session is doing, from balances the engine wrote.
 *
 * The capital figure is the size of the whole portfolio, never the size of a
 * trade. Trade sizing stays where it belongs — opportunity depth, the venue's
 * virtual balances and the risk limits — and nothing here changes that.
 */
import { microsToUsdt, usdtToMicros, type VenueBalance } from "@/lib/shadowArbitrage/paper/broker";
import type { ShadowSourceId } from "@/lib/shadowArbitrage/types";

export type VenueAllocation = {
  sourceId: string;
  irtToman: number;
  usdtUnits: number;
};

/** Toman value of one allocation row at a given mark price. */
export function allocationValueToman(row: VenueAllocation, markPriceToman: number): number {
  return Math.round(row.irtToman + row.usdtUnits * markPriceToman);
}

/**
 * The default the UI offers — and only offers, never saves on its own.
 *
 * Equal share of the portfolio per venue, and inside each venue half in toman
 * and half in USDT at the mark price supplied by the caller. The mark price is
 * always passed in: this module has no rate of its own and will not invent one.
 *
 * Integer money means the halves rarely divide exactly, so the toman side
 * absorbs the remainder and the last venue absorbs the split remainder. The
 * result therefore sums to the requested total exactly, which
 * `validateAllocation` re-checks rather than trusts.
 */
export function defaultAllocation(
  totalCapitalToman: number,
  venueIds: string[],
  markPriceToman: number
): VenueAllocation[] {
  if (!venueIds.length) return [];
  if (!Number.isFinite(markPriceToman) || markPriceToman <= 0) {
    throw new Error("mark price is required to convert the USDT side");
  }

  const total = Math.max(0, Math.round(totalCapitalToman));
  const perVenue = Math.floor(total / venueIds.length);
  const remainder = total - perVenue * venueIds.length;

  const rows = venueIds.map((sourceId, index) => {
    // The first venues absorb the indivisible toman remainder, one each.
    const share = perVenue + (index < remainder ? 1 : 0);
    const usdtSideToman = Math.floor(share / 2);
    // Round the USDT quantity to whole micros, then give the toman side the rest
    // so the row is worth exactly its share again.
    const usdtMicros = Math.round((usdtSideToman / markPriceToman) * 1_000_000);
    const usdtUnits = microsToUsdt(usdtMicros);
    const usdtValue = Math.round(usdtUnits * markPriceToman);
    return { sourceId, irtToman: share - usdtValue, usdtUnits };
  });

  /*
   * Two ways to value the same portfolio disagree by a rial or two: rounding
   * each venue's USDT to toman and adding up, versus adding the USDT first and
   * rounding once. Both are legitimate readings, and a portfolio that is exact
   * under one and short under the other is not exact. The first venue absorbs
   * that difference so the opening balances themselves — the money the engine
   * will actually spend — are worth precisely the stated total.
   */
  const aggregateMicros = rows.reduce((sum, r) => sum + usdtToMicros(r.usdtUnits), 0);
  const aggregateIrt = rows.reduce((sum, r) => sum + r.irtToman, 0);
  const aggregateValue = Math.round(aggregateIrt + (aggregateMicros / 1_000_000) * markPriceToman);
  const drift = total - aggregateValue;
  if (drift !== 0 && rows.length) rows[0] = { ...rows[0], irtToman: rows[0].irtToman + drift };

  return rows;
}

/**
 * Value a whole portfolio the way the ledger does: add the USDT, then convert
 * once. `validateAllocation` rounds per row; a correct allocation agrees with
 * both, which is what `defaultAllocation` guarantees.
 */
export function portfolioValueToman(
  allocations: VenueAllocation[],
  markPriceToman: number
): number {
  const irt = allocations.reduce((sum, r) => sum + r.irtToman, 0);
  const micros = allocations.reduce((sum, r) => sum + usdtToMicros(r.usdtUnits), 0);
  return Math.round(irt + (micros / 1_000_000) * markPriceToman);
}

export type AllocationValidation = {
  ok: boolean;
  totalCapitalToman: number;
  allocatedToman: number;
  /** allocated − total. Zero is the only acceptable value. */
  residualToman: number;
  perVenue: Array<VenueAllocation & { valueToman: number; sharePercent: number }>;
  errorsFa: string[];
};

/**
 * Check an edited allocation before anything is created.
 *
 * Conservation is exact: the sum of every venue's toman plus the toman value of
 * its USDT must equal the total to the rial. A residual is reported rather than
 * rounded away, because a portfolio that does not add up is a bug the admin
 * should see before a session exists.
 */
export function validateAllocation(input: {
  totalCapitalToman: number;
  allocations: VenueAllocation[];
  markPriceToman: number;
  eligibleVenueIds?: string[];
}): AllocationValidation {
  const errorsFa: string[] = [];
  const total = Math.round(input.totalCapitalToman);

  if (!Number.isFinite(input.markPriceToman) || input.markPriceToman <= 0) {
    errorsFa.push("قیمت مبنای تتر در دسترس نیست؛ بدون آن تبدیل انجام نمی‌شود.");
  }
  if (total <= 0) errorsFa.push("سرمایهٔ کل باید بزرگ‌تر از صفر باشد.");

  const eligible = input.eligibleVenueIds ? new Set(input.eligibleVenueIds) : null;
  const seen = new Set<string>();

  for (const row of input.allocations) {
    if (seen.has(row.sourceId)) errorsFa.push(`صرافی ${row.sourceId} تکراری است.`);
    seen.add(row.sourceId);
    if (eligible && !eligible.has(row.sourceId)) {
      errorsFa.push(`صرافی ${row.sourceId} اجراپذیر نیست و نباید سهم بگیرد.`);
    }
    if (row.irtToman < 0 || row.usdtUnits < 0) {
      errorsFa.push(`سهم منفی برای ${row.sourceId} مجاز نیست.`);
    }
  }

  const perVenue = input.allocations.map((row) => {
    const valueToman = allocationValueToman(row, input.markPriceToman);
    return {
      ...row,
      valueToman,
      sharePercent: total > 0 ? Math.round((valueToman / total) * 10_000) / 100 : 0
    };
  });

  /*
   * Conservation is measured the way the ledger holds the money: add the USDT
   * across venues, then convert once. Rounding each venue to toman first and
   * adding those gives a figure that can differ by a rial or two, and having two
   * definitions of "exact" is how a portfolio ends up exact under one and short
   * under the other. The per-venue values above stay for the share column.
   */
  const allocatedToman = portfolioValueToman(input.allocations, input.markPriceToman);
  const residualToman = allocatedToman - total;
  if (residualToman !== 0) {
    errorsFa.push(
      `مجموع تخصیص با سرمایهٔ کل برابر نیست؛ اختلاف ${residualToman.toLocaleString("en-US")} تومان است.`
    );
  }

  return {
    ok: errorsFa.length === 0,
    totalCapitalToman: total,
    allocatedToman,
    residualToman,
    perVenue,
    errorsFa
  };
}

/** Convert an allocation into the opening balances a session starts from. */
export function allocationToBalances(allocations: VenueAllocation[]): VenueBalance[] {
  return allocations.map((a) => ({
    sourceId: a.sourceId as ShadowSourceId,
    irtToman: Math.round(a.irtToman),
    usdtMicros: usdtToMicros(a.usdtUnits)
  }));
}

export type PortfolioSummary = {
  initialCapitalToman: number;
  /** Current toman + USDT marked at the supplied price. Null without a price. */
  markedValueToman: number | null;
  markPriceToman: number | null;
  /** Sum of the engine's own economic PnL across fills. */
  economicPnlToman: number;
  riskAdjustedPnlToman: number;
  roiPercent: number | null;
  todayPnlToman: number;
  /** Largest drop from a running peak of marked value, in toman and percent. */
  drawdownToman: number;
  drawdownPercent: number | null;
  filled: number;
  rejected: number;
  lastTradeAt: string | null;
};

/**
 * Summarise a session for the top of the simple view.
 *
 * Marked value is balances at the current mark price — the only honest way to
 * compare a portfolio holding USDT against the toman it started with. Without a
 * price it is null rather than guessed, and ROI and drawdown percent go with it.
 */
export function summarisePortfolio(input: {
  initialCapitalToman: number;
  balances: VenueBalance[];
  markPriceToman: number | null;
  fills: Array<{
    economicNetPnlToman: number | null;
    riskAdjustedPnlToman: number | null;
    occurredAt: string;
  }>;
  rejectedCount: number;
  /** Start of "today" in epoch ms, supplied by the caller — no clock here. */
  todayStartMs: number;
}): PortfolioSummary {
  const irt = input.balances.reduce((s, b) => s + b.irtToman, 0);
  const usdt = input.balances.reduce((s, b) => s + microsToUsdt(b.usdtMicros), 0);
  const markedValueToman =
    input.markPriceToman && input.markPriceToman > 0
      ? Math.round(irt + usdt * input.markPriceToman)
      : null;

  const economicPnlToman = input.fills.reduce((s, f) => s + (f.economicNetPnlToman ?? 0), 0);
  const riskAdjustedPnlToman = input.fills.reduce((s, f) => s + (f.riskAdjustedPnlToman ?? 0), 0);

  const todayPnlToman = input.fills
    .filter((f) => Date.parse(f.occurredAt) >= input.todayStartMs)
    .reduce((s, f) => s + (f.economicNetPnlToman ?? 0), 0);

  /*
   * Drawdown from the realised path: walk the fills oldest-first, tracking the
   * running peak of cumulative economic PnL. It measures the worst give-back
   * the session actually went through, not a hypothetical mark-to-market swing.
   */
  const ordered = [...input.fills].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  let running = 0;
  let peak = 0;
  let drawdownToman = 0;
  for (const f of ordered) {
    running += f.economicNetPnlToman ?? 0;
    peak = Math.max(peak, running);
    drawdownToman = Math.max(drawdownToman, peak - running);
  }

  const roiPercent =
    markedValueToman !== null && input.initialCapitalToman > 0
      ? Math.round(((markedValueToman - input.initialCapitalToman) / input.initialCapitalToman) * 10_000) / 100
      : null;

  return {
    initialCapitalToman: input.initialCapitalToman,
    markedValueToman,
    markPriceToman: input.markPriceToman,
    economicPnlToman,
    riskAdjustedPnlToman,
    roiPercent,
    todayPnlToman,
    drawdownToman,
    drawdownPercent:
      input.initialCapitalToman > 0
        ? Math.round((drawdownToman / input.initialCapitalToman) * 10_000) / 100
        : null,
    filled: input.fills.length,
    rejected: input.rejectedCount,
    lastTradeAt: ordered.length ? ordered[ordered.length - 1].occurredAt : null
  };
}
