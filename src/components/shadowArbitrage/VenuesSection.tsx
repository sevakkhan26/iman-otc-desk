"use client";

/**
 * «وضعیت صرافی‌ها» — health, fees, visible received order-book Bid/Ask volume.
 *
 * v4.2.4: volume = all valid received levels (not slippage-bounded).
 * Never displays usableCapacity / capital / policy caps as book volume.
 * Engine sizing depth is unchanged.
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

const HEALTH_FA: Record<string, string> = {
  healthy: "سالم",
  ok: "سالم",
  fresh: "سالم",
  degraded: "مختل",
  unhealthy: "ناسالم",
  unknown: "نامشخص"
};

const NA_FA = "ناموجود";

function healthFa(status: string): string {
  return HEALTH_FA[status] ?? status;
}

function fmtAgeFa(ageMs: number | null | undefined): string | null {
  if (ageMs === null || ageMs === undefined || !Number.isFinite(ageMs)) return null;
  const sec = Math.max(0, Math.round(ageMs / 1000));
  return `${toFaDigits(sec)} ثانیه`;
}

/** Visible book volume — never capacity/balance fallback. */
function VisibleVolumeValue({
  usdt,
  toman,
  levels,
  unavailable,
  reasonFa
}: {
  usdt: number | null | undefined;
  toman: number | null | undefined;
  levels: number | null | undefined;
  unavailable?: boolean;
  reasonFa?: string | null;
}) {
  if (
    unavailable ||
    usdt === null ||
    usdt === undefined ||
    !Number.isFinite(usdt)
  ) {
    return (
      <span className="sa-unknown" title={reasonFa ?? undefined}>
        {reasonFa && reasonFa.includes("چندسطحی") ? reasonFa : NA_FA}
        {reasonFa && !reasonFa.includes("چندسطحی") ? (
          <span className="sa-sub"> — {reasonFa}</span>
        ) : null}
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
      {levels !== null && levels !== undefined ? (
        <span className="sa-sub">
          {" · "}
          <Bidi>{toFaDigits(levels)}</Bidi> سطح
        </span>
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
  venueSemantics = null,
  venueDepthCards = null
}: Props) {
  const healthBy = new Map((health ?? []).map((h) => [h.sourceId, h]));
  const feeBy = new Map(feeEvidence.map((f) => [f.sourceId, f]));
  const venueBy = new Map(venues.map((v) => [v.sourceId, v]));
  const depthBy = new Map((venueDepthCards ?? []).map((d) => [d.sourceId, d]));
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
          <div className="sa-panel-note">
            حجم قابل‌مشاهده در دفتر سفارش دریافتی · نه عمق لغزش‌محدود · نه ظرفیت اجرایی
          </div>
        </div>
        <div className="panel-body sa-venue-grid sa-venue-grid-compact">
          {orderedIds.map((id) => {
            const h = healthBy.get(id);
            const fee = feeBy.get(id);
            const v = venueBy.get(id);
            const depth = depthBy.get(id);
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

            const buyFee = fee?.takerFeeBps ?? v?.takerFeeBps ?? null;
            const sellFee = fee?.takerFeeBps ?? v?.takerFeeBps ?? null;
            const feeMissingFa =
              fee?.blockerFa ?? fee?.miss ?? "شواهد کارمزد در این چرخه ثبت نشده";

            // buy side of card = Ask volume; sell side = Bid volume.
            const ask = depth?.buy;
            const bid = depth?.sell;
            const missingDepthFa = depth
              ? null
              : "حجم دفتر این صرافی در این چرخه ارسال نشده";
            const ageLabel = fmtAgeFa(depth?.snapshotAgeMs ?? sn?.ageMs ?? null);
            const nameFa = sem?.nameFa ?? v?.nameFa ?? id;

            return (
              <article key={id} className="sa-venue-card sa-venue-card-compact glass-control">
                <header className="sa-venue-card-head">
                  <div>
                    <strong>{nameFa}</strong>
                    {ageLabel ? (
                      <span className="sa-sub sa-ps-key">سن اسنپ‌شات: {ageLabel}</span>
                    ) : null}
                  </div>
                  <span className={`sa-chip sa-chip-sm sa-chip-${tone}`}>
                    {healthFa(status)}
                  </span>
                </header>
                <dl className="sa-venue-card-grid sa-venue-card-grid-minimal">
                  <div>
                    <dt>سلامت</dt>
                    <dd>
                      <span className={`sa-chip sa-chip-sm sa-chip-${tone}`}>
                        {healthFa(status)}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>کارمزد خرید (taker)</dt>
                    <dd className="sa-sub">
                      {buyFee !== null && buyFee !== undefined ? (
                        <Bidi>{toFaDigits(buyFee)} bps</Bidi>
                      ) : (
                        <span className="sa-unknown">{feeMissingFa}</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>کارمزد فروش (taker)</dt>
                    <dd className="sa-sub">
                      {sellFee !== null && sellFee !== undefined ? (
                        <Bidi>{toFaDigits(sellFee)} bps</Bidi>
                      ) : (
                        <span className="sa-unknown">{feeMissingFa}</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>حجم خرید (Bid) — قابل‌مشاهده</dt>
                    <dd>
                      <VisibleVolumeValue
                        usdt={bid?.rawDepthUsdt}
                        toman={bid?.rawDepthToman}
                        levels={bid?.levelsAccepted}
                        unavailable={bid?.unavailable || !depth}
                        reasonFa={bid?.unavailableFa ?? missingDepthFa}
                      />
                    </dd>
                  </div>
                  <div>
                    <dt>حجم فروش (Ask) — قابل‌مشاهده</dt>
                    <dd>
                      <VisibleVolumeValue
                        usdt={ask?.rawDepthUsdt}
                        toman={ask?.rawDepthToman}
                        levels={ask?.levelsAccepted}
                        unavailable={ask?.unavailable || !depth}
                        reasonFa={ask?.unavailableFa ?? missingDepthFa}
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
