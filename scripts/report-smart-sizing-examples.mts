#!/usr/bin/env npx tsx
/**
 * Fixed versus smart sizing, on order books collected live, right now.
 *
 *   npx tsx scripts/report-smart-sizing-examples.mts
 *
 * Read-only in every direction that matters: it calls the same public
 * order-book endpoints the collector calls, opens no database, writes nothing,
 * and cannot place an order, move a balance or touch a credential. Its only
 * job is to print, for a handful of real routes, what the fixed 5/10/20/25
 * ladder would have produced and what SMART_CAPITAL_DEPTH produces instead.
 *
 * TWO THINGS ARE SUPPLIED BY THIS SCRIPT AND ARE NOT PRODUCTION STATE:
 *
 *   1. The risk policies. Production has them UNSET, which is exactly why it
 *      refuses to size anything today; the values below are this script's own
 *      choice so that a comparison can be printed at all. They are not
 *      approvals and they are written nowhere.
 *   2. The session shape — 10,000,000,000 toman split evenly over the nine
 *      venues, half toman and half USDT — which is the approved local session's
 *      shape, reconstructed here rather than read from a database.
 *
 * The order books, the prices and the depth are real.
 */
const { collectAllShadowSources } = await import("../src/lib/shadowArbitrage/adapters/index.ts");
const { computeRouteSize, BASELINE_FIXED_SIZES_USDT, SMART_SIZING_POLICY } = await import(
  "../src/lib/shadowArbitrage/paper/sizing.ts"
);
const { targetsFromAllocations } = await import("../src/lib/shadowArbitrage/paper/inventory.ts");
const { buildPolicyState } = await import("../src/lib/shadowArbitrage/live/policy.ts");
const { settlementFor, usdtToMicros, microsToUsdt } = await import(
  "../src/lib/shadowArbitrage/paper/broker.ts"
);
const { SLIPPAGE_BUFFER_BPS } = await import("../src/lib/shadowArbitrage/config.ts");

/** The approved local fee matrix, in basis points. */
const FEES: Record<string, number> = {
  nobitex: 25,
  wallex: 30,
  tabdeal: 30,
  bitpin: 35,
  ramzinex: 25,
  abantether: 30,
  tetherland: 45,
  bit24: 20,
  arzinja: 30
};

/** Demonstration risk values. NOT approvals — see the header. */
const DEMO_POLICY: Record<string, number> = {
  max_order_size_usdt: 2_000,
  max_venue_exposure_percent: 25,
  min_risk_adjusted_edge_percent: 0.01,
  max_quote_age_ms: 120_000,
  max_slippage_bps: 200,
  max_inventory_deviation_percent: 20
};

const TOTAL_TOMAN = 10_000_000_000;
const fa = (n: number) => n.toLocaleString("en-US");
const usdt = (micros: number) => (micros / 1_000_000).toFixed(4);

console.log("collecting live order books (read-only, no credential, no order)…\n");
const snapshots = await collectAllShadowSources();

const healthy = snapshots.filter(
  (s) => s.health !== "unavailable" && !s.stale && (s.bookAsks?.length || s.bookBids?.length)
);
if (!healthy.length) {
  console.log("no venue returned a usable book in this cycle — nothing to compare.");
  process.exit(0);
}

/** A mark price from the collected books, so the session can be valued. */
const marks = healthy
  .map((s) => s.userBuyPriceToman)
  .filter((p): p is number => typeof p === "number" && p > 0)
  .sort((a, b) => a - b);
const MARK = marks[Math.floor(marks.length / 2)];

const venueIds = healthy.map((s) => s.sourceId as string);
const perVenue = Math.floor(TOTAL_TOMAN / venueIds.length);
const allocations = venueIds.map((sourceId) => {
  const usdtSideToman = Math.floor(perVenue / 2);
  const usdtUnits = Math.round((usdtSideToman / MARK) * 1_000_000) / 1_000_000;
  return { sourceId, irtToman: perVenue - Math.round(usdtUnits * MARK), usdtUnits };
});
const balances = allocations.map((a) => ({
  sourceId: a.sourceId as never,
  irtToman: a.irtToman,
  usdtMicros: usdtToMicros(a.usdtUnits)
}));

const policies = buildPolicyState(
  Object.entries(DEMO_POLICY).map(([key, value]) => ({
    key: key as never,
    value,
    provenance: "ADMIN_APPROVED" as const,
    setBy: "report-script",
    setAt: new Date().toISOString(),
    validForDays: null,
    note: "demonstration value — not an approval"
  })),
  Date.now()
);

const inventoryModel = {
  valuationPriceToman: MARK,
  targets: targetsFromAllocations(allocations, MARK),
  maxDeviationPoints: DEMO_POLICY.max_inventory_deviation_percent
};

const snapshotById = new Map(snapshots.map((s) => [s.sourceId as string, s]));
const allocationTomanBySource = new Map(
  allocations.map((a) => [a.sourceId, Math.round(a.irtToman + a.usdtUnits * MARK)])
);
const exposureTomanBySource = new Map(
  balances.map((b) => [
    b.sourceId as string,
    b.irtToman + Math.round(microsToUsdt(b.usdtMicros) * MARK)
  ])
);
const portfolioValueToman = [...exposureTomanBySource.values()].reduce((s, v) => s + v, 0);

console.log(`mark price used for valuation: ${fa(MARK)} toman (median of the collected buy prices)`);
console.log(`session: ${fa(TOTAL_TOMAN)} toman over ${venueIds.length} venues`);
console.log(
  `per venue: ${fa(allocations[0].irtToman)} toman + ${allocations[0].usdtUnits.toFixed(4)} USDT\n`
);

type Row = {
  routeKey: string;
  status: string;
  smartUsdt: number | null;
  smartPnl: number | null;
  smartBps: number | null;
  binding: string | null;
  limiting: string;
  capitalCap: string;
  depthCap: string;
  inventory: number | null;
  nextLarger: string;
  baselineBest: number | null;
  baselineSize: number | null;
  blocker: string;
  /** The evaluated ladder, so the whole curve can be printed. */
  ladder: Array<{
    usdt: string;
    percent: number | null;
    pnl: number;
    bps: number;
    inventory: number;
    verdict: string;
  }>;
  baselineRows: Array<{ usdt: number; pnl: number | null; bps: number | null; note: string }>;
};

const rows: Row[] = [];

for (const buy of healthy) {
  for (const sell of healthy) {
    if (buy.sourceId === sell.sourceId) continue;
    const r = computeRouteSize({
      buySourceId: buy.sourceId as string,
      sellSourceId: sell.sourceId as string,
      buySnapshot: snapshotById.get(buy.sourceId as string),
      sellSnapshot: snapshotById.get(sell.sourceId as string),
      buyFeeBps: FEES[buy.sourceId as string] ?? null,
      sellFeeBps: FEES[sell.sourceId as string] ?? null,
      buySettlement: settlementFor(buy.sourceId as never, "buy"),
      sellSettlement: settlementFor(sell.sourceId as never, "sell"),
      balances,
      buyVenueAllocationToman: allocationTomanBySource.get(buy.sourceId as string) ?? null,
      portfolioValueToman,
      buyVenueExposureToman: exposureTomanBySource.get(buy.sourceId as string) ?? null,
      policies,
      slippageBufferBps: SLIPPAGE_BUFFER_BPS,
      inventoryModel,
      buyQuote:
        buy.marketModel === "OTC_QUOTE"
          ? {
              userBuyPriceToman: buy.userBuyPriceToman,
              userSellPriceToman: buy.userSellPriceToman,
              maxExecutableUsdt: buy.maxExecutableUsdt,
              ageMs: buy.ageMs,
              stale: buy.stale,
              maxQuoteAgeMs: DEMO_POLICY.max_quote_age_ms
            }
          : undefined,
      sellQuote:
        sell.marketModel === "OTC_QUOTE"
          ? {
              userBuyPriceToman: sell.userBuyPriceToman,
              userSellPriceToman: sell.userSellPriceToman,
              maxExecutableUsdt: sell.maxExecutableUsdt,
              ageMs: sell.ageMs,
              stale: sell.stale,
              maxQuoteAgeMs: DEMO_POLICY.max_quote_age_ms
            }
          : undefined
    });

    rows.push({
      routeKey: `${buy.sourceId}→${sell.sourceId}`,
      status: r.status,
      smartUsdt: r.sizeUsdt,
      smartPnl: r.economics?.riskAdjustedPnlToman ?? null,
      smartBps: r.economics?.riskAdjustedReturnBps ?? null,
      binding: r.bindingConstraint,
      limiting: r.capacity
        ? `${usdt(r.capacity.limitingUsableMicros)} (${r.capacity.limitingSide} @ ${r.capacity.limitingSourceId})`
        : "—",
      capitalCap: r.capacity ? usdt(r.capacity.capitalCapMicros) : "—",
      depthCap: r.capacity ? usdt(r.capacity.depthCapMicros) : "—",
      inventory: r.inventory?.measurable ? r.inventory.impactPoints : null,
      nextLarger: r.selection?.nextLarger
        ? `${usdt(r.selection.nextLarger.sizeUsdtMicros)} → ${r.selection.nextLarger.code}`
        : r.selection
          ? "no larger candidate — the ceiling itself was chosen"
          : "—",
      baselineBest: r.baseline?.bestRiskAdjustedPnlToman ?? null,
      baselineSize: r.baseline?.bestSizeUsdt ?? null,
      blocker: r.blockers[0]?.code ?? "",
      ladder: r.candidates.map((c) => ({
        usdt: usdt(c.sizeUsdtMicros),
        percent: c.percentOfUsable,
        pnl: c.riskAdjustedPnlToman,
        bps: c.riskAdjustedReturnBps,
        inventory: c.inventoryImpactPoints,
        verdict: c.eligible ? "eligible" : (c.rejectionCode ?? "rejected")
      })),
      baselineRows: (r.baseline?.rows ?? []).map((b) => ({
        usdt: b.sizeUsdt,
        pnl: b.riskAdjustedPnlToman,
        bps: b.riskAdjustedReturnBps,
        note: b.reasonFa
      }))
    });
  }
}

const sized = rows
  .filter((r) => r.status === "SIZED")
  .sort((a, b) => (b.smartPnl ?? 0) - (a.smartPnl ?? 0));

console.log(`policy: ${SMART_SIZING_POLICY}`);
console.log(`baseline ladder (never executable): ${BASELINE_FIXED_SIZES_USDT.join(", ")} USDT`);
console.log(
  `\nevaluated ${rows.length} ordered venue pairs; ${sized.length} produced a size.\n`
);

const show = sized.slice(0, 6);
for (const r of show) {
  const gain =
    r.smartPnl !== null && r.baselineBest !== null ? r.smartPnl - r.baselineBest : null;
  console.log(`── ${r.routeKey} ─────────────────────────────────────────────`);
  console.log(`   smart size            ${r.smartUsdt?.toFixed(4)} USDT   (binding: ${r.binding ?? "profit curve, not a cap"})`);
  console.log(`   limiting usable       ${r.limiting} USDT`);
  console.log(`   capital cap (10%)     ${r.capitalCap} USDT`);
  console.log(`   depth cap (10%)       ${r.depthCap} USDT`);
  console.log(`   risk-adjusted PnL     ${fa(r.smartPnl ?? 0)} toman  (${r.smartBps} bps)`);
  console.log(`   inventory effect      ${r.inventory === null ? "—" : `${r.inventory} points`}`);
  console.log(`   why not bigger        ${r.nextLarger}`);
  console.log(
    `   FIXED baseline        best ${r.baselineSize ?? "—"} USDT → ${
      r.baselineBest === null ? "not fillable" : `${fa(r.baselineBest)} toman`
    }   [comparison only, never executed]`
  );
  if (gain !== null) {
    console.log(`   difference            ${gain >= 0 ? "+" : ""}${fa(gain)} toman on the same books`);
  }
  console.log("\n   candidate ladder (smart):");
  console.log("     size (USDT)     %cap        PnL (toman)      bps    inventory  verdict");
  for (const c of r.ladder) {
    console.log(
      `     ${c.usdt.padStart(12)}  ${(c.percent === null ? "cap" : `${c.percent}%`).padStart(6)}  ` +
        `${fa(c.pnl).padStart(14)}  ${String(c.bps).padStart(7)}  ${String(c.inventory).padStart(9)}  ${c.verdict}`
    );
  }
  console.log("\n   fixed ladder (baseline, never executed):");
  for (const b of r.baselineRows) {
    console.log(
      `     ${String(b.usdt).padStart(12)}  ${"—".padStart(6)}  ` +
        `${(b.pnl === null ? "—" : fa(b.pnl)).padStart(14)}  ${String(b.bps ?? "—").padStart(7)}  ` +
        `${"—".padStart(9)}  ${b.note}`
    );
  }
  console.log("");
}

/*
 * The most interesting blocked routes. "Nothing traded" is the normal state of
 * this market, and the reason a route did not trade is evidence too — so the
 * three that came closest are printed with their best evaluated candidate.
 */
const nearMiss = rows
  .filter((r) => r.status === "BLOCKED" && r.ladder.length > 0)
  .sort((a, b) => Math.max(...b.ladder.map((c) => c.pnl)) - Math.max(...a.ladder.map((c) => c.pnl)))
  .slice(0, 3);

if (nearMiss.length) {
  console.log("── routes that were sized but not taken ──────────────────────");
  for (const r of nearMiss) {
    const best = [...r.ladder].sort((a, b) => b.pnl - a.pnl)[0];
    console.log(
      `   ${r.routeKey.padEnd(24)} ${r.ladder.length} candidates, best ${best.usdt} USDT → ` +
        `${fa(best.pnl)} toman (${best.bps} bps) — ${r.blocker}`
    );
    console.log(
      `      capital cap ${r.capitalCap} · depth cap ${r.depthCap} · limiting ${r.limiting}`
    );
  }
  console.log("");
}

const blocked = rows.filter((r) => r.status === "BLOCKED");
if (blocked.length) {
  const byCode = new Map<string, number>();
  for (const r of blocked) byCode.set(r.blocker, (byCode.get(r.blocker) ?? 0) + 1);
  console.log("blocked routes, by first reason:");
  for (const [code, n] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(3)}  ${code}`);
  }
}

console.log(
  "\nreminder: the risk policies above were chosen by this script for the comparison." +
    "\nProduction has them UNSET and therefore still sizes nothing."
);
process.exit(0);
