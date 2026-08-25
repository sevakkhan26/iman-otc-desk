import { createHash } from "node:crypto";
import { SHADOW_STALE_MS } from "@/lib/shadowArbitrage/config";
import { computeRouteEconomics } from "@/lib/shadowArbitrage/fees";
import { isCertifiedExecutable, type CertificationStatus } from "@/lib/shadowArbitrage/certification";
import type {
  BlockedReasonCode,
  NormalizedSourceSnapshot,
  OpportunityEligibility,
  ShadowOpportunity,
  ShadowSourceId
} from "@/lib/shadowArbitrage/types";
import { mergeWithTransitions, type LifecycleTransition } from "@/lib/shadowArbitrage/lifecycle";
import { walkBook } from "@/lib/shadowArbitrage/paper/liquidity";
import { slippageBoundedDepth } from "@/lib/shadowArbitrage/paper/smartCandidates";
import { PAPER_POLICY_MIN_USDT_MICROS } from "@/lib/shadowArbitrage/paper/venueExecutionLimits";

/** Reasons that make an "executable now" claim impossible (spec §7). */
const DISQUALIFYING: BlockedReasonCode[] = [
  "fee_unknown",
  "insufficient_buy_depth",
  "insufficient_sell_depth",
  "depth_unverified",
  "quote_max_unverified",
  "quote_direction_unverified",
  "units_ambiguous",
  "rate_limited",
  "source_unhealthy",
  "source_not_certified",
  "stale_buy_source",
  "stale_sell_source",
  "market_data_missing"
];

export function routeKeyFor(buy: string, sell: string): string {
  return `${buy}->${sell}`;
}

/** Read-only compatibility key for historical size-qualified rows. */
export function legacyRouteKeyFor(buy: string, sell: string, size: number): string {
  return `${buy}->${sell}@${size}`;
}

/**
 * Lifecycle identity is the route alone (plus the moment it opened), so the
 * same persistent opportunity keeps one id across cycles instead of becoming a
 * new row every 30 seconds.
 */
function opportunityId(route: string, firstSeenAt: string): string {
  return createHash("sha256").update(`${route}|${firstSeenAt}`).digest("hex").slice(0, 24);
}

/**
 * Whether this venue's account may back an execution.
 *
 * Persisted admin evidence WINS. The compiled-in `accountStatus` is a default
 * for a venue nobody has confirmed anything about yet — it is not a second
 * opinion that outranks a recorded confirmation. Four venues still carry
 * `unverified` in config while the admin's own KYC evidence says otherwise, and
 * while config decided this, every route touching them was blocked as
 * `account_required` no matter what the evidence said.
 *
 * The fallback direction is deliberate: absence of evidence keeps the
 * conservative default, it does not invent an approval.
 */
function accountVerified(
  snapshot: NormalizedSourceSnapshot,
  evidence: BuildOptions["accountEvidence"]
): boolean {
  const confirmed = evidence?.[snapshot.sourceId];
  if (confirmed) return confirmed.executionEligible;
  return snapshot.accountStatus === "verified";
}

function baseEligibility(
  buy: NormalizedSourceSnapshot,
  sell: NormalizedSourceSnapshot,
  evidence: BuildOptions["accountEvidence"]
): { eligibility: OpportunityEligibility; reasons: BlockedReasonCode[] } {
  const reasons: BlockedReasonCode[] = [];
  const referenceOnly =
    buy.eligibilityBase === "REFERENCE_ONLY" || sell.eligibilityBase === "REFERENCE_ONLY";
  const accountMissing = !accountVerified(buy, evidence) || !accountVerified(sell, evidence);

  if (referenceOnly) reasons.push("reference_only");
  if (accountMissing) reasons.push("account_required");

  if (referenceOnly) return { eligibility: "REFERENCE_ONLY", reasons };
  if (accountMissing) return { eligibility: "ACCOUNT_REQUIRED", reasons };
  return { eligibility: "EXECUTABLE_NOW", reasons };
}

export type BuildOptions = {
  /** Certification status per source; anything below LIVE_VERIFIED blocks execution claims. */
  certStatuses?: Partial<Record<ShadowSourceId, CertificationStatus>>;
  /**
   * Admin-confirmed taker fees per venue, in basis points. Without these a venue
   * whose fee was confirmed from its own panel would still read as fee-unknown,
   * because the compiled-in config only carries provisional values.
   */
  confirmedFeeBps?: Partial<Record<ShadowSourceId, number | null>>;
  /**
   * Persisted admin account evidence per venue — the authoritative answer to
   * "may this account back an execution?". Supplied by the collector from the
   * same readiness layer every other surface reads, so the opportunity table
   * and the readiness panel cannot disagree about a venue.
   */
  accountEvidence?: Partial<
    Record<ShadowSourceId, { executionEligible: boolean; kycComplete: boolean }>
  >;
  /** Confirmed fee-tier discontinuity may justify scanning a non-crossed TOB. */
  confirmedFeeTierJumpRoutes?: ReadonlySet<string>;
};

export type BuildResult = {
  /** Every merged lifecycle (active and just-ended) worth persisting. */
  opportunities: ShadowOpportunity[];
  /** Open / eligibility-change / close records for this cycle. */
  transitions: LifecycleTransition[];
  /** All drafts this cycle, including immaterial ones — aggregates only. */
  drafts: ShadowOpportunity[];
  /** Blocked-reason tally across every evaluated pair this cycle. */
  blockedCounts: Record<string, number>;
  /** Pairs skipped before economics because a price was missing. */
  skippedPairs: number;
};

export function buildOpportunitiesDetailed(
  sources: NormalizedSourceSnapshot[],
  previous: ShadowOpportunity[],
  nowIso: string,
  options: BuildOptions = {}
): BuildResult {
  const drafts: ShadowOpportunity[] = [];
  const materialRouteKeys = new Set<string>();
  const blockedCounts: Record<string, number> = {};
  let skippedPairs = 0;

  const bump = (reasons: Iterable<BlockedReasonCode>) => {
    for (const r of reasons) blockedCounts[r] = (blockedCounts[r] ?? 0) + 1;
  };

  for (const buy of sources) {
    for (const sell of sources) {
      if (buy.sourceId === sell.sourceId) continue;

      const reasons = new Set<BlockedReasonCode>();
      const rk = routeKeyFor(buy.sourceId, sell.sourceId);

      // Source-level findings (depth, direction, units, rate limit, health).
      // Snapshots rehydrated from stored payloads may predate these fields.
      for (const r of buy.sourceBlockedReasons ?? []) reasons.add(r);
      for (const r of sell.sourceBlockedReasons ?? []) reasons.add(r);

      if (buy.health === "unavailable" || sell.health === "unavailable") {
        reasons.add("source_unhealthy");
      }
      if (buy.ageMs > SHADOW_STALE_MS || buy.stale) reasons.add("stale_buy_source");
      if (sell.ageMs > SHADOW_STALE_MS || sell.stale) reasons.add("stale_sell_source");

        // Certification gate — an uncertified venue cannot back execution.
      const buyCert = options.certStatuses?.[buy.sourceId];
      const sellCert = options.certStatuses?.[sell.sourceId];
      if (
        (buyCert && !isCertifiedExecutable(buyCert)) ||
        (sellCert && !isCertifiedExecutable(sellCert))
      ) {
        reasons.add("source_not_certified");
      }

      const bestBuy =
        buy.bookAsks?.filter((l) => l.priceToman > 0 && l.amountUsdt > 0)
          .reduce<number | null>((p, l) => (p === null ? l.priceToman : Math.min(p, l.priceToman)), null) ??
        buy.userBuyPriceToman;
      const bestSell =
        sell.bookBids?.filter((l) => l.priceToman > 0 && l.amountUsdt > 0)
          .reduce<number | null>((p, l) => (p === null ? l.priceToman : Math.max(p, l.priceToman)), null) ??
        sell.userSellPriceToman;

      if (bestBuy === null || bestSell === null) {
        reasons.add("market_data_missing");
        skippedPairs += 1;
      }

      // Size-free existence gate: raw TOB cross or confirmed fee-tier jump.
      const rawTobCross = bestBuy !== null && bestSell !== null && bestSell > bestBuy;
      const feeTierJump = options.confirmedFeeTierJumpRoutes?.has(rk) ?? false;
      if (rawTobCross || feeTierJump) materialRouteKeys.add(rk);

      const buyAccepted = buy.bookAsks
        ? slippageBoundedDepth(buy.bookAsks, "buy", 10).depthMicros
        : 0;
      const sellAccepted = sell.bookBids
        ? slippageBoundedDepth(sell.bookBids, "sell", 10).depthMicros
        : 0;
      const depthCeiling = Math.min(buyAccepted, sellAccepted);
      const rawVertices = new Set<number>([PAPER_POLICY_MIN_USDT_MICROS, depthCeiling]);
      let cumulative = 0;
      for (const level of [...(buy.bookAsks ?? [])].sort((a, b) => a.priceToman - b.priceToman)) {
        cumulative += Math.round(level.amountUsdt * 1_000_000);
        if (cumulative <= depthCeiling) rawVertices.add(cumulative);
      }
      cumulative = 0;
      for (const level of [...(sell.bookBids ?? [])].sort((a, b) => b.priceToman - a.priceToman)) {
        cumulative += Math.round(level.amountUsdt * 1_000_000);
        if (cumulative <= depthCeiling) rawVertices.add(cumulative);
      }

      const priced = [...rawVertices]
        .filter((q) => q >= PAPER_POLICY_MIN_USDT_MICROS && q <= depthCeiling)
        .sort((a, b) => a - b)
        .map((q) => {
          const bw = walkBook(buy.bookAsks ?? [], q, "buy");
          const sw = walkBook(sell.bookBids ?? [], q, "sell");
          if (!bw.complete || !sw.complete || bw.vwapToman === null || sw.vwapToman === null) return null;
          return {
            q,
            bw,
            sw,
            econ: computeRouteEconomics({
              buySourceId: buy.sourceId,
              sellSourceId: sell.sourceId,
              sizeUsdt: q / 1_000_000,
              buyVwapToman: bw.vwapToman,
              sellVwapToman: sw.vwapToman,
              buyNotionalToman: bw.notionalToman,
              sellNotionalToman: sw.notionalToman,
              confirmedFeeBps: options.confirmedFeeBps
            })
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      const bestPriced = [...priced].sort(
        (a, b) => b.econ.netProfitToman - a.econ.netProfitToman || a.q - b.q
      )[0] ?? null;
      const size = (bestPriced?.q ?? PAPER_POLICY_MIN_USDT_MICROS) / 1_000_000;
      const buyVwap = bestPriced?.bw.vwapToman ?? bestBuy ?? 0;
      const sellVwap = bestPriced?.sw.vwapToman ?? bestSell ?? 0;
      if (!bestPriced) {
        reasons.add("insufficient_buy_depth");
        reasons.add("insufficient_sell_depth");
      }

      const econ =
        bestPriced?.econ ??
        computeRouteEconomics({
          buySourceId: buy.sourceId,
          sellSourceId: sell.sourceId,
          sizeUsdt: size,
          buyVwapToman: buyVwap,
          sellVwapToman: sellVwap,
          confirmedFeeBps: options.confirmedFeeBps
        });
      for (const r of econ.blocked) reasons.add(r);

      const { eligibility: baseEl, reasons: elReasons } = baseEligibility(
        buy,
        sell,
        options.accountEvidence
      );
      for (const r of elReasons) reasons.add(r);

      let eligibility: OpportunityEligibility = baseEl;
      if (DISQUALIFYING.some((r) => reasons.has(r))) {
        eligibility = "BLOCKED";
      } else if (reasons.has("reference_only")) {
        eligibility = "REFERENCE_ONLY";
      } else if (reasons.has("account_required")) {
        eligibility = "ACCOUNT_REQUIRED";
      } else if (reasons.has("non_positive_net")) {
        eligibility = "BLOCKED";
      }

      bump(reasons);

      drafts.push({
        id: opportunityId(rk, nowIso),
        routeKey: rk,
        buySourceId: buy.sourceId,
        sellSourceId: sell.sourceId,
        buySourceName: buy.sourceName,
        sellSourceName: sell.sourceName,
        sizeUsdt: size,
        buyVwapToman: buyVwap,
        sellVwapToman: sellVwap,
        rawSpreadPercent: econ.rawSpreadPercent,
        buyFeeToman: econ.buyFeeToman,
        sellFeeToman: econ.sellFeeToman,
        buyFeeBps: econ.buyFeeBps,
        sellFeeBps: econ.sellFeeBps,
        totalFeePercent: econ.totalFeePercent,
        slippageBufferToman: econ.slippageBufferToman,
        rebalanceCostToman: econ.rebalanceCostToman,
        netProfitToman: econ.netProfitToman,
        netEdgePercent: econ.netEdgePercent,
        buyCostToman: econ.buyCostToman,
        sellProceedsToman: econ.sellProceedsToman,
        eligibility,
        blockedReasons: [...reasons],
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        endedAt: null,
        durationMs: 0,
        maxNetEdgePercent: econ.netEdgePercent,
        maxNetProfitToman: econ.netProfitToman,
        maxRawSpreadPercent: econ.rawSpreadPercent,
        feeUnknown: econ.feeUnknown,
        observationCount: 1,
        isActive: true,
        buyAgeMs: buy.ageMs,
        sellAgeMs: sell.ageMs
      });
    }
  }

  const material = drafts.filter((o) => materialRouteKeys.has(o.routeKey));
  const { merged, transitions } = mergeWithTransitions(previous, material, nowIso);
  return {
    opportunities: merged,
    transitions,
    drafts,
    blockedCounts,
    skippedPairs
  };
}

/** Backwards-compatible wrapper used by tests and the read-only API path. */
export function buildOpportunities(
  sources: NormalizedSourceSnapshot[],
  previous: ShadowOpportunity[],
  nowIso: string,
  options: BuildOptions = {}
): ShadowOpportunity[] {
  return buildOpportunitiesDetailed(sources, previous, nowIso, options).opportunities;
}
