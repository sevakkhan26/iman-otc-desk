/**
 * Phase 8B — presentation model for the «فرصت‌ها» tab.
 *
 * Pure functions only: no React, no fetching, no calculation of money. Every
 * number this module returns was computed by the server and is only being
 * grouped, filtered or ordered here. Nothing is derived, defaulted or invented:
 * a metric the API did not supply stays `null`, and the UI renders «—» with an
 * explanation rather than a plausible-looking number.
 *
 * The five-figure PnL decomposition (cash, inventory, sell-fee value, economic
 * net, risk-adjusted) is produced by the Phase 6 paper engine, not by the
 * opportunity matrix. It is therefore joined in from the paper ledger by
 * lifecycle id and shown only where that evidence exists.
 */
import { classifyOpportunity, type OppClass } from "@/components/shadowArbitrage/labels";
import type { ShadowOpportunity } from "@/components/shadowArbitrage/types";

/* ── paper evidence ────────────────────────────────────────────────────────── */

/** One immutable paper-ledger row as the paper API returns it. */
export type PaperLedgerRow = {
  lifecycleId: string;
  routeKey: string;
  outcome: "FILLED" | "SKIPPED";
  sizeUsdt: number;
  rejectionCode: string | null;
  rejectionReason: string | null;
  buyFeeAsset: string | null;
  buyFeeDebitMode: string | null;
  buyFeeProvenance: string | null;
  sellFeeAsset: string | null;
  sellFeeDebitMode: string | null;
  sellFeeProvenance: string | null;
  markPriceToman: number | null;
  grossSpreadToman: number | null;
  slippageBufferToman: number | null;
  cashPnlIrtToman: number | null;
  inventoryDeltaUsdtMicros: number | null;
  sellFeeValueToman: number | null;
  economicNetPnlToman: number | null;
  riskAdjustedPnlToman: number | null;
  occurredAt: string;
};

/** What the Opportunities tab shows from a paper evaluation of one lifecycle. */
export type PaperEvidence = {
  outcome: "FILLED" | "SKIPPED";
  sizeUsdt: number;
  rejectionCode: string | null;
  rejectionReason: string | null;
  markPriceToman: number | null;
  cashPnlIrtToman: number | null;
  inventoryDeltaUsdt: number | null;
  sellFeeValueToman: number | null;
  economicNetPnlToman: number | null;
  riskAdjustedPnlToman: number | null;
  buyFeeAsset: string | null;
  buyFeeDebitMode: string | null;
  buyFeeProvenance: string | null;
  sellFeeAsset: string | null;
  sellFeeDebitMode: string | null;
  sellFeeProvenance: string | null;
  occurredAt: string;
};

const USDT_MICROS = 1_000_000;

/**
 * Index the paper ledger by lifecycle id.
 *
 * Deterministic when a lifecycle has several rows: a FILLED row always beats a
 * SKIPPED one (it carries the settled figures), then the later `occurredAt`
 * wins, and an exact timestamp tie is broken by the outcome string so the same
 * input always produces the same output.
 */
export function indexPaperEvidence(rows: PaperLedgerRow[]): Map<string, PaperEvidence> {
  const best = new Map<string, PaperLedgerRow>();
  for (const row of rows) {
    const current = best.get(row.lifecycleId);
    if (!current || preferLedgerRow(row, current)) best.set(row.lifecycleId, row);
  }

  const out = new Map<string, PaperEvidence>();
  for (const [lifecycleId, r] of best) {
    out.set(lifecycleId, {
      outcome: r.outcome,
      sizeUsdt: r.sizeUsdt,
      rejectionCode: r.rejectionCode,
      rejectionReason: r.rejectionReason,
      markPriceToman: r.markPriceToman,
      cashPnlIrtToman: r.cashPnlIrtToman,
      inventoryDeltaUsdt:
        r.inventoryDeltaUsdtMicros === null ? null : r.inventoryDeltaUsdtMicros / USDT_MICROS,
      sellFeeValueToman: r.sellFeeValueToman,
      economicNetPnlToman: r.economicNetPnlToman,
      riskAdjustedPnlToman: r.riskAdjustedPnlToman,
      buyFeeAsset: r.buyFeeAsset,
      buyFeeDebitMode: r.buyFeeDebitMode,
      buyFeeProvenance: r.buyFeeProvenance,
      sellFeeAsset: r.sellFeeAsset,
      sellFeeDebitMode: r.sellFeeDebitMode,
      sellFeeProvenance: r.sellFeeProvenance,
      occurredAt: r.occurredAt
    });
  }
  return out;
}

function preferLedgerRow(candidate: PaperLedgerRow, current: PaperLedgerRow): boolean {
  if (candidate.outcome !== current.outcome) return candidate.outcome === "FILLED";
  const a = Date.parse(candidate.occurredAt);
  const b = Date.parse(current.occurredAt);
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a > b;
  return candidate.occurredAt.localeCompare(current.occurredAt) > 0;
}

/**
 * Evidence for one opportunity, or null.
 *
 * The size must match: a lifecycle is a (route, size) pair, so a figure recorded
 * for a different size is not this row's figure and is never borrowed.
 */
export function evidenceFor(
  o: ShadowOpportunity,
  index: Map<string, PaperEvidence>
): PaperEvidence | null {
  const hit = index.get(o.id);
  if (!hit) return null;
  return hit.sizeUsdt === o.sizeUsdt ? hit : null;
}

/* ── filters ───────────────────────────────────────────────────────────────── */

export type OpportunitySortKey =
  | "riskAdjusted"
  | "economic"
  | "grossSpread"
  | "freshness"
  | "duration";

export const OPPORTUNITY_SORTS: Array<{ key: OpportunitySortKey; labelFa: string }> = [
  { key: "riskAdjusted", labelFa: "سود تعدیل‌شده با بافر" },
  { key: "economic", labelFa: "سود خالص اقتصادی" },
  { key: "grossSpread", labelFa: "اسپرد خام" },
  { key: "freshness", labelFa: "تازگی داده" },
  { key: "duration", labelFa: "مدت دوام" }
];

export type OpportunityFilters = {
  /** Free-text exchange search — matched against Persian names and ids. */
  query: string;
  /** "all" or a trade size in USDT as a string. */
  size: string;
  /** "all" or a source id appearing on either leg. */
  sourceId: string;
  /** Only routes both of whose venues are usable with the accounts we have. */
  currentAccountsOnly: boolean;
  /** Only routes with a known-fee, positive net result. */
  netPositiveOnly: boolean;
  /** Include lifecycles that have already ended. */
  includeCompleted: boolean;
  sort: OpportunitySortKey;
};

export const DEFAULT_OPPORTUNITY_FILTERS: OpportunityFilters = {
  query: "",
  size: "all",
  sourceId: "all",
  currentAccountsOnly: false,
  netPositiveOnly: false,
  includeCompleted: false,
  sort: "riskAdjusted"
};

export function activeFilterCount(f: OpportunityFilters): number {
  return (
    (f.query.trim() ? 1 : 0) +
    (f.size !== "all" ? 1 : 0) +
    (f.sourceId !== "all" ? 1 : 0) +
    (f.currentAccountsOnly ? 1 : 0) +
    (f.netPositiveOnly ? 1 : 0) +
    (f.includeCompleted ? 1 : 0)
  );
}

export function filterOpportunities(
  rows: ShadowOpportunity[],
  f: OpportunityFilters
): ShadowOpportunity[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter((o) => {
    if (!f.includeCompleted && !o.isActive) return false;
    if (f.size !== "all" && String(o.sizeUsdt) !== f.size) return false;
    if (f.sourceId !== "all" && o.buySourceId !== f.sourceId && o.sellSourceId !== f.sourceId) {
      return false;
    }
    if (f.currentAccountsOnly && o.eligibility !== "EXECUTABLE_NOW") return false;
    if (f.netPositiveOnly) {
      if (o.feeUnknown || o.netProfitToman <= 0 || o.eligibility === "BLOCKED") return false;
    }
    if (q) {
      const haystack =
        `${o.buySourceName} ${o.sellSourceName} ${o.buySourceId} ${o.sellSourceId}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

/* ── ordering ──────────────────────────────────────────────────────────────── */

/**
 * Rank a metric so that "unknown" is always last and the order is total.
 *
 * Rows whose metric the server never produced sort after every row that has
 * one, whichever direction the metric runs in — they are not treated as zero.
 */
function rank(value: number | null | undefined): { known: boolean; value: number } {
  return value === null || value === undefined || !Number.isFinite(value)
    ? { known: false, value: 0 }
    : { known: true, value };
}

function compareBy(
  a: number | null,
  b: number | null,
  direction: "desc" | "asc"
): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra.known !== rb.known) return ra.known ? -1 : 1;
  if (!ra.known) return 0;
  return direction === "desc" ? rb.value - ra.value : ra.value - rb.value;
}

/**
 * Deterministic ordering.
 *
 * Every comparison ends with the lifecycle id, so two rows that tie on the
 * chosen metric always come out in the same order — the same input list always
 * renders identically, which is what makes a screenshot reviewable.
 */
export function sortOpportunities(
  rows: ShadowOpportunity[],
  sort: OpportunitySortKey,
  index: Map<string, PaperEvidence>
): ShadowOpportunity[] {
  const metric = (o: ShadowOpportunity): { value: number | null; direction: "desc" | "asc" } => {
    const ev = evidenceFor(o, index);
    switch (sort) {
      case "riskAdjusted":
        return { value: ev?.riskAdjustedPnlToman ?? null, direction: "desc" };
      case "economic":
        return { value: ev?.economicNetPnlToman ?? null, direction: "desc" };
      case "grossSpread":
        return { value: o.rawSpreadPercent, direction: "desc" };
      case "freshness":
        return { value: Math.max(o.buyAgeMs, o.sellAgeMs), direction: "asc" };
      case "duration":
        return { value: o.durationMs, direction: "desc" };
    }
  };

  return [...rows].sort((a, b) => {
    const ma = metric(a);
    const mb = metric(b);
    const primary = compareBy(ma.value, mb.value, ma.direction);
    if (primary !== 0) return primary;
    // Same metric: a bigger raw spread first, then the id, so ties never shuffle.
    if (a.rawSpreadPercent !== b.rawSpreadPercent) return b.rawSpreadPercent - a.rawSpreadPercent;
    return a.id.localeCompare(b.id);
  });
}

/* ── grouping ──────────────────────────────────────────────────────────────── */

export type OpportunityGroups = Record<OppClass, ShadowOpportunity[]>;

/** Split into the three categories the tab presents, preserving input order. */
export function groupOpportunities(rows: ShadowOpportunity[]): OpportunityGroups {
  const groups: OpportunityGroups = { valid: [], raw: [], blocked: [] };
  for (const o of rows) groups[classifyOpportunity(o)].push(o);
  return groups;
}

export type OpportunitySummary = {
  valid: number;
  raw: number;
  blocked: number;
  shown: number;
  /** Highest net profit among valid rows, or null when there is none. */
  bestValidNetToman: number | null;
  bestValid: ShadowOpportunity | null;
};

export function summarizeOpportunities(groups: OpportunityGroups): OpportunitySummary {
  const bestValid = groups.valid.reduce<ShadowOpportunity | null>(
    (best, o) => (!best || o.netProfitToman > best.netProfitToman ? o : best),
    null
  );
  return {
    valid: groups.valid.length,
    raw: groups.raw.length,
    blocked: groups.blocked.length,
    shown: groups.valid.length + groups.raw.length + groups.blocked.length,
    bestValidNetToman: bestValid ? bestValid.netProfitToman : null,
    bestValid
  };
}

/* ── blocking reasons ──────────────────────────────────────────────────────── */

/**
 * The reason to lead with.
 *
 * Order matters: the first reason in the recorded list is the one the engine
 * hit first, so it is the one an admin should act on. Nothing is re-ranked or
 * summarised away — the full list is always available beside it.
 */
export function primaryBlockingReason(o: ShadowOpportunity): string | null {
  return o.blockedReasons[0] ?? null;
}
