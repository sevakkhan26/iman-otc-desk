#!/usr/bin/env npx tsx
/**
 * Step 3 proofs via local HTTP (server holds pglite exclusively).
 * GET-only after login. Pure sizing compute from snapshot + policies in memory.
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const BASE = process.env.PAPER_BASE ?? "http://127.0.0.1:3210";
const OUT = path.join(process.cwd(), "evidence", "step3-fee-parity");
mkdirSync(OUT, { recursive: true });

const jar = path.join(OUT, "cookie.jar");
const login = spawnSync(
  "curl",
  [
    "-sS",
    "-c",
    jar,
    "-b",
    jar,
    "-X",
    "POST",
    `${BASE}/api/auth/login`,
    "-H",
    "Content-Type: application/json",
    "-d",
    JSON.stringify({ username: "otc-iman", password: "LocalRC4130!" })
  ],
  { encoding: "utf8" }
);
if (login.status !== 0) throw new Error("login failed " + login.stderr);

function get(p: string): unknown {
  const r = spawnSync("curl", ["-sS", "-b", jar, `${BASE}${p}`], {
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024
  });
  if (r.status !== 0) throw new Error(`GET ${p} failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const me = get("/api/auth/me") as { role?: string };
const accounts = get("/api/shadow-arbitrage/accounts") as Record<string, unknown>;
const paper = get("/api/shadow-arbitrage/paper") as Record<string, unknown>;
const matrix = get("/api/shadow-arbitrage/matrix") as Record<string, unknown>;
const observation = get("/api/shadow-arbitrage/observation") as Record<string, unknown>;
const healthLive = get("/api/health/live") as Record<string, unknown>;
const healthReady = get("/api/health/ready") as Record<string, unknown>;

// strip cookie jar from evidence (do not store session)
try {
  writeFileSync(jar, "# redacted\n");
} catch {
  /* ignore */
}

writeFileSync(path.join(OUT, "auth-me.json"), JSON.stringify(me, null, 2));
writeFileSync(path.join(OUT, "accounts.json"), JSON.stringify(accounts, null, 2));
writeFileSync(path.join(OUT, "paper.json"), JSON.stringify(paper, null, 2));
writeFileSync(path.join(OUT, "matrix.json"), JSON.stringify(matrix, null, 2));
writeFileSync(path.join(OUT, "observation.json"), JSON.stringify(observation, null, 2));
writeFileSync(path.join(OUT, "health-live.json"), JSON.stringify(healthLive, null, 2));
writeFileSync(path.join(OUT, "health-ready.json"), JSON.stringify(healthReady, null, 2));

const venues = (accounts.venues as Array<Record<string, unknown>>) ?? [];
const withFees = venues.filter((v) => v.takerFeeBps !== null && v.takerFeeBps !== undefined);
const feeUnknown = venues.filter(
  (v) => v.takerFeeBps === null || v.takerFeeBps === undefined || v.feeStale === true
);

function readCycles(obs: Record<string, unknown>): number {
  const nested = obs.observation as Record<string, unknown> | undefined;
  const runStats = obs.runStats as Record<string, unknown> | undefined;
  return Number(
    nested?.completedCycles ??
      nested?.successfulCycles ??
      runStats?.successfulRuns ??
      runStats?.runCount ??
      obs.cyclesRecorded ??
      obs.cycleCount ??
      0
  );
}

// Wait for ≥20 collector cycles if needed (nested observation.completedCycles).
let cycles = readCycles(observation);
const startWait = Date.now();
while (cycles < 20 && Date.now() - startWait < 12 * 60_000) {
  spawnSync("sleep", ["10"]);
  const obs2 = get("/api/shadow-arbitrage/observation") as Record<string, unknown>;
  writeFileSync(path.join(OUT, "observation.json"), JSON.stringify(obs2, null, 2));
  cycles = readCycles(obs2);
  console.log("cycles_so_far", cycles);
}

// Pure sizing from snapshot (no second pglite open)
const { computeRouteSize } = await import("../src/lib/shadowArbitrage/paper/sizing.ts");
const { defaultAllocation } = await import("../src/lib/shadowArbitrage/paper/portfolio.ts");
const { balancesFromAllocations } = await import("../src/lib/shadowArbitrage/paper/engine.ts");
const { settlementFor, microsToUsdt } = await import("../src/lib/shadowArbitrage/paper/broker.ts");
const { targetsFromAllocations } = await import("../src/lib/shadowArbitrage/paper/inventory.ts");
const { buildPolicyState } = await import("../src/lib/shadowArbitrage/live/policy.ts");
const { PAPER_POLICY_SET } = await import("../src/lib/shadowArbitrage/live/paperPolicySet.ts");
const { SHADOW_SOURCES, SLIPPAGE_BUFFER_BPS } = await import(
  "../src/lib/shadowArbitrage/config.ts"
);

// Policies from approved set (same as seeded)
const NOW = Date.now();
const policies = buildPolicyState(
  PAPER_POLICY_SET.map((e) => ({
    key: e.key,
    value: e.value,
    provenance: "ADMIN_APPROVED" as const,
    setBy: "local-fee-parity-seed",
    setAt: new Date(NOW).toISOString(),
    validForDays: 30,
    note: null
  })),
  NOW
);

const sources = (matrix.sources as Array<Record<string, unknown>>) ?? [];
const snapById = new Map(sources.map((s) => [String(s.sourceId), s]));
const mids = sources
  .filter((s) => !s.stale && s.userBuyPriceToman && s.userSellPriceToman)
  .map((s) => (Number(s.userBuyPriceToman) + Number(s.userSellPriceToman)) / 2)
  .filter((n) => n > 0)
  .sort((a, b) => a - b);
const mark =
  mids.length === 0
    ? 200_000
    : Math.round(
        mids.length % 2
          ? mids[Math.floor(mids.length / 2)]!
          : (mids[mids.length / 2 - 1]! + mids[mids.length / 2]!) / 2
      );

const feeById = new Map(venues.map((v) => [String(v.sourceId), Number(v.takerFeeBps)]));
const venueIds = SHADOW_SOURCES.map((s) => s.id);
const executable = new Set(
  venues
    .filter((v) => v.executionEligible && v.takerFeeBps != null)
    .map((v) => String(v.sourceId))
);

function sizeAt(capital: number, buyId: string, sellId: string) {
  const alloc = defaultAllocation(capital, venueIds, mark);
  const bals = balancesFromAllocations(alloc);
  const buyBal = bals.find((x) => x.sourceId === buyId)!;
  const sellBal = bals.find((x) => x.sourceId === sellId)!;
  const equityMap = new Map(
    bals.map((b) => [
      b.sourceId as string,
      b.irtToman + Math.round(microsToUsdt(b.usdtMicros) * mark)
    ])
  );
  // Full multi-venue book required for inventory measurement (all targets present).
  return computeRouteSize({
    buySourceId: buyId,
    sellSourceId: sellId,
    buySnapshot: snapById.get(buyId) as never,
    sellSnapshot: snapById.get(sellId) as never,
    buyFeeBps: feeById.get(buyId) ?? null,
    sellFeeBps: feeById.get(sellId) ?? null,
    buySettlement: settlementFor(buyId as never, "buy"),
    sellSettlement: settlementFor(sellId as never, "sell"),
    balances: bals,
    buyVenueAllocationToman: equityMap.get(buyId) ?? null,
    portfolioValueToman: capital,
    buyVenueExposureToman: equityMap.get(buyId) ?? 0,
    policies,
    slippageBufferBps: SLIPPAGE_BUFFER_BPS,
    inventoryModel: {
      valuationPriceToman: mark,
      targets: targetsFromAllocations(
        bals.map((b) => ({
          sourceId: b.sourceId as string,
          irtToman: b.irtToman,
          usdtUnits: microsToUsdt(b.usdtMicros)
        })),
        mark
      ),
      maxDeviationPoints: 20
    }
  });
}

const pairs: Array<[string, string]> = [];
for (const a of venueIds) {
  for (const b of venueIds) {
    if (a !== b && executable.has(a) && executable.has(b)) pairs.push([a, b]);
  }
}

const rows100: unknown[] = [];
const rows10b: unknown[] = [];
const pack = (r: ReturnType<typeof sizeAt>, capital: number, route: string) => ({
  route,
  capital,
  status: r.status,
  finalSizeUsdt: r.sizeUsdt,
  safeCeilingUsdt: r.capacity ? microsToUsdt(r.capacity.ceilingMicros) : null,
  bindingConstraint: r.bindingConstraint,
  buyDepthUsdt: r.capacity ? microsToUsdt(r.capacity.buyDepth.depthMicros) : null,
  sellDepthUsdt: r.capacity ? microsToUsdt(r.capacity.sellDepth.depthMicros) : null,
  buyVwap: r.quote?.buyVwapToman ?? null,
  sellVwap: r.quote?.sellVwapToman ?? null,
  grossSpreadToman:
    r.quote && r.sizeUsdt
      ? Math.round((r.quote.sellVwapToman - r.quote.buyVwapToman) * r.sizeUsdt)
      : null,
  buyFeeBps: r.audit?.buyFeeBps ?? null,
  sellFeeBps: r.audit?.sellFeeBps ?? null,
  riskAdjPnlToman: r.economics?.riskAdjustedPnlToman ?? null,
  predictedNetToman: r.economics?.economicNetPnlToman ?? null,
  riskAdjBps: r.economics?.riskAdjustedReturnBps ?? null,
  capitalUtilizationPercent:
    r.sizeUsdt && r.quote
      ? Math.round(((r.sizeUsdt * r.quote.buyVwapToman) / capital) * 10_000) / 100
      : null,
  blockers: r.blockers.map((b) => b.code),
  feeUnknown: r.blockers.some((b) => b.code === "fee_unconfirmed")
});

for (const [buyId, sellId] of pairs) {
  const route = `${buyId}->${sellId}`;
  rows100.push(pack(sizeAt(100_000_000, buyId, sellId), 100_000_000, route));
  rows10b.push(pack(sizeAt(10_000_000_000, buyId, sellId), 10_000_000_000, route));
}

writeFileSync(path.join(OUT, "routes-100m.json"), JSON.stringify(rows100, null, 2));
writeFileSync(path.join(OUT, "routes-10b.json"), JSON.stringify(rows10b, null, 2));

const r100 = rows100 as Array<Record<string, unknown>>;
const r10b = rows10b as Array<Record<string, unknown>>;
const scaling = r100
  .map((a, i) => {
    const b = r10b[i]!;
    if (a.status !== "SIZED" || b.status !== "SIZED") return null;
    return {
      route: a.route,
      size100M: a.finalSizeUsdt,
      size10B: b.finalSizeUsdt,
      scales: Number(b.finalSizeUsdt) > Number(a.finalSizeUsdt),
      bind100: a.bindingConstraint,
      bind10b: b.bindingConstraint
    };
  })
  .filter(Boolean);

const paperStats = (paper.stats as Record<string, unknown>) ?? {};
const blockReasons = (paperStats.blockReasons as Array<Record<string, unknown>>) ?? [];
const feeRejects = blockReasons.filter((b) =>
  String(b.code ?? b.reasonFa ?? "").toLowerCase().includes("fee")
);

const summary = {
  capturedAt: new Date().toISOString(),
  base: BASE,
  authRole: me.role,
  feesApplied: withFees.length,
  feesTotal: venues.length,
  feesApplied9of9: withFees.length === 9 && feeUnknown.length === 0,
  feeUnknownVenues: feeUnknown.map((v) => v.sourceId),
  session: paper.session
    ? {
        id: (paper.session as Record<string, unknown>).id,
        status: (paper.session as Record<string, unknown>).status,
        totalCapitalToman: (paper.session as Record<string, unknown>).totalCapitalToman
      }
    : null,
  paperStats: {
    filled: paperStats.filled,
    skipped: paperStats.skipped,
    blockReasons
  },
  feeRelatedRejections: feeRejects,
  collectorCycles: cycles,
  markPriceToman: mark,
  pairsEvaluated: pairs.length,
  eligible100M: r100.filter((r) => r.status === "SIZED").length,
  eligible10B: r10b.filter((r) => r.status === "SIZED").length,
  feeUnknownInSizing: [...r100, ...r10b].some((r) => r.feeUnknown),
  scalingTrue: scaling.filter((s) => (s as { scales: boolean }).scales).length,
  scalingSample: scaling.slice(0, 10),
  sampleSized100: r100.filter((r) => r.status === "SIZED").slice(0, 5),
  sampleSized10b: r10b.filter((r) => r.status === "SIZED").slice(0, 5),
  realOrders: paper.realOrders === false,
  paperOnly: paper.paperOnly === true,
  healthLive,
  healthReady
};

writeFileSync(path.join(OUT, "SUMMARY.json"), JSON.stringify(summary, null, 2));

// SHA-256 manifest
const files = [
  "auth-me.json",
  "accounts.json",
  "paper.json",
  "matrix.json",
  "observation.json",
  "health-live.json",
  "health-ready.json",
  "routes-100m.json",
  "routes-10b.json",
  "SUMMARY.json"
];
const manifest = files.map((f) => {
  const p = path.join(OUT, f);
  const buf = readFileSync(p);
  return {
    file: f,
    bytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex")
  };
});
writeFileSync(path.join(OUT, "MANIFEST.sha256.json"), JSON.stringify(manifest, null, 2));

console.log(JSON.stringify({ summary, manifest }, null, 2));
if (!summary.feesApplied9of9 || summary.feeUnknownInSizing) process.exit(2);
if (summary.collectorCycles < 20) {
  console.warn("WARN cycles < 20:", summary.collectorCycles);
}
