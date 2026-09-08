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



const {mkdtemp,rm}=await import("node:fs/promises");
const {tmpdir}=await import("node:os");
const dir=await mkdtemp(`${tmpdir()}/paper-runner-correctness-`);
process.env.DATABASE_URL=`pglite:${dir}/db`;
process.env.SHADOW_COLLECTOR_ENABLED="false";
const {closeDb}=await import("../src/db/client.ts");
const {runMigrations}=await import("../src/db/migrate.ts");
const repo=await import("../src/db/repositories/shadowPaper.ts");
const evidenceRepo=await import("../src/db/repositories/shadowArbitrage.ts");
const feeRepo=await import("../src/db/repositories/shadowFeeTier.ts");
const policyRepo=await import("../src/db/repositories/shadowLive.ts");
const {runPaperExecutionForCycle}=await import("../src/lib/shadowArbitrage/paper/run.ts");
try {
 await runMigrations();
 for(const sourceId of ["tabdeal","ramzinex"]){
  await evidenceRepo.recordAccountConfirmation({sourceId,kycComplete:true,accountState:"VERIFIED",executionEligible:true,provenance:"LOCAL_TEST",confirmedBy:"test"});
  await evidenceRepo.recordFeeConfirmation({sourceId,takerFeeBps:25,makerFeeBps:25,feeTier:null,confirmedBy:"test",validDays:1});
  await feeRepo.recordFeeTierEvidence({sourceId,executionMode:"ORDER_BOOK",tierLabel:null,makerFeeBps:25,takerFeeBps:25,provenance:"LOCAL_TEST",evidenceKey:sourceId,confirmedBy:"test",confirmedAt:new Date().toISOString(),validForDays:1,sourceUrl:null,note:null});
 }
 for(const [policyKey,value] of Object.entries(policyValues))await policyRepo.recordRiskPolicy({policyKey,value,setBy:"test",validForDays:1});
 const session=await repo.createPaperSession({observationId:null,name:"isolated runner regression",mode:"PROVISIONAL_EVALUATION",totalCapitalToman:150000000000,valuationPriceToman:200000,openingAllocations:balances.map(b=>({sourceId:b.sourceId,irtToman:b.irtToman,usdtUnits:b.usdtMicros/1e6})),approvalFingerprint:null,createdBy:"test",note:null});
 await repo.setPaperSessionStatus(session.id,"RUNNING");
 const freshSources=()=>[makeSnap("tabdeal",Date.now(),199900,200000,200),makeSnap("ramzinex",Date.now(),206000,206100,200)];
 let observed=0;
 const runArgs={runId:null,occurredAt:new Date().toISOString(),cycleStatus:"success" as const,sources:freshSources(),opportunities:[{...opp,id:"runner-full",firstSeenAt:new Date().toISOString(),lastSeenAt:new Date().toISOString()} as never],observeSources:async (notBefore:number)=>{assert.ok(Date.now()>=notBefore);observed++;return freshSources();}};
 const full=await runPaperExecutionForCycle(runArgs);
 assert.equal(full.filled,1,JSON.stringify(full));assert.equal(observed,2);
 let rows=await repo.loadPaperLedger(session.id,{outcome:"FILLED"});assert.equal(rows.length,1);assert.ok(rows[0].sizingAudit?.delayedRecheck);
 const afterFull=await repo.loadPaperBalances(session.id);
 const repeat=await runPaperExecutionForCycle({...runArgs,sources:freshSources()});
 assert.equal(repeat.filled,0);assert.deepEqual(await repo.loadPaperBalances(session.id),afterFull);
 observed=0;
 const risk=await runPaperExecutionForCycle({...runArgs,sources:freshSources(),opportunities:[{...opp,id:"runner-risk"} as never],observeSources:async ()=>{observed++;return observed===1?freshSources():freshSources().map(s=>s.sourceId==="ramzinex"?{...s,bookBids:[],bestBidToman:null,userSellPriceToman:null}:s);}});
 assert.equal(risk.filled,0,JSON.stringify(risk));
 assert.equal((await repo.getPaperSession(session.id))?.status,"PAUSED",JSON.stringify(risk));
 const riskRows=await repo.loadPaperLedger(session.id,{outcome:"LEG_RISK"});assert.equal(riskRows.length,1);assert.ok((riskRows[0].inventoryDeltaUsdtMicros??0)>0);
 assert.ok((await repo.loadFilledLifecycleIds(session.id)).has("runner-risk"));
 const stopped=await runPaperExecutionForCycle({...runArgs,sources:freshSources()});assert.equal(stopped.reason,"not_running");
 console.log("PASS runner integration: actual delayed observations, successful durable fill, duplicate suppression, partial-leg accounting, persistent pause, stopped execution");
}finally{await closeDb();await rm(dir,{recursive:true,force:true});}
