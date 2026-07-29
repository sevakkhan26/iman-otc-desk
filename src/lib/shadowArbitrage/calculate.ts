import { createHash } from "node:crypto";
import { SHADOW_STALE_MS, SHADOW_TRADE_SIZES } from "@/lib/shadowArbitrage/config";
import { computeRouteEconomics } from "@/lib/shadowArbitrage/fees";
import { isCertifiedExecutable, type CertificationStatus } from "@/lib/shadowArbitrage/certification";
import type {
  BlockedReasonCode,
  NormalizedSourceSnapshot,
  OpportunityEligibility,
  ShadowOpportunity,
  ShadowSourceId,
  ShadowTradeSizeUsdt
} from "@/lib/shadowArbitrage/types";
import { mergeWithTransitions, type LifecycleTransition } from "@/lib/shadowArbitrage/lifecycle";

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

export function routeKeyFor(buy: string, sell: string, size: ShadowTradeSizeUsdt): string {
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

function baseEligibility(
  buy: NormalizedSourceSnapshot,
  sell: NormalizedSourceSnapshot
): { eligibility: OpportunityEligibility; reasons: BlockedReasonCode[] } {
  const reasons: BlockedReasonCode[] = [];
  const referenceOnly =
    buy.eligibilityBase === "REFERENCE_ONLY" || sell.eligibilityBase === "REFERENCE_ONLY";
  const accountMissing = buy.accountStatus !== "verified" || sell.accountStatus !== "verified";

  if (referenceOnly) reasons.push("reference_only");
  if (accountMissing) reasons.push("account_required");

  if (referenceOnly) return { eligibility: "REFERENCE_ONLY", reasons };
  if (accountMissing) return { eligibility: "ACCOUNT_REQUIRED", reasons };
  return { eligibility: "EXECUTABLE_NOW", reasons };
}

export type BuildOptions = {
  /** Certification status per source; anything below LIVE_VERIFIED blocks execution claims. */
  certStatuses?: Partial<Record<ShadowSourceId, CertificationStatus>>;
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

/**
 * An opportunity is "material" (worth its own lifecycle row) when the venues
 * actually cross — i.e. selling proceeds exceed the buy price before costs.
 * Everything else is still counted in aggregates, but does not create rows.
 */
function isMaterial(o: ShadowOpportunity): boolean {
  return o.rawSpreadPercent > 0;
}

export function buildOpportunitiesDetailed(
  sources: NormalizedSourceSnapshot[],
  previous: ShadowOpportunity[],
  nowIso: string,
  options: BuildOptions = {}
): BuildResult {
  const drafts: ShadowOpportunity[] = [];
  const blockedCounts: Record<string, number> = {};
  let skippedPairs = 0;

  const bump = (reasons: Iterable<BlockedReasonCode>) => {
    for (const r of reasons) blockedCounts[r] = (blockedCounts[r] ?? 0) + 1;
  };

  for (const buy of sources) {
    for (const sell of sources) {
      if (buy.sourceId === sell.sourceId) continue;

      for (const size of SHADOW_TRADE_SIZES) {
        const buyEx = buy.sizeExecutables.find((x) => x.sizeUsdt === size);
        const sellEx = sell.sizeExecutables.find((x) => x.sizeUsdt === size);
        const reasons = new Set<BlockedReasonCode>();

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

        const buyVwap = buyEx?.userBuyVwapToman ?? null;
        const sellVwap = sellEx?.userSellVwapToman ?? null;
        if (buyVwap === null || !buyEx?.buyFillable) reasons.add("insufficient_buy_depth");
        if (sellVwap === null || !sellEx?.sellFillable) reasons.add("insufficient_sell_depth");

        if (buyVwap === null || sellVwap === null) {
          // No executable price for this size — nothing to price, count and move on.
          reasons.add("market_data_missing");
          bump(reasons);
          skippedPairs += 1;
          continue;
        }

        const econ = computeRouteEconomics({
          buySourceId: buy.sourceId,
          sellSourceId: sell.sourceId,
          sizeUsdt: size,
          buyVwapToman: buyVwap,
          sellVwapToman: sellVwap
        });
        for (const r of econ.blocked) reasons.add(r);

        const { eligibility: baseEl, reasons: elReasons } = baseEligibility(buy, sell);
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

        const rk = routeKeyFor(buy.sourceId, sell.sourceId, size);
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
  }

  const material = drafts.filter(isMaterial);
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
