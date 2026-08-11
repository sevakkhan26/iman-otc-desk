"use client";

/**
 * «وضعیت صرافی‌ها» — compact: health, buy/sell taker fees, usable depth only.
 *
 * v4.2.1: no price ladder, capacity diagnostics, or verbose depth blocks.
 * Fees appear only here. Depth uses real slippage-bounded accepted values;
 * never fabricated.
 */
import { TomanAmount } from "@/components/TomanAmount";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { toFaDigits } from "@/components/shadowArbitrage/labels";
import type {
  FeeConfirmationAudit,
  VenueFeeEvidence,
  VenueReadiness
} from "@/components/shadowArbitrage/sourcesModel";
import type { VenueDepthCardView } from "@/components/shadowArbitrage/AccountsSection";
import type { RouteSizingView } from "@/components/shadowArbitrage/CommandCenter";
import type { NormalizedSourceSnapshot } from "@/lib/shadowArbitrage/types";

type VenueCapacity = {
  sourceId: string;
  nameFa?: string;
  marketModel?: string;
  buy?: {
    capacityUsdtMicros: number | null;
    limitingCap?: string | null;
    reasonFa?: string | null;
  };
  sell?: {
    capacityUsdtMicros: number | null;
    limitingCap?: string | null;
    reasonFa?: string | null;
  };
};

type VenueSemanticsRow = {
  sourceId: string;
  nameFa?: string;
  dataType?: string;
  kycComplete?: boolean;
  accountEligible?: boolean;
  feeConfirmed?: boolean;
  buyLegUsable?: boolean;
  sellLegUsable?: boolean;
  participates?: boolean;
  blockerFa?: string | null;
  buyCapacityUsdtMicros?: number | null;
  sellCapacityUsdtMicros?: number | null;
  buyLimiter?: string | null;
  sellLimiter?: string | null;
};

type Props = {
  certifications?: unknown[];
  health: ObservationPayloadLike["sourceHealth"];
  snapshots: NormalizedSourceSnapshot[];
  venues: VenueReadiness[];
  feeEvidence: VenueFeeEvidence[];
  auditHistory?: FeeConfirmationAudit[];
  feeReverifyDays?: number | null;
  pollIntervalMs?: number;
  loading: boolean;
  error?: string | null;
  onReload?: () => void;
  venueCapacities?: VenueCapacity[];
  venueSemantics?: VenueSemanticsRow[] | null;
  routes?: RouteSizingView[];
  serverNow?: string | null;
  /** Preferred source for slippage-bounded usable depth. */
  venueDepthCards?: VenueDepthCardView[] | null;
};

type ObservationPayloadLike = {
  certifications?: unknown[];
  sourceHealth?: Array<{
    sourceId: string;
    status?: string;
    lastSuccessAt?: string | null;
    consecutiveFailures?: number;
    latencyMs?: number | null;
    errorReason?: string | null;
    degradedReason?: string | null;
  }>;
};

const UNAVAILABLE = "Unavailable";

function DepthValue({
  usdt,
  toman,
  reasonFa
}: {
  usdt: number | null | undefined;
  toman: number | null | undefined;
  reasonFa?: string | null;
}) {
  if (usdt === null || usdt === undefined || !Number.isFinite(usdt)) {
    return (
      <span className="sa-unknown" title={reasonFa ?? "عمق لغزش‌محدود در این چرخه موجود نیست"}>
        {UNAVAILABLE}
        {reasonFa ? ` — ${reasonFa}` : ""}
      </span>
    );
  }
  return (
    <span>
      <Bidi>{toFaDigits(usdt.toFixed(4))}</Bidi> USDT
      {toman !== null && toman !== undefined && Number.isFinite(toman) ? (
        <>
          {" · "}
          <TomanAmount value={toman} />
        </>
      ) : null}
    </span>
  );
}

export function VenuesSection({
  health,
  snapshots,
  venues,
  feeEvidence,
  loading,
  venueCapacities = [],
  venueSemantics = null,
  venueDepthCards = null
}: Props) {
  const healthBy = new Map((health ?? []).map((h) => [h.sourceId, h]));
  const feeBy = new Map(feeEvidence.map((f) => [f.sourceId, f]));
  const venueBy = new Map(venues.map((v) => [v.sourceId, v]));
  const depthBy = new Map((venueDepthCards ?? []).map((d) => [d.sourceId, d]));
  const capBy = new Map(venueCapacities.map((c) => [c.sourceId, c]));
  const semBy = new Map((venueSemantics ?? []).map((s) => [s.sourceId, s]));
  const snapBy = new Map(snapshots.map((s) => [s.sourceId, s]));

  const orderedIds =
    venues.length > 0
      ? venues.map((v) => v.sourceId)
      : snapshots.map((s) => s.sourceId as string);

  return (
    <div className="sa-stack">
      <section className="panel sa-panel" aria-label="وضعیت صرافی‌ها">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title">وضعیت صرافی‌ها</h3>
        </div>
        <div className="panel-body sa-venue-grid sa-venue-grid-compact">
          {orderedIds.map((id) => {
            const h = healthBy.get(id);
            const fee = feeBy.get(id);
            const v = venueBy.get(id);
            const depth = depthBy.get(id);
            const cap = capBy.get(id);
            const sem = semBy.get(id);
            const sn = snapBy.get(id as never);

            const status =
              h?.status ??
              (sn?.stale ? "degraded" : sn?.errorReason ? "unhealthy" : sn ? "healthy" : "unknown");
            const tone =
              status === "healthy" || status === "ok" || status === "fresh"
                ? "good"
                : status === "degraded" || sn?.stale
                  ? "warn"
                  : status === "unknown"
                    ? "muted"
                    : "danger";

            const buyFee =
              fee?.takerFeeBps ?? v?.takerFeeBps ?? null;
            const sellFee =
              fee?.takerFeeBps ?? v?.takerFeeBps ?? null;

            // Prefer real slippage-bounded accepted depth from venue depth cards.
            let buyDepthUsdt: number | null = depth?.buy?.usableCapacityUsdt ?? null;
            let buyDepthToman: number | null = depth?.buy?.usableCapacityToman ?? null;
            let buyReason = depth?.buy?.unavailableFa ?? depth?.buy?.reasonFa ?? null;
            let sellDepthUsdt: number | null = depth?.sell?.usableCapacityUsdt ?? null;
            let sellDepthToman: number | null = depth?.sell?.usableCapacityToman ?? null;
            let sellReason = depth?.sell?.unavailableFa ?? depth?.sell?.reasonFa ?? null;

            // Fall back to capacity micros only when depth card side is unavailable.
            if (buyDepthUsdt === null || buyDepthUsdt === undefined) {
              const micros =
                cap?.buy?.capacityUsdtMicros ?? sem?.buyCapacityUsdtMicros ?? null;
              if (micros !== null && micros !== undefined) {
                buyDepthUsdt = micros / 1_000_000;
                buyDepthToman = null;
                buyReason = cap?.buy?.reasonFa ?? null;
              } else if (depth?.buy?.unavailable) {
                buyReason = depth.buy.unavailableFa ?? buyReason;
              }
            }
            if (sellDepthUsdt === null || sellDepthUsdt === undefined) {
              const micros =
                cap?.sell?.capacityUsdtMicros ?? sem?.sellCapacityUsdtMicros ?? null;
              if (micros !== null && micros !== undefined) {
                sellDepthUsdt = micros / 1_000_000;
                sellDepthToman = null;
                sellReason = cap?.sell?.reasonFa ?? null;
              } else if (depth?.sell?.unavailable) {
                sellReason = depth.sell.unavailableFa ?? sellReason;
              }
            }

            return (
              <article key={id} className="sa-venue-card sa-venue-card-compact glass-control">
                <header className="sa-venue-card-head">
                  <div>
                    <strong>{sem?.nameFa ?? v?.nameFa ?? id}</strong>
                    <span className="sa-ps-key">{id}</span>
                  </div>
                  <span className={`sa-chip sa-chip-sm sa-chip-${tone}`}>{status}</span>
                </header>
                <dl className="sa-venue-card-grid sa-venue-card-grid-minimal">
                  <div>
                    <dt>سلامت</dt>
                    <dd>
                      <span className={`sa-chip sa-chip-sm sa-chip-${tone}`}>{status}</span>
                    </dd>
                  </div>
                  <div>
                    <dt>کارمزد خرید / taker</dt>
                    <dd className="sa-sub">
                      {buyFee !== null && buyFee !== undefined ? (
                        <Bidi>{toFaDigits(buyFee)} bps</Bidi>
                      ) : (
                        <span
                          className="sa-unknown"
                          title={fee?.blockerFa ?? fee?.miss ?? "شواهد کارمزد موجود نیست"}
                        >
                          {UNAVAILABLE}
                        </span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>کارمزد فروش / taker</dt>
                    <dd className="sa-sub">
                      {sellFee !== null && sellFee !== undefined ? (
                        <Bidi>{toFaDigits(sellFee)} bps</Bidi>
                      ) : (
                        <span
                          className="sa-unknown"
                          title={fee?.blockerFa ?? fee?.miss ?? "شواهد کارمزد موجود نیست"}
                        >
                          {UNAVAILABLE}
                        </span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>عمق قابل‌استفاده خریدار</dt>
                    <dd>
                      <DepthValue
                        usdt={buyDepthUsdt}
                        toman={buyDepthToman}
                        reasonFa={buyReason}
                      />
                    </dd>
                  </div>
                  <div>
                    <dt>عمق قابل‌استفاده فروشنده</dt>
                    <dd>
                      <DepthValue
                        usdt={sellDepthUsdt}
                        toman={sellDepthToman}
                        reasonFa={sellReason}
                      />
                    </dd>
                  </div>
                </dl>
              </article>
            );
          })}
          {!orderedIds.length ? (
            <p className="sa-sub">{loading ? "در حال خواندن…" : "منبعی نیست."}</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
