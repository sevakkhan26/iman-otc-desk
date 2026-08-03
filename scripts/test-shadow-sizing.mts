#!/usr/bin/env npx tsx
/**
 * Phase 8C-3 — deterministic tests for dynamic paper sizing.
 *
 * Pure: no browser, no network, no database. Every policy value used here is
 * supplied explicitly by the test, which is the point — the production code
 * contains no default for any of them, and the first test proves it.
 */
import assert from "node:assert/strict";

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

const {
  computeRouteSize,
  computeAllRouteSizes,
  quantizeSizeMicros,
  rankSizedRoutes,
  MIN_EXECUTABLE_USDT_MICROS,
  CAPITAL_CAP_PERCENT,
  DEPTH_CAP_PERCENT,
  SIZE_GRANULARITY_MICROS,
  SIZING_REQUIRED_POLICIES,
  SMART_SIZING_POLICY
} = await import("../src/lib/shadowArbitrage/paper/sizing.ts");
const { buildPolicyState } = await import("../src/lib/shadowArbitrage/live/policy.ts");
const { planFill, applyFill, settlementFor, usdtToMicros } = await import(
  "../src/lib/shadowArbitrage/paper/broker.ts"
);

type Any = Record<string, unknown>;

/** Every required policy, configured. Values are the TEST's choice, not code's. */
function policies(over: Partial<Record<string, number>> = {}) {
  const base: Record<string, number> = {
    max_order_size_usdt: 1_000,
    max_venue_exposure_percent: 40,
    min_risk_adjusted_edge_percent: 0.05,
    max_quote_age_ms: 60_000,
    max_slippage_bps: 25,
    max_inventory_deviation_percent: 20
  };
  const merged = { ...base, ...over };
  return buildPolicyState(
    Object.entries(merged)
      .filter(([, v]) => v !== undefined)
      .map(([key, value]) => ({
        key: key as never,
        value: value as number,
        provenance: "ADMIN_APPROVED" as const,
        setBy: "test",
        setAt: "2026-08-01T00:00:00.000Z",
        validForDays: null,
        note: null
      })),
    Date.parse("2026-08-01T12:00:00.000Z")
  );
}

/**
 * A healthy snapshot with a real walkable book.
 *
 * Phase 8C-4 sizes from the book itself, so `depthUsdt` sets how much sits at
 * the quoted price on each side. One level keeps VWAP flat with size, which is
 * what the cap tests here are about — the nonlinear cases live in
 * `test-shadow-liquidity.mts`.
 */
function snap(
  sourceId: string,
  buyVwap: number,
  sellVwap: number,
  over: Any = {},
  depthUsdt = 10_000
): Any {
  return {
    sourceId,
    sourceName: sourceId,
    ageMs: 5_000,
    stale: false,
    health: "healthy",
    sizeExecutables: [],
    bookAsks: [{ priceToman: buyVwap, amountUsdt: depthUsdt }],
    bookBids: [{ priceToman: sellVwap, amountUsdt: depthUsdt }],
    ...over
  };
}

const IRT_FEE = { feeAsset: "IRT", debitMode: "ADD_TO_DEBIT", provenance: "ADMIN_CONFIRMED" } as const;
const USDT_FEE = { feeAsset: "USDT", debitMode: "ADD_TO_DEBIT", provenance: "ADMIN_CONFIRMED" } as const;

function input(over: Any = {}): Any {
  return {
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    // A 1% raw spread: comfortably profitable after 25bps + 35bps + 5bps.
    buySnapshot: snap("nobitex", 100_000, 99_900),
    sellSnapshot: snap("wallex", 101_100, 101_000),
    buyFeeBps: 25,
    sellFeeBps: 35,
    buySettlement: IRT_FEE,
    sellSettlement: USDT_FEE,
    balances: [
      { sourceId: "nobitex", irtToman: 1_000_000_000, usdtMicros: 5_000_000_000 },
      { sourceId: "wallex", irtToman: 1_000_000_000, usdtMicros: 5_000_000_000 }
    ],
    buyVenueAllocationToman: 1_000_000_000,
    portfolioValueToman: 10_000_000_000,
    buyVenueExposureToman: 1_000_000_000,
    policies: policies(),
    slippageBufferBps: 5,
    /*
     * Both venues open at a 33.33% USDT share (1,000,000,000 toman against
     * 5,000 USDT at 100,000), so the band starts satisfied and any breach in a
     * test is caused by that test rather than by the fixture.
     */
    inventoryModel: {
      valuationPriceToman: 100_000,
      targets: [
        { sourceId: "nobitex", targetUsdtSharePercent: 33.3333 },
        { sourceId: "wallex", targetUsdtSharePercent: 33.3333 }
      ],
      maxDeviationPoints: 20
    },
    ...over
  };
}

const run = (over: Any = {}) => computeRouteSize(input(over) as never);

/* ── 1. no invented risk values ──────────────────────────────────────────── */

await test("a missing risk policy blocks with the exact key, and no default is used", () => {
  // Nothing configured at all — the real state of this system today.
  const r = run({ policies: buildPolicyState([], Date.parse("2026-08-01T12:00:00.000Z")) });
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.sizeUsdtMicros, null);
  assert.equal(r.sizeUsdt, null);
  /*
   * Phase 8C-4: the economics of the best FEASIBLE quantity are still reported
   * while the policies are undecided — an administrator has to be able to see
   * the capacity before choosing the limit that constrains it. Nothing is
   * approved by that: the size stays null and every missing key is named.
   */
  assert.ok(r.economics, "the capacity study survives a missing policy");

  const keys = r.blockers.filter((b) => b.code === "missing_policy").map((b) => b.subject).sort();
  assert.deepEqual(keys, [...SIZING_REQUIRED_POLICIES].sort(), "every required key is named");
  for (const b of r.blockers) assert.ok(b.detailFa.length > 10, "each blocker explains itself");
});

await test("each required policy blocks on its own when the others are set", () => {
  for (const key of SIZING_REQUIRED_POLICIES) {
    const r = run({ policies: policies({ [key]: undefined }) });
    assert.equal(r.status, "BLOCKED", `${key} must block`);
    assert.deepEqual(
      r.blockers.filter((b) => b.code === "missing_policy").map((b) => b.subject),
      [key]
    );
  }
});

await test("an expired policy blocks as expired, not as configured", () => {
  const expired = buildPolicyState(
    SIZING_REQUIRED_POLICIES.map((key) => ({
      key: key as never,
      value: 10,
      provenance: "ADMIN_APPROVED" as const,
      setBy: "test",
      setAt: "2026-01-01T00:00:00.000Z",
      validForDays: 1,
      note: null
    })),
    Date.parse("2026-08-01T12:00:00.000Z")
  );
  const r = run({ policies: expired });
  assert.equal(r.status, "BLOCKED");
  assert.ok(r.blockers.every((b) => b.code === "expired_policy"));
});

await test("the sizing source file contains no default risk value", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/shadowArbitrage/paper/sizing.ts", import.meta.url), "utf8");
  // No `?? <number>` fallback may be applied to a policy lookup.
  assert.equal(
    /policyValueOrNull\([^)]*\)\s*\?\?\s*\d/.test(src),
    false,
    "a policy lookup must never fall back to a literal"
  );
  for (const key of SIZING_REQUIRED_POLICIES) {
    const assigned = new RegExp(`${key}\\s*[:=]\\s*\\d`).test(src);
    assert.equal(assigned, false, `${key} must not be assigned a literal value`);
  }
});

/* ── 2. data quality gates ───────────────────────────────────────────────── */

await test("stale market data blocks, measured against the admin's own budget", () => {
  const fresh = run({ buySnapshot: snap("nobitex", 100_000, 99_900, { ageMs: 59_000 }) });
  assert.equal(fresh.status, "SIZED", "inside the budget it still sizes");

  const stale = run({ buySnapshot: snap("nobitex", 100_000, 99_900, { ageMs: 61_000 }) });
  assert.equal(stale.status, "BLOCKED");
  assert.ok(stale.blockers.some((b) => b.code === "stale_quote" && b.subject === "nobitex"));

  // The snapshot's own stale flag blocks regardless of the age number.
  const flagged = run({ sellSnapshot: snap("wallex", 101_100, 101_000, { ageMs: 1, stale: true }) });
  assert.equal(flagged.status, "BLOCKED");
  assert.ok(flagged.blockers.some((b) => b.code === "stale_quote" && b.subject === "wallex"));
});

await test("a missing or empty book blocks rather than assuming a size", () => {
  // Phase 8C-4: depth comes from the book, so an absent book is the failure —
  // a one-sided legacy probe ladder is no longer consulted at all.
  const noBook = run({ sellSnapshot: snap("wallex", 101_100, 101_000, { bookBids: null, bookAsks: null }) });
  assert.equal(noBook.status, "BLOCKED");
  assert.ok(noBook.blockers.some((b) => b.code === "book_invalid" && b.subject === "wallex"));

  const emptyBook = run({ sellSnapshot: snap("wallex", 101_100, 101_000, { bookBids: [] }) });
  assert.equal(emptyBook.status, "BLOCKED");
  assert.ok(emptyBook.blockers.some((b) => b.code === "book_invalid"));
});

await test("an unconfirmed fee or settlement blocks with the venue named", () => {
  const noFee = run({ sellFeeBps: null });
  assert.ok(noFee.blockers.some((b) => b.code === "fee_unconfirmed" && b.subject === "wallex"));

  const unknown = { feeAsset: "UNKNOWN", debitMode: "UNKNOWN", provenance: "UNKNOWN" } as const;
  const noSettle = run({ buySettlement: unknown });
  assert.ok(
    noSettle.blockers.some((b) => b.code === "settlement_unconfirmed" && b.subject === "nobitex")
  );
});

await test("a modelled buffer above the slippage ceiling blocks", () => {
  const ok = run({ slippageBufferBps: 25 });
  assert.equal(ok.status, "SIZED", "equal to the ceiling is allowed");
  const over = run({ slippageBufferBps: 26 });
  assert.equal(over.status, "BLOCKED");
  assert.ok(over.blockers.some((b) => b.code === "slippage_over_limit"));
});

await test("a missing balance row blocks instead of sizing against nothing", () => {
  const r = run({ balances: [{ sourceId: "nobitex", irtToman: 1e9, usdtMicros: 1e9 }] });
  assert.equal(r.status, "BLOCKED");
  assert.ok(r.blockers.some((b) => b.code === "no_balance_record" && b.subject === "wallex"));
});

/* ── 3. the caps themselves ──────────────────────────────────────────────── */

const capOf = (r: { constraints: Array<{ key: string; capUsdtMicros: number | null }> }, key: string) =>
  r.constraints.find((c) => c.key === key)?.capUsdtMicros ?? null;

await test("the depth cap is a tenth of the shallower leg's executable depth", () => {
  // 300 USDT on the sell venue's bid side against 10,000 on the buy venue's
  // asks: the depth cap is 10% of 300, and it is far below the capital cap.
  const r = run({ sellSnapshot: snap("wallex", 101_100, 101_000, {}, 300) });
  assert.equal(capOf(r, "depth_cap"), usdtToMicros(30), `${DEPTH_CAP_PERCENT}% of 300`);
  assert.equal(r.status, "SIZED");
  assert.equal(r.sizeUsdtMicros, usdtToMicros(30), "the depth cap binds");
  assert.equal(r.bindingConstraint, "depth_cap");
  assert.equal(r.capacity?.depthCapSide, "sell");
  // The walk that priced it touched exactly that book, and only a tenth of it.
  assert.equal(r.quote?.sellWalk.filledMicros, usdtToMicros(30));
  assert.equal(r.quote?.sellWalk.complete, true);
  assert.equal(r.quote?.sellWalk.bookParticipationPercent, 10);
});

await test("the capital cap is a tenth of the limiting usable side balance", () => {
  const r = run();
  const cap = capOf(r, "capital_cap") as number;
  const limiting = r.capacity!.limitingUsableMicros as number;
  assert.equal(cap, Math.floor((limiting * CAPITAL_CAP_PERCENT) / 100));
  // 5,000 USDT at a 35bps USDT sell fee is the smaller side here.
  assert.equal(r.capacity!.limitingSide, "sell");
  assert.equal(r.capacity!.limitingSourceId, "wallex");
  assert.equal(r.bindingConstraint, "capital_cap");
  assert.ok(
    (r.sizeUsdtMicros as number) <= cap,
    "no fill may exceed a tenth of the side that binds it"
  );
});

await test("the buy IRT cap includes the buy fee, not just the notional", () => {
  // 1,002,500,000 toman at 100,000/USDT with a 25bps IRT fee funds exactly
  // 10,000 USDT — and one toman less must fund strictly fewer.
  const r = run({
    balances: [
      { sourceId: "nobitex", irtToman: 1_002_500_000, usdtMicros: 5_000_000_000 },
      { sourceId: "wallex", irtToman: 1_000_000_000, usdtMicros: 5_000_000_000 }
    ]
  });
  assert.equal(capOf(r, "buy_irt_balance"), usdtToMicros(10_000));

  const short = run({
    balances: [
      { sourceId: "nobitex", irtToman: 1_002_499_999, usdtMicros: 5_000_000_000 },
      { sourceId: "wallex", irtToman: 1_000_000_000, usdtMicros: 5_000_000_000 }
    ]
  });
  assert.ok((capOf(short, "buy_irt_balance") as number) < usdtToMicros(10_000));

  // And when toman is the scarce side it becomes the limiting side outright.
  const scarce = run({
    balances: [
      { sourceId: "nobitex", irtToman: 100_250_000, usdtMicros: 5_000_000_000 },
      { sourceId: "wallex", irtToman: 1_000_000_000, usdtMicros: 5_000_000_000 }
    ]
  });
  assert.equal(capOf(scarce, "buy_irt_balance"), usdtToMicros(1_000));
  assert.equal(scarce.capacity!.limitingSide, "buy");
  assert.equal(scarce.capacity!.limitingSourceId, "nobitex");
  assert.equal(capOf(scarce, "capital_cap"), usdtToMicros(100));
});

await test("the sell USDT cap is fee-inclusive: the venue is debited size plus fee", () => {
  // 10.035 USDT covers exactly 10 USDT at a 35bps USDT fee.
  const r = run({
    balances: [
      { sourceId: "nobitex", irtToman: 1_000_000_000, usdtMicros: 5_000_000_000 },
      { sourceId: "wallex", irtToman: 1_000_000_000, usdtMicros: usdtToMicros(10.035) }
    ]
  });
  const cap = capOf(r, "sell_usdt_balance") as number;
  assert.ok(cap >= usdtToMicros(9.999) && cap <= usdtToMicros(10.0001), `fee-inclusive cap: ${cap}`);
  assert.ok(cap < usdtToMicros(10.035), "the raw balance is never the cap when the fee is in USDT");

  // With an IRT-settled sell fee the whole balance is deliverable.
  const irtSell = run({
    sellSettlement: IRT_FEE,
    balances: [
      { sourceId: "nobitex", irtToman: 1_000_000_000, usdtMicros: 5_000_000_000 },
      { sourceId: "wallex", irtToman: 1_000_000_000, usdtMicros: usdtToMicros(10.035) }
    ]
  });
  assert.equal(capOf(irtSell, "sell_usdt_balance"), usdtToMicros(10.035));
});

await test("policy order cap and venue concentration each bind when they are smallest", () => {
  const order = run({ policies: policies({ max_order_size_usdt: 300 }) });
  assert.equal(order.bindingConstraint, "policy_max_order_size");
  assert.equal(order.sizeUsdtMicros, usdtToMicros(300));

  // 20% of 10,000,000,000 = 2,000,000,000 ceiling; 1,990,000,000 already held
  // leaves 10,000,000 toman of headroom = 100 USDT at 100,000.
  const conc = run({
    policies: policies({ max_venue_exposure_percent: 20 }),
    buyVenueExposureToman: 1_990_000_000
  });
  assert.equal(capOf(conc, "venue_concentration"), usdtToMicros(100));
  assert.equal(conc.bindingConstraint, "venue_concentration");
  assert.equal(conc.sizeUsdtMicros, usdtToMicros(100));
});

await test("an unmeasurable cap is null and is excluded, never treated as zero", () => {
  const r = run({ portfolioValueToman: null, buyVenueAllocationToman: null });
  assert.equal(capOf(r, "venue_concentration"), null);
  assert.equal(capOf(r, "venue_allocation"), null);
  assert.equal(r.status, "SIZED", "the measurable caps still decide the size");
  assert.ok(r.constraints.every((c) => c.detailFa.length > 5));
});

await test("liquidity and policy maxima are reported separately", () => {
  const r = run({ policies: policies({ max_order_size_usdt: 700 }) });
  // Liquidity side: the capital cap is the tightest of the five liquidity caps.
  assert.equal(r.liquidityMaxUsdtMicros, capOf(r, "capital_cap"), "depth ∧ balances ∧ caps");
  assert.equal(r.policyMaxUsdtMicros, usdtToMicros(700), "policies ∧ allocation");
  // The capital cap is smaller than the order cap here, so it still decides.
  assert.equal(r.bindingConstraint, "capital_cap");
  assert.ok((r.sizeUsdtMicros as number) < usdtToMicros(700));
});

/* ── 4. profitability boundary ───────────────────────────────────────────── */

await test("a size is chosen only when risk-adjusted PnL is strictly positive", () => {
  // A route priced at a loss: the sell VWAP sits below the buy VWAP.
  const loss = run({ sellSnapshot: snap("wallex", 99_000, 98_900) });
  assert.equal(loss.status, "BLOCKED");
  assert.equal(loss.sizeUsdtMicros, null);
  assert.ok(loss.blockers.some((b) => b.code === "not_net_positive"));
  assert.ok(loss.economics, "the losing economics are still reported, not hidden");
  assert.ok((loss.economics?.riskAdjustedPnlToman ?? 0) <= 0);

  // Just profitable: still positive, still sized.
  const win = run();
  assert.equal(win.status, "SIZED");
  assert.ok((win.economics?.riskAdjustedPnlToman ?? 0) > 0);
});

await test("an edge below the policy floor blocks even when the profit is positive", () => {
  const r = run({ policies: policies({ min_risk_adjusted_edge_percent: 99 }) });
  assert.equal(r.status, "BLOCKED");
  assert.ok((r.economics?.riskAdjustedPnlToman ?? 0) > 0, "profitable, but not enough");
  assert.ok(r.blockers.some((b) => b.code === "edge_below_floor"));
});

await test("every reported figure is an integer and the decomposition adds up", () => {
  const r = run();
  const e = r.economics!;
  const ratios = ["riskAdjustedEdgePercent", "riskAdjustedReturnBps"];
  for (const [k, v] of Object.entries(e)) {
    if (ratios.includes(k)) continue;
    assert.equal(Number.isInteger(v), true, `${k} must be an integer, got ${v}`);
  }
  assert.equal(e.economicNetPnlToman, e.cashPnlIrtToman - e.sellFeeValueToman);
  assert.equal(e.riskAdjustedPnlToman, e.economicNetPnlToman - e.slippageBufferToman);
  assert.ok(e.capitalInvolvedToman > 0);

  // The two ratios are the same number in two units, to rounding.
  assert.ok(
    Math.abs(e.riskAdjustedReturnBps - e.riskAdjustedEdgePercent * 100) < 1,
    `bps and percent must agree: ${e.riskAdjustedReturnBps} vs ${e.riskAdjustedEdgePercent}%`
  );
});

/* ── 5. size floor and ledger precision ──────────────────────────────────── */

await test("a ceiling below the executable floor blocks and names the limiting cap", () => {
  const r = run({ buyVenueAllocationToman: 2_400_000 });
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.sizeUsdtMicros, null);
  const floor = r.blockers.find((b) => b.code === "size_floor");
  assert.ok(floor, "a size floor blocker exists");
  assert.ok(floor!.detailFa.includes("سهم این صرافی"), "it names the binding cap");
  // The capacity study survives the block — the operator still sees the numbers.
  assert.ok(r.capacity, "capacity is still reported");
  assert.equal(r.candidates.length, 0);
});

await test("the size is floored to the ledger's own precision", () => {
  assert.equal(SIZE_GRANULARITY_MICROS, 100, "numeric(12,4) => 1e-4 USDT");
  assert.equal(quantizeSizeMicros(10_000_099), 10_000_000);
  assert.equal(quantizeSizeMicros(10_000_100), 10_000_100);
  assert.equal(quantizeSizeMicros(999), 900);
  // Never rounds up: flooring keeps the size inside every balance cap.
  for (const n of [1, 99, 12_345_678]) assert.ok(quantizeSizeMicros(n) <= n);

  const r = run({ buyVenueAllocationToman: 12_345_678 });
  assert.equal(r.status, "SIZED");
  assert.equal((r.sizeUsdtMicros as number) % SIZE_GRANULARITY_MICROS, 0);
  // Round-trips through the ledger's 4-decimal column without drift.
  const asStored = Number((r.sizeUsdt as number).toFixed(4));
  assert.equal(usdtToMicros(asStored), r.sizeUsdtMicros);
});

await test("the 25 USDT minimum is enforced, not advisory", () => {
  assert.equal(MIN_EXECUTABLE_USDT_MICROS, 25_000_000);
  assert.equal(SMART_SIZING_POLICY, "SMART_CAPITAL_DEPTH");

  // A ceiling of 24.9999 USDT is below the floor: no trade, not a smaller one.
  const justUnder = run({ policies: policies({ max_order_size_usdt: 24.9999 }) });
  assert.equal(justUnder.status, "BLOCKED");
  assert.equal(justUnder.sizeUsdt, null);
  assert.ok(justUnder.blockers.some((b) => b.code === "size_floor"));

  // Exactly at the floor it trades, and at exactly the floor.
  const atFloor = run({ policies: policies({ max_order_size_usdt: 25 }) });
  assert.equal(atFloor.status, "SIZED");
  assert.equal(atFloor.sizeUsdtMicros, MIN_EXECUTABLE_USDT_MICROS);

  // Every candidate ever produced clears the floor.
  for (const c of run().candidates) {
    assert.ok(
      c.sizeUsdtMicros >= MIN_EXECUTABLE_USDT_MICROS,
      `candidate ${c.sizeUsdtMicros} is below the floor`
    );
  }
});

/* ── 6. agreement with the broker, and non-negative balances ─────────────── */

await test("sizing agrees with the broker: same size prices to the same figures", () => {
  const r = run();
  const plan = planFill({
    buySourceId: "nobitex" as never,
    sellSourceId: "wallex" as never,
    sizeUsdt: r.sizeUsdt as number,
    buyVwapToman: r.quote!.buyVwapToman,
    sellVwapToman: r.quote!.sellVwapToman,
    buyFeeBps: 25,
    sellFeeBps: 35,
    buySettlement: IRT_FEE as never,
    sellSettlement: USDT_FEE as never,
    markPriceToman: r.quote!.markPriceToman,
    slippageBufferToman: r.economics!.slippageBufferToman
  });
  assert.equal(plan.ok, true, "the broker accepts the calculated size");
  if (!plan.ok) return;
  assert.equal(plan.cashPnlIrtToman, r.economics!.cashPnlIrtToman);
  assert.equal(plan.sellFeeValueToman, r.economics!.sellFeeValueToman);
  assert.equal(plan.economicNetPnlToman, r.economics!.economicNetPnlToman);
  assert.equal(plan.riskAdjustedPnlToman, r.economics!.riskAdjustedPnlToman);
});

await test("a size at the balance cap never drives a balance negative", () => {
  for (const irt of [1_002_500, 5_000_000, 250_000_000]) {
    const balances = [
      { sourceId: "nobitex", irtToman: irt, usdtMicros: usdtToMicros(40) },
      { sourceId: "wallex", irtToman: 1_000_000_000, usdtMicros: usdtToMicros(40) }
    ];
    const r = run({ balances });
    if (r.status !== "SIZED") continue;
    const plan = planFill({
      buySourceId: "nobitex" as never,
      sellSourceId: "wallex" as never,
      sizeUsdt: r.sizeUsdt as number,
      buyVwapToman: r.quote!.buyVwapToman,
      sellVwapToman: r.quote!.sellVwapToman,
      buyFeeBps: 25,
      sellFeeBps: 35,
      buySettlement: IRT_FEE as never,
      sellSettlement: USDT_FEE as never,
      markPriceToman: r.quote!.markPriceToman,
      slippageBufferToman: r.economics!.slippageBufferToman
    });
    assert.equal(plan.ok, true, `broker rejected the sized fill at irt=${irt}`);
    if (!plan.ok) continue;
    const applied = applyFill(plan, balances as never);
    assert.equal(applied.ok, true, `applyFill rejected at irt=${irt}`);
    if (!applied.ok) continue;
    for (const b of applied.balancesAfter) {
      assert.ok(b.irtToman >= 0, `IRT went negative at irt=${irt}`);
      assert.ok(b.usdtMicros >= 0, `USDT went negative at irt=${irt}`);
    }
  }
});

/* ── 7. determinism, ranking and restart ─────────────────────────────────── */

await test("the same inputs always produce the same size, constraint and reasons", () => {
  const a = run();
  const b = run();
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));

  // And it holds for a blocked route too — reasons are ordered, not incidental.
  const x = run({ policies: buildPolicyState([], Date.now()) });
  const y = run({ policies: buildPolicyState([], Date.now()) });
  assert.deepEqual(x.blockers, y.blockers);
});

await test("ranking is a total order and input order cannot change it", () => {
  const mk = (routeKey: string, pnl: number, size: number) => ({
    routeKey,
    sizing: {
      economics: { riskAdjustedPnlToman: pnl, riskAdjustedEdgePercent: 1 },
      sizeUsdtMicros: usdtToMicros(size)
    }
  });
  const rows = [mk("b->c", 100, 5), mk("a->b", 100, 5), mk("c->d", 900, 5), mk("d->e", 100, 9)];
  const once = rankSizedRoutes(rows as never).map((r) => r.routeKey);
  const twice = rankSizedRoutes([...rows].reverse() as never).map((r) => r.routeKey);
  assert.deepEqual(once, ["c->d", "d->e", "a->b", "b->c"]);
  assert.deepEqual(once, twice, "input order must not change the ranking");
  assert.deepEqual(rows.map((r) => r.routeKey), ["b->c", "a->b", "c->d", "d->e"], "input untouched");
});

await test("restart safety: recomputing from persisted state repeats the decision", () => {
  // Simulate a restart by rebuilding every input from plain JSON, the way a
  // fresh process would after reading the database.
  const first = run();
  const revived = JSON.parse(JSON.stringify(input())) as Any;
  revived.policies = policies();
  const second = computeRouteSize(revived as never);
  assert.equal(second.sizeUsdtMicros, first.sizeUsdtMicros);
  assert.equal(second.bindingConstraint, first.bindingConstraint);
  assert.deepEqual(second.economics, first.economics);
});

await test("the route sweep is stable, complete and excludes same-venue pairs", () => {
  const venueIds = ["nobitex", "wallex", "bitpin"];
  const sweep = () =>
    computeAllRouteSizes({
      venueIds,
      snapshotById: new Map([
        ["nobitex", snap("nobitex", 100_000, 99_900)],
        ["wallex", snap("wallex", 101_100, 101_000)],
        ["bitpin", snap("bitpin", 100_500, 100_400)]
      ]) as never,
      feeBpsById: new Map([
        ["nobitex", 25],
        ["wallex", 35],
        ["bitpin", 30]
      ]),
      settlementFor: (id: string, side: "buy" | "sell") => settlementFor(id as never, side),
      balances: [
        { sourceId: "nobitex", irtToman: 1e9, usdtMicros: 5e9 },
        { sourceId: "wallex", irtToman: 1e9, usdtMicros: 5e9 },
        { sourceId: "bitpin", irtToman: 1e9, usdtMicros: 5e9 }
      ] as never,
      allocationTomanBySource: new Map(venueIds.map((v) => [v, 1_000_000_000])),
      portfolioValueToman: 10_000_000_000,
      exposureTomanBySource: new Map(venueIds.map((v) => [v, 1_000_000_000])),
      policies: policies(),
      slippageBufferBps: 5,
      inventoryModel: {
        valuationPriceToman: 100_000,
        targets: venueIds.map((sourceId) => ({ sourceId, targetUsdtSharePercent: 33.3333 })),
        maxDeviationPoints: 20
      }
    });

  const a = sweep();
  assert.equal(a.length, 6, "3 venues => 6 ordered pairs");
  assert.equal(a.every((r) => r.buySourceId !== r.sellSourceId), true);
  assert.deepEqual(
    a.map((r) => r.routeKey),
    [...a.map((r) => r.routeKey)].sort(),
    "sorted, so the payload is byte-stable"
  );
  assert.deepEqual(JSON.parse(JSON.stringify(sweep())), JSON.parse(JSON.stringify(a)));
});

/* ── 8. safety boundary ──────────────────────────────────────────────────── */

await test("sizing adds no credential, order, transfer or network path", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/shadowArbitrage/paper/sizing.ts", import.meta.url), "utf8");
  for (const banned of [
    "fetch(",
    "axios",
    "apiKey",
    "apiSecret",
    "privateKey",
    "placeOrder",
    "cancelOrder",
    "withdraw",
    "deposit",
    "transferFunds",
    "@/db/"
  ]) {
    assert.equal(src.includes(banned), false, `sizing must not contain ${banned}`);
  }
  // It reads no clock of its own — a clock would break determinism on replay.
  assert.equal(/Date\.now\(\)|new Date\(\)/.test(src), false, "no clock inside sizing");

  const capability = readFileSync(
    new URL("../src/lib/shadowArbitrage/live/capability.ts", import.meta.url),
    "utf8"
  );
  assert.ok(capability.includes("export const LIVE_EXECUTION_IMPLEMENTED = false as const"));
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
