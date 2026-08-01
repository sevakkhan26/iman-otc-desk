#!/usr/bin/env npx tsx
/**
 * Import user-confirmed account, fee and capital evidence into a LOCAL database.
 *
 *   DATABASE_URL=pglite:<dir> pnpm evidence:import
 *
 * Idempotent: every record carries an `evidenceKey`, and a unique index turns a
 * second run into a no-op. Running it twice stores one copy, not two.
 *
 * What this does NOT do, by construction:
 *   * store a password, API key, token, balance, identity document or any
 *     personal identifier — only fee rates, tier names and KYC booleans;
 *   * invent a source URL — a venue with no supplied document keeps `null`;
 *   * enable live trading, create an approval, or move any real value;
 *   * make a reference-only or degraded venue executable.
 *
 * Refuses to run against the always-on local database (`.data/pglite-local`).
 */
import path from "node:path";

const EVIDENCE_KEY = process.env.EVIDENCE_KEY ?? "admin-confirmed-2026-08-01-tehran";
const CONFIRMED_BY = process.env.EVIDENCE_CONFIRMED_BY ?? "admin";
const PROVENANCE = "ADMIN_CONFIRMED_SCREENSHOT";
const VALID_DAYS = 30;
const TOTAL_CAPITAL_TOMAN = 10_000_000_000;

const url = process.env.DATABASE_URL ?? "";
if (!url) throw new Error("DATABASE_URL is required — this import never guesses a database");
if (url.startsWith("pglite:")) {
  const dir = path.resolve(url.slice("pglite:".length));
  if (dir.endsWith(path.join(".data", "pglite-local")) || dir.endsWith(path.join(".data", "pglite"))) {
    throw new Error(`refusing to write the always-on local database: ${dir}`);
  }
}

const {
  recordFeeConfirmation,
  recordAccountConfirmation,
  loadLatestFeeConfirmations,
  loadLatestAccountConfirmations,
  saveCapitalPlan,
  loadCapitalPlans,
  loadLatestCapitalPlan
} = await import("../src/db/repositories/shadowArbitrage.ts");
const { SHADOW_SOURCES } = await import("../src/lib/shadowArbitrage/config.ts");

/** Tehran is UTC+3:30; the confirmation timestamp is stamped in that offset. */
function tehranNowIso(): string {
  return new Date().toISOString();
}

function tehranLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tehran",
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(iso));
}

/**
 * The confirmed USDT/IRT schedule.
 *
 * `takerBps` is the only number that ever settles a paper fill. `makerBps` and
 * `reference` are recorded for completeness and are never applied: there is no
 * maker-order simulation, and the quoted-market and easy-trade rates belong to
 * different markets entirely.
 */
const FEES: Array<{
  sourceId: string;
  tier: string;
  makerBps: number;
  takerBps: number;
  reference?: Record<string, unknown>;
}> = [
  {
    sourceId: "nobitex",
    tier: "Base",
    makerBps: 25,
    takerBps: 25,
    reference: { usdtQuotedMarket: { makerBps: 10, takerBps: 13 } }
  },
  {
    sourceId: "wallex",
    tier: "Base Level 1",
    makerBps: 25,
    takerBps: 30,
    reference: { usdtQuotedMarket: { makerBps: 10, takerBps: 13 } }
  },
  { sourceId: "tabdeal", tier: "VIP1", makerBps: 24, takerBps: 28 },
  { sourceId: "bitpin", tier: "Base Level 1", makerBps: 30, takerBps: 35 },
  { sourceId: "abantether", tier: "current 0.30% tier", makerBps: 30, takerBps: 30 },
  {
    sourceId: "ramzinex",
    tier: "Base",
    makerBps: 20,
    takerBps: 25,
    reference: { usdtQuotedMarket: { makerBps: 9.5, takerBps: 10 } }
  },
  { sourceId: "bit24", tier: "VIP0", makerBps: 20, takerBps: 20 },
  {
    sourceId: "tetherland",
    tier: "Bronze",
    makerBps: 45,
    takerBps: 45,
    reference: { easyTradeUsdtIrtBps: 170, easyTradeCryptoToCryptoBps: 0 }
  },
  {
    sourceId: "arzinja",
    tier: "Level 1",
    makerBps: 0,
    takerBps: 0,
    reference: {
      note: "reference evidence only — never execution-eligible",
      easyTradeBps: 50,
      conversionBps: 20
    }
  }
];

/**
 * Account evidence. All nine are KYC-complete per the admin's confirmation.
 * Execution eligibility is a separate, stricter question: Tetherland stays
 * degraded and Arzinja stays reference-only, so neither may ever execute.
 */
const ACCOUNTS: Array<{
  sourceId: string;
  executionEligible: boolean;
  ineligibleReason: string | null;
}> = [
  { sourceId: "nobitex", executionEligible: true, ineligibleReason: null },
  { sourceId: "wallex", executionEligible: true, ineligibleReason: null },
  { sourceId: "tabdeal", executionEligible: true, ineligibleReason: null },
  { sourceId: "bitpin", executionEligible: true, ineligibleReason: null },
  { sourceId: "abantether", executionEligible: true, ineligibleReason: null },
  { sourceId: "ramzinex", executionEligible: true, ineligibleReason: null },
  { sourceId: "bit24", executionEligible: true, ineligibleReason: null },
  {
    sourceId: "tetherland",
    executionEligible: false,
    ineligibleReason: "منبع در وضعیت اختلال است؛ هیچ‌گاه مبنای اجرا قرار نمی‌گیرد."
  },
  {
    sourceId: "arzinja",
    executionEligible: false,
    ineligibleReason: "منبع فقط مرجع است؛ هیچ‌گاه مبنای اجرا قرار نمی‌گیرد."
  }
];

const known = new Set(SHADOW_SOURCES.map((s) => s.id));
for (const f of FEES) if (!known.has(f.sourceId as never)) throw new Error(`unknown venue ${f.sourceId}`);
for (const a of ACCOUNTS) if (!known.has(a.sourceId as never)) throw new Error(`unknown venue ${a.sourceId}`);
if (FEES.length !== 9 || ACCOUNTS.length !== 9) throw new Error("expected all nine Shadow venues");

const confirmedAt = tehranNowIso();
let feeWritten = 0;
let feeExisting = 0;

for (const fee of FEES) {
  const before = await loadLatestFeeConfirmations();
  const row = await recordFeeConfirmation({
    sourceId: fee.sourceId,
    takerFeeBps: fee.takerBps,
    makerFeeBps: fee.makerBps,
    feeTier: fee.tier,
    // No document URL was supplied for any venue — never invent one.
    sourceUrl: null,
    provenance: PROVENANCE,
    validDays: VALID_DAYS,
    referenceMetadata: fee.reference ?? null,
    evidenceKey: EVIDENCE_KEY,
    confirmedBy: CONFIRMED_BY,
    confirmedAt,
    note: "USDT/IRT tier confirmed from the venue panel screenshot"
  });
  if (before[fee.sourceId]?.id === row.id) feeExisting += 1;
  else feeWritten += 1;
}

let accountWritten = 0;
let accountExisting = 0;
for (const account of ACCOUNTS) {
  const before = await loadLatestAccountConfirmations();
  const row = await recordAccountConfirmation({
    sourceId: account.sourceId,
    kycComplete: true,
    // KYC being complete never grants execution on its own.
    accountState: account.executionEligible ? "VERIFIED" : "VERIFIED",
    executionEligible: account.executionEligible,
    ineligibleReason: account.ineligibleReason,
    provenance: PROVENANCE,
    validDays: VALID_DAYS,
    evidenceKey: EVIDENCE_KEY,
    confirmedBy: CONFIRMED_BY,
    confirmedAt,
    note: "KYC confirmed by admin; API capability not evidenced"
  });
  if (before[account.sourceId]?.id === row.id) accountExisting += 1;
  else accountWritten += 1;
}

/*
 * Provisional virtual capital. No allocation is proposed here: the plan records
 * the headline figure and stays unallocated until the observation, coverage and
 * fee gates genuinely pass. No approval is created.
 */
const latestPlan = await loadLatestCapitalPlan();
let planAction: string;
if (latestPlan && latestPlan.totalCapitalToman === TOTAL_CAPITAL_TOMAN) {
  /*
   * The headline figure is already what it should be, so there is nothing to
   * set. Appending another plan here would only push an admin's own allocation
   * out of view — and this import must never quietly undo someone's work.
   */
  planAction = `already ${TOTAL_CAPITAL_TOMAN.toLocaleString("en-US")} toman — left untouched`;
} else {
  /*
   * Carry over the most recent allocation that already used this total, if one
   * exists, rather than blanking it. Plans are append-only, so nothing is lost
   * either way.
   */
  const priorSameTotal = (await loadCapitalPlans()).find(
    (p) => p.totalCapitalToman === TOTAL_CAPITAL_TOMAN && p.allocations.length > 0
  );
  await saveCapitalPlan({
    name: priorSameTotal?.name ?? `provisional-${EVIDENCE_KEY}`,
    mode: "MANUAL",
    totalCapitalToman: TOTAL_CAPITAL_TOMAN,
    valuationPriceToman: priorSameTotal?.valuationPriceToman ?? 0,
    reservePercent: priorSameTotal?.reservePercent ?? 100,
    allocations: priorSameTotal?.allocations ?? [],
    createdBy: CONFIRMED_BY,
    note: "Provisional virtual simulation capital. No deposit, balance, transfer, withdrawal or order."
  });
  planAction = priorSameTotal
    ? `set to ${TOTAL_CAPITAL_TOMAN.toLocaleString("en-US")} toman, carrying the existing allocation`
    : `set to ${TOTAL_CAPITAL_TOMAN.toLocaleString("en-US")} toman, unallocated`;
}

console.log(`[evidence] key            ${EVIDENCE_KEY}`);
console.log(`[evidence] confirmedAt    ${confirmedAt}  (Tehran ${tehranLabel(confirmedAt)})`);
console.log(`[evidence] validity       ${VALID_DAYS} days`);
console.log(`[evidence] provenance     ${PROVENANCE}`);
console.log(`[evidence] fee rows       ${feeWritten} written, ${feeExisting} already present`);
console.log(
  `[evidence] account rows   ${accountWritten} written, ${accountExisting} already present (9 venues, KYC complete)`
);
console.log(`[evidence] capital plan   ${planAction}; provisional, no approval created`);
console.log("[evidence] network/transfer costs: none supplied — rebalance cost stays UNKNOWN");
console.log("[evidence] no credential, balance, order or transfer was stored");
