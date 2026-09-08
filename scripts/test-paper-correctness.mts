import assert from "node:assert/strict";
import {observeExecution} from "../src/lib/shadowArbitrage/paper/observeExecution.ts";
/**
 * Short local Paper burn-in (minutes-scale synthetic cycles, not multi-day).
 * Proves evaluateCycle continues without silent stall under realism.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { evaluateCycle } from "../src/lib/shadowArbitrage/paper/engine.ts";
import { usdtToMicros } from "../src/lib/shadowArbitrage/paper/broker.ts";
import { buildPolicyState } from "../src/lib/shadowArbitrage/live/policy.ts";
import { seedLocalPaperExecutionLimits } from "../src/lib/shadowArbitrage/paper/venueExecutionLimits.ts";
import type { NormalizedSourceSnapshot } from "../src/lib/shadowArbitrage/types.ts";

seedLocalPaperExecutionLimits({ minNotionalUsdt: 5, quantityStepUsdt: 0.01 });



const CYCLES = 40;
const T0 = Date.parse("2026-09-07T10:00:00.000Z");

function iso(ms: number) {
  return new Date(ms).toISOString();
}

function makeSnap(
  id: string,
  t: number,
  bid: number,
  ask: number,
  depth: number
): NormalizedSourceSnapshot {
  const receivedAt = iso(t);
  return {
    sourceId: id as never,
    sourceName: id,
    marketModel: "ORDER_BOOK",
    accountStatus: "READY",
    eligibilityBase: "EXECUTABLE",
    bestBidToman: bid,
    bestAskToman: ask,
    userBuyPriceToman: ask,
    userSellPriceToman: bid,
    sizeExecutables: [
      {
        sizeUsdt: 25,
        buyFillable: true,
        sellFillable: true,
        userBuyVwapToman: ask,
        userSellVwapToman: bid
      } as never
    ],
    bookBids: [{ priceToman: bid, amountUsdt: depth }],
    bookAsks: [{ priceToman: ask, amountUsdt: depth }],
    depthUsdtBid: depth,
    depthUsdtAsk: depth,
    maxExecutableUsdt: depth,
    marketFeeBps: 25,
    feeStatus: "confirmed",
    feeLabel: "t",
    feeReferenceUrl: null,
    feeVerifiedAt: receivedAt,
    sourceTimestamp: receivedAt,
    receivedAt,
    ageMs: 100,
    health: "healthy",
    errorReason: null,
    degradedReason: null,
    stale: false,
    meta: {
      endpoint: null,
      httpStatus: 200,
      latencyMs: 30,
      attempts: 1,
      rateLimited: false,
      timedOut: false,
      depthAvailable: true,
      directionVerified: true,
      priceUnit: "IRT",
      normalizationNote: null
    },
    marketData: {
      transport: "WS",
      sequence: 1,
      sourceEventTimestamp: receivedAt,
      receiveTimestamp: receivedAt,
      sourceEventAgeMs: 100,
      latencyEstimateMs: 30,
      jitterMs: 0,
      reconnectCount: 0,
      gapCount: 0,
      outOfOrderCount: 0,
      resyncCount: 0,
      resyncProvenance: null,
      snapshotResyncState: "SYNCHRONIZED"
    }
  };
}

const policyValues = {
  max_order_size_usdt: 500,
  max_venue_exposure_percent: 80,
  min_risk_adjusted_edge_percent: 0,
  max_quote_age_ms: 90_000,
  max_slippage_bps: 10,
  max_inventory_deviation_percent: 100
};
const policies = buildPolicyState(
  Object.entries(policyValues).map(([key, value]) => ({
    key: key as never,
    value,
    provenance: "ADMIN_APPROVED" as const,
    setBy: "burn-in",
    setAt: "2026-09-01T00:00:00.000Z",
    validForDays: null,
    note: null
  })),
  T0
);

const balances = [
  { sourceId: "tabdeal" as never, irtToman: 50_000_000_000, usdtMicros: usdtToMicros(50_000) },
  { sourceId: "ramzinex" as never, irtToman: 50_000_000_000, usdtMicros: usdtToMicros(50_000) }
];

const venueStates = [
  {
    sourceId: "tabdeal",
    executable: true,
    capitalClass: "EXECUTABLE",
    takerFeeBps: 25,
    feeProvenance: "ADMIN_CONFIRMED",
    feeStale: false
  },
  {
    sourceId: "ramzinex",
    executable: true,
    capitalClass: "EXECUTABLE",
    takerFeeBps: 25,
    feeProvenance: "ADMIN_CONFIRMED",
    feeStale: false
  }
] as never[];


const i=1;
  const t = T0 + i * 2_000;
  // Alternate: profitable wide edge vs thin/adverse books (no silent unknown).
  const profitable = i % 3 !== 2;
  const buyAsk = profitable ? 200_000 : 205_500;
  const sellBid = profitable ? 206_000 : 205_600;
  const depth = i % 5 === 4 ? 3 : 200; // occasional thin depth → partial/reject
  const buy = makeSnap("tabdeal", t - 200, buyAsk - 100, buyAsk, depth);
  const sell = makeSnap("ramzinex", t - 150, sellBid, sellBid + 100, depth);
  const delayedBuy =
    i % 7 === 0
      ? { ...buy, bookAsks: null, depthUsdtAsk: 0 } // disappearing liquidity
      : buy;
  const opp = {
    id: `lc-burn-${i}`,
    routeKey: "tabdeal->ramzinex",
    buySourceId: "tabdeal",
    sellSourceId: "ramzinex",
    buySourceName: "tabdeal",
    sellSourceName: "ramzinex",
    sizeUsdt: 25,
    buyVwapToman: buyAsk,
    sellVwapToman: sellBid,
    rawSpreadPercent: ((sellBid - buyAsk) / buyAsk) * 100,
    buyFeeToman: 0,
    sellFeeToman: 0,
    buyFeeBps: 25,
    sellFeeBps: 25,
    totalFeePercent: 0.5,
    slippageBufferToman: Math.round(buyAsk * 25 * 0.0005),
    rebalanceCostToman: 0,
    netProfitToman: (sellBid - buyAsk) * 25,
    netEdgePercent: ((sellBid - buyAsk) / buyAsk) * 100,
    buyCostToman: buyAsk * 25,
    sellProceedsToman: sellBid * 25,
    eligibility: "EXECUTABLE_NOW",
    blockedReasons: [],
    firstSeenAt: iso(t),
    lastSeenAt: iso(t),
    endedAt: null,
    durationMs: 0,
    maxNetEdgePercent: 1,
    maxNetProfitToman: (sellBid - buyAsk) * 25,
    maxRawSpreadPercent: 1,
    feeUnknown: false,
    observationCount: 1,
    isActive: true,
    buyAgeMs: 100,
    sellAgeMs: 100
  };

  const input = ({
    opportunities: [opp as never],
    sources: [buy, sell],
    delayedSources: [delayedBuy as never, sell],
    venueStates,
    executedLifecycleIds: new Set(),
    balances,
    sizing: {
      policies,
      allocationTomanBySource: new Map([
        ["tabdeal", 40_000_000_000],
        ["ramzinex", 40_000_000_000]
      ]),
      portfolioValueToman: 100_000_000_000,
      exposureTomanBySource: new Map([
        ["tabdeal", 10_000_000_000],
        ["ramzinex", 10_000_000_000]
      ]),
      slippageBufferBps: 5,
      inventoryModel: {
        valuationPriceToman: buyAsk,
        maxDeviationPoints: 100,
        targets: [
          { sourceId: "tabdeal", targetUsdtSharePercent: 50 },
          { sourceId: "ramzinex", targetUsdtSharePercent: 50 }
        ]
      }
    },
    decisionTimestampMs: t,
    paperExecutionRealism: {
      latency: { baseArrivalDelayMs: 250, maxDelayMs: 5000, fixedDelayMs: 300 },
      allowPartialFill: true,
      simulateLegRisk: true,
      firstLeg: "buy",
      slippageBufferBps: 5
    }
  });


const arrivalBuy=makeSnap("tabdeal",t+300,199900,200000,200);
const arrivalSell=makeSnap("ramzinex",t+300,206000,206100,200);
const postBuy=makeSnap("tabdeal",t+600,199900,200000,200);
const postSell=makeSnap("ramzinex",t+600,206000,206100,200);
const fresh={...input,delayedSources:[arrivalBuy,arrivalSell],postFirstLegSources:[postBuy,postSell],arrivalTimestampMs:t+300,postFirstLegTimestampMs:t+600};
const run=(x: typeof fresh)=>evaluateCycle(x as Parameters<typeof evaluateCycle>[0]);
const complete=run(fresh);
assert.equal(complete.executedCount,1);
const execution=complete.decisions.find(d=>d.kind==="EXECUTE");
assert.ok(execution?.kind==="EXECUTE");
assert.equal(execution.executionOutcome,"FILLED");
const policy1=buildPolicyState(Object.entries({...policyValues,min_risk_adjusted_edge_percent:1}).map(([key,value])=>({key:key as never,value,provenance:"ADMIN_APPROVED" as const,setBy:"test",setAt:iso(T0),validForDays:null,note:null})),T0);
const floor=run({...fresh,sizing:{...input.sizing,policies:policy1},delayedSources:[arrivalBuy,makeSnap("ramzinex",t+300,201500,201600,200)]});
assert.equal(floor.executedCount,0);
assert.ok(floor.decisions.some(d=>d.kind==="SKIP"&&d.code==="delayed_edge_below_floor"));
const gone={...postSell,bookBids:[],bestBidToman:null,userSellPriceToman:null};
const risk=run({...fresh,postFirstLegSources:[postBuy,gone]});
assert.equal(risk.executedCount,0);
const exposure=risk.decisions.find(d=>d.kind==="EXECUTE");
assert.ok(exposure?.kind==="EXECUTE");
assert.equal(exposure.executionOutcome,"LEG_RISK");
assert.equal(exposure.plan.sellLeg.sizeUsdt,0);
assert.ok(exposure.plan.buyLeg.sizeUsdt>0);
const changed=run({...fresh,postFirstLegSources:[postBuy,makeSnap("ramzinex",t+600,205500,205600,200)]});
const d=changed.decisions.find(d=>d.kind==="EXECUTE");
assert.ok(d?.kind==="EXECUTE");
assert.equal(d.candidate.sellVwapToman,205500);
assert.equal(d.sizing.economics?.riskAdjustedPnlToman,d.plan.riskAdjustedPnlToman);
const otc={...arrivalBuy,marketModel:"OTC_QUOTE" as const,bookBids:null,bookAsks:null};
const otcResult=run({...fresh,delayedSources:[otc,arrivalSell]});
assert.equal(otcResult.executedCount,1);
let clock=t; const observed:number[]=[];
const obs=await observeExecution({detection:[buy,sell],decisionTimestampMs:t,now:()=>clock,sleep:async ms=>{clock+=ms},observe:async after=>{observed.push(after);return observed.length===1?[makeSnap("tabdeal",clock,199900,200000,200)]:[]}});
assert.equal(observed.length,2);assert.ok(observed[0]>t);assert.ok(observed[1]>observed[0]);
assert.equal(obs.postFirstLegSources[0].health,"unavailable");
console.log("PASS engine: valid fill, policy floor, durable-exposure decision, actual second price, OTC, observation sequencing and missing post observation");
