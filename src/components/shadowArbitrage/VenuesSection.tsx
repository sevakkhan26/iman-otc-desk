"use client";

/**
 * «وضعیت صرافی‌ها» — one card per venue: price, fees, capacity, health.
 */
import { TomanAmount } from "@/components/TomanAmount";
import { formatTehran } from "@/components/format";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { toFaDigits } from "@/components/shadowArbitrage/labels";
import { SourcesPanel } from "@/components/shadowArbitrage/SourcesPanel";
import type {
  FeeConfirmationAudit,
  VenueFeeEvidence,
  VenueReadiness
} from "@/components/shadowArbitrage/sourcesModel";
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
  certifications: ObservationPayloadLike["certifications"];
  health: ObservationPayloadLike["sourceHealth"];
  snapshots: NormalizedSourceSnapshot[];
  venues: VenueReadiness[];
  feeEvidence: VenueFeeEvidence[];
  auditHistory: FeeConfirmationAudit[];
  feeReverifyDays: number | null;
  pollIntervalMs: number;
  loading: boolean;
  error: string | null;
  onReload: () => void;
  venueCapacities: VenueCapacity[];
  venueSemantics: VenueSemanticsRow[] | null;
  routes: RouteSizingView[];
  serverNow: string | null;
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

const DASH = <span className="sa-unknown">—</span>;

function microsUsdt(m: number | null | undefined): string {
  if (m === null || m === undefined) return "—";
  return (m / 1_000_000).toFixed(4);
}

export function VenuesSection({
  certifications,
  health,
  snapshots,
  venues,
  feeEvidence,
  auditHistory,
  feeReverifyDays,
  pollIntervalMs,
  loading,
  error,
  onReload,
  venueCapacities,
  venueSemantics,
  routes,
  serverNow
}: Props) {
  const snapBy = new Map(snapshots.map((s) => [s.sourceId, s]));
  const healthBy = new Map((health ?? []).map((h) => [h.sourceId, h]));
  const feeBy = new Map(feeEvidence.map((f) => [f.sourceId, f]));
  const capBy = new Map(venueCapacities.map((c) => [c.sourceId, c]));
  const semBy = new Map((venueSemantics ?? []).map((s) => [s.sourceId, s]));
  const bestRouteByVenue = new Map<string, RouteSizingView>();
  for (const r of routes) {
    if (r.sizing.status !== "SIZED") continue;
    for (const sid of [r.buySourceId, r.sellSourceId]) {
      const prev = bestRouteByVenue.get(sid);
      if (!prev || (r.sizing.sizeUsdt ?? 0) > (prev.sizing.sizeUsdt ?? 0)) {
        bestRouteByVenue.set(sid, r);
      }
    }
  }

  const orderedIds =
    venues.length > 0
      ? venues.map((v) => v.sourceId)
      : snapshots.map((s) => s.sourceId as string);

  return (
    <div className="sa-stack">
      <section className="panel sa-panel" aria-label="کارت‌های صرافی">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title">وضعیت صرافی‌ها</h3>
          <div className="sa-panel-note">
            نه صرافی Shadow · OMPFinex خارج است ·{" "}
            {serverNow ? formatTehran(serverNow) : DASH}
          </div>
        </div>
        <div className="panel-body sa-venue-grid">
          {orderedIds.map((id) => {
            const sn = snapBy.get(id as never);
            const h = healthBy.get(id);
            const fee = feeBy.get(id);
            const cap = capBy.get(id);
            const sem = semBy.get(id);
            const best = bestRouteByVenue.get(id);
            const ask = sn?.userBuyPriceToman ?? null;
            const bid = sn?.userSellPriceToman ?? null;
            const spread =
              ask !== null && bid !== null && Number.isFinite(ask) && Number.isFinite(bid)
                ? Math.round(ask - bid)
                : null;
            const status =
              h?.status ??
              (sn?.stale ? "degraded" : sn?.errorReason ? "unhealthy" : "healthy");
            const tone =
              status === "healthy" || status === "ok" || status === "fresh"
                ? "good"
                : status === "degraded" || sn?.stale
                  ? "warn"
                  : "danger";

            return (
              <article key={id} className="sa-venue-card glass-control">
                <header className="sa-venue-card-head">
                  <div>
                    <strong>{sem?.nameFa ?? id}</strong>
                    <span className="sa-ps-key">{id}</span>
                  </div>
                  <span className={`sa-chip sa-chip-sm sa-chip-${tone}`}>{status}</span>
                </header>
                <dl className="sa-venue-card-grid">
                  <div>
                    <dt>خرید (ask)</dt>
                    <dd>{ask !== null ? <TomanAmount value={Number(ask)} /> : DASH}</dd>
                  </div>
                  <div>
                    <dt>فروش (bid)</dt>
                    <dd>{bid !== null ? <TomanAmount value={Number(bid)} /> : DASH}</dd>
                  </div>
                  <div>
                    <dt>اسپرد</dt>
                    <dd>
                      {spread !== null ? <TomanAmount value={spread} /> : DASH}
                    </dd>
                  </div>
                  <div>
                    <dt>نوع داده</dt>
                    <dd className="sa-sub">
                      {sem?.dataType ?? cap?.marketModel ?? sn?.marketModel ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>سن اسنپ‌شات</dt>
                    <dd className="sa-sub">
                      {sn?.ageMs !== undefined && sn?.ageMs !== null ? (
                        <Bidi>{toFaDigits(Math.round(sn.ageMs / 1000))} ثانیه</Bidi>
                      ) : (
                        DASH
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>تأخیر / خطاهای پیاپی</dt>
                    <dd className="sa-sub">
                      {h?.latencyMs !== null && h?.latencyMs !== undefined ? (
                        <Bidi>{toFaDigits(h.latencyMs)} ms</Bidi>
                      ) : (
                        DASH
                      )}{" "}
                      ·{" "}
                      <Bidi>{toFaDigits(h?.consecutiveFailures ?? 0)}</Bidi>
                    </dd>
                  </div>
                  <div>
                    <dt>کارمزد taker (شواهد)</dt>
                    <dd className="sa-sub">
                      {fee?.takerFeeBps !== null && fee?.takerFeeBps !== undefined
                        ? `${toFaDigits(fee.takerFeeBps)} bps`
                        : "نامشخص"}
                      {fee?.provenance ? ` · ${fee.provenance}` : ""}
                    </dd>
                  </div>
                  <div>
                    <dt>ظرفیت خرید / فروش</dt>
                    <dd className="sa-sub">
                      <Bidi>
                        {toFaDigits(
                          microsUsdt(
                            cap?.buy?.capacityUsdtMicros ?? sem?.buyCapacityUsdtMicros
                          )
                        )}
                      </Bidi>{" "}
                      /{" "}
                      <Bidi>
                        {toFaDigits(
                          microsUsdt(
                            cap?.sell?.capacityUsdtMicros ?? sem?.sellCapacityUsdtMicros
                          )
                        )}
                      </Bidi>{" "}
                      USDT
                    </dd>
                  </div>
                  <div>
                    <dt>محدودکننده</dt>
                    <dd className="sa-sub">
                      {cap?.buy?.limitingCap ?? sem?.buyLimiter ?? "—"} /{" "}
                      {cap?.sell?.limitingCap ?? sem?.sellLimiter ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>حجم هوشمند پیشنهادی</dt>
                    <dd>
                      {best?.sizing?.sizeUsdt !== null &&
                      best?.sizing?.sizeUsdt !== undefined ? (
                        <Bidi>{toFaDigits(best.sizing.sizeUsdt.toFixed(4))} USDT</Bidi>
                      ) : (
                        DASH
                      )}
                    </dd>
                  </div>
                </dl>
                {(h?.errorReason || h?.degradedReason || sn?.errorReason || sem?.blockerFa) && (
                  <details className="sa-venue-detail">
                    <summary>جزئیات مشکل و شواهد</summary>
                    <p className="sa-sub">
                      {sem?.blockerFa ??
                        h?.errorReason ??
                        h?.degradedReason ??
                        sn?.errorReason ??
                        sn?.degradedReason ??
                        "—"}
                    </p>
                    {h?.lastSuccessAt ? (
                      <p className="sa-sub">
                        آخرین موفقیت: {formatTehran(h.lastSuccessAt)}
                      </p>
                    ) : null}
                    <p className="sa-sub">
                      پایه خرید/فروش قابل‌استفاده:{" "}
                      {sem?.buyLegUsable ? "بله" : "خیر"} /{" "}
                      {sem?.sellLegUsable ? "بله" : "خیر"}
                    </p>
                  </details>
                )}
              </article>
            );
          })}
          {!orderedIds.length ? (
            <p className="sa-sub">{loading ? "در حال خواندن…" : "منبعی نیست."}</p>
          ) : null}
        </div>
      </section>

      <details className="panel sa-panel sa-advanced-details">
        <summary className="panel-header sa-panel-header">
          <span className="panel-title">شواهد کامل منابع و کارمزد</span>
          <span className="sa-panel-note">جدول‌های تشخیصی و تاریخچهٔ تأیید</span>
        </summary>
        <div className="panel-body">
          <SourcesPanel
            certifications={(certifications as never) ?? []}
            health={(health as never) ?? []}
            snapshots={snapshots}
            venues={venues}
            feeEvidence={feeEvidence}
            auditHistory={auditHistory}
            feeReverifyDays={feeReverifyDays}
            pollIntervalMs={pollIntervalMs}
            loading={loading}
            error={error}
            onReload={onReload}
          />
        </div>
      </details>

      <details className="panel sa-panel sa-advanced-details">
        <summary className="panel-header sa-panel-header">
          <span className="panel-title">تشخیص حجم ثابت تاریخی (۵/۱۰/۲۰/۲۵)</span>
          <span className="sa-panel-note">
            فقط مبنا — اجرا نمی‌شود؛ SMART_CAPITAL_DEPTH مرجع است
          </span>
        </summary>
        <div className="panel-body">
          <p className="sa-sub">
            نردبان ثابت تاریخی فقط برای مقایسهٔ عمق دفتر است و هیچ‌گاه به‌عنوان حجم
            اجرا استفاده نمی‌شود.
          </p>
        </div>
      </details>
    </div>
  );
}
