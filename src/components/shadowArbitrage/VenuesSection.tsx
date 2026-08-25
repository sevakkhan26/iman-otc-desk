"use client";

import type { ReactNode } from "react";
/**
 * «وضعیت صرافی‌ها» — health, balances, bid/ask, visible book vs executable capacity.
 * Visible volume is raw received book only. Capacity is labeled separately.
 */
import { TomanAmount } from "@/components/TomanAmount";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { toFaDigits } from "@/components/shadowArbitrage/labels";
import type { VenueFeeEvidence, VenueReadiness } from "@/components/shadowArbitrage/sourcesModel";
import type { AccountsAccounting, VenueDepthCardView } from "@/components/shadowArbitrage/AccountsSection";
import type { NormalizedSourceSnapshot } from "@/lib/shadowArbitrage/types";

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
  health: ObservationPayloadLike["sourceHealth"];
  snapshots: NormalizedSourceSnapshot[];
  venues: VenueReadiness[];
  feeEvidence: VenueFeeEvidence[];
  loading: boolean;
  venueSemantics?: VenueSemanticsRow[] | null;
  venueDepthCards?: VenueDepthCardView[] | null;
  accounting?: AccountsAccounting | null;
};

type ObservationPayloadLike = {
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

function UsdtOrNa({
  usdt,
  extra,
  unavailable,
  reasonFa
}: {
  usdt: number | null | undefined;
  extra?: ReactNode;
  unavailable?: boolean;
  reasonFa?: string | null;
}) {
  if (unavailable || usdt === null || usdt === undefined || !Number.isFinite(usdt)) {
    return (
      <span className="sa-unknown" title={reasonFa ?? undefined}>
        {reasonFa && reasonFa.includes("چندسطحی") ? reasonFa : NA_FA}
        {reasonFa && !reasonFa.includes("چندسطحی") ? <span className="sa-sub"> — {reasonFa}</span> : null}
      </span>
    );
  }
  return (
    <span>
      <Bidi>{toFaDigits(usdt.toFixed(4))}</Bidi> USDT
      {extra}
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
  venueDepthCards = null,
  accounting = null
}: Props) {
  const healthBy = new Map((health ?? []).map((h) => [h.sourceId, h]));
  const feeBy = new Map(feeEvidence.map((f) => [f.sourceId, f]));
  const venueBy = new Map(venues.map((v) => [v.sourceId, v]));
  const depthBy = new Map((venueDepthCards ?? []).map((d) => [d.sourceId, d]));
  const semBy = new Map((venueSemantics ?? []).map((s) => [s.sourceId, s]));
  const snapBy = new Map(snapshots.map((s) => [s.sourceId, s]));
  const balBy = new Map((accounting?.venues ?? []).map((v) => [v.sourceId, v]));
  const feeBucketBy = new Map((accounting?.fees.byVenue ?? []).map((f) => [f.sourceId, f]));

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
            حجم دفتر = سطوح دریافتی · ظرفیت اجراپذیر جداست · موجودی از دفتر حسابداری
          </div>
        </div>
        <div className="panel-body sa-venue-grid sa-venue-grid-desk">
          {orderedIds.map((id) => {
            const h = healthBy.get(id);
            const fee = feeBy.get(id);
            const v = venueBy.get(id);
            const depth = depthBy.get(id);
            const sem = semBy.get(id);
            const sn = snapBy.get(id as never);
            const bal = balBy.get(id);
            const feeBag = feeBucketBy.get(id);

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
            const feeMissingFa = fee?.blockerFa ?? fee?.miss ?? "شواهد کارمزد در این چرخه ثبت نشده";
            const ask = depth?.buy;
            const bid = depth?.sell;
            const missingDepthFa = depth ? null : "حجم دفتر این صرافی در این چرخه ارسال نشده";
            const ageLabel = fmtAgeFa(depth?.snapshotAgeMs ?? sn?.ageMs ?? null);
            const nameFa = sem?.nameFa ?? v?.nameFa ?? id;

            const buyCapUsdt =
              ask?.usableCapacityUsdt ??
              (sem?.buyCapacityUsdtMicros != null ? sem.buyCapacityUsdtMicros / 1e6 : null);
            const sellCapUsdt =
              bid?.usableCapacityUsdt ??
              (sem?.sellCapacityUsdtMicros != null ? sem.sellCapacityUsdtMicros / 1e6 : null);

            return (
              <article key={id} className="panel sa-venue-card-desk">
                <header className="sa-venue-desk-head">
                  <div className="sa-venue-desk-id">
                    <strong>{nameFa}</strong>
                    {ageLabel ? <span className="sa-sub">سن اسنپ‌شات: {ageLabel}</span> : null}
                  </div>
                  <span className={`sa-chip sa-chip-sm sa-chip-${tone}`}>{healthFa(status)}</span>
                </header>
                <div className="sa-venue-desk-chips">
                  <span className={`sa-chip sa-chip-sm sa-chip-${sem?.kycComplete ? "good" : "muted"}`}>
                    KYC {sem?.kycComplete ? "✓" : "—"}
                  </span>
                  <span className={`sa-chip sa-chip-sm sa-chip-${sem?.accountEligible ? "good" : "muted"}`}>
                    حساب {sem?.accountEligible ? "✓" : "—"}
                  </span>
                  <span className={`sa-chip sa-chip-sm sa-chip-${sem?.feeConfirmed ? "good" : "warn"}`}>
                    کارمزد {sem?.feeConfirmed ? "✓" : "✗"}
                  </span>
                  <span className={`sa-chip sa-chip-sm sa-chip-${sem?.participates ? "good" : "muted"}`}>
                    {sem?.participates ? "شرکت‌کننده" : "خارج از مسیر"}
                  </span>
                </div>
                <dl className="sa-venue-desk-grid">
                  <div>
                    <dt>موجودی IRT</dt>
                    <dd>{bal ? <TomanAmount value={bal.irtToman} /> : <span className="sa-unknown">{NA_FA}</span>}</dd>
                  </div>
                  <div>
                    <dt>موجودی USDT</dt>
                    <dd>
                      {bal ? (
                        <Bidi>{toFaDigits(bal.usdt.toFixed(4))}</Bidi>
                      ) : (
                        <span className="sa-unknown">{NA_FA}</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>بهترین Bid</dt>
                    <dd>
                      {bid?.bestPriceToman != null ? (
                        <TomanAmount value={bid.bestPriceToman} />
                      ) : (
                        <span className="sa-unknown">{bid?.unavailableFa ?? NA_FA}</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>بهترین Ask</dt>
                    <dd>
                      {ask?.bestPriceToman != null ? (
                        <TomanAmount value={ask.bestPriceToman} />
                      ) : (
                        <span className="sa-unknown">{ask?.unavailableFa ?? NA_FA}</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>حجم قابل‌مشاهده Bid</dt>
                    <dd>
                      <UsdtOrNa
                        usdt={bid?.rawDepthUsdt}
                        extra={
                          bid?.levelsAccepted != null ? (
                            <span className="sa-sub">
                              {" · "}
                              <Bidi>{toFaDigits(bid.levelsAccepted)}</Bidi> سطح
                            </span>
                          ) : null
                        }
                        unavailable={bid?.unavailable || !depth}
                        reasonFa={bid?.unavailableFa ?? missingDepthFa}
                      />
                    </dd>
                  </div>
                  <div>
                    <dt>حجم قابل‌مشاهده Ask</dt>
                    <dd>
                      <UsdtOrNa
                        usdt={ask?.rawDepthUsdt}
                        extra={
                          ask?.levelsAccepted != null ? (
                            <span className="sa-sub">
                              {" · "}
                              <Bidi>{toFaDigits(ask.levelsAccepted)}</Bidi> سطح
                            </span>
                          ) : null
                        }
                        unavailable={ask?.unavailable || !depth}
                        reasonFa={ask?.unavailableFa ?? missingDepthFa}
                      />
                    </dd>
                  </div>
                  <div>
                    <dt>ظرفیت اجراپذیر فروش</dt>
                    <dd>
                      <UsdtOrNa
                        usdt={sellCapUsdt}
                        extra={
                          bid?.limitingLabelFa || sem?.sellLimiter ? (
                            <span className="sa-sub">
                              {" · "}
                              {bid?.limitingLabelFa ?? sem?.sellLimiter}
                            </span>
                          ) : null
                        }
                        unavailable={sellCapUsdt == null}
                        reasonFa={bid?.reasonFa ?? "ظرفیت فروش اندازه‌گیری نشد"}
                      />
                    </dd>
                  </div>
                  <div>
                    <dt>ظرفیت اجراپذیر خرید</dt>
                    <dd>
                      <UsdtOrNa
                        usdt={buyCapUsdt}
                        extra={
                          ask?.limitingLabelFa || sem?.buyLimiter ? (
                            <span className="sa-sub">
                              {" · "}
                              {ask?.limitingLabelFa ?? sem?.buyLimiter}
                            </span>
                          ) : null
                        }
                        unavailable={buyCapUsdt == null}
                        reasonFa={ask?.reasonFa ?? "ظرفیت خرید اندازه‌گیری نشد"}
                      />
                    </dd>
                  </div>
                  <div>
                    <dt>کارمزد taker</dt>
                    <dd>
                      {buyFee !== null && buyFee !== undefined ? (
                        <Bidi>
                          خرید {toFaDigits(buyFee)} · فروش {toFaDigits(sellFee ?? buyFee)} bps
                        </Bidi>
                      ) : (
                        <span className="sa-unknown">{feeMissingFa}</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>معامله / کارمزد دفتر</dt>
                    <dd>
                      {feeBag ? (
                        <>
                          <Bidi>{toFaDigits(feeBag.trades)}</Bidi>
                          {" · "}
                          {feeBag.feeUsdtValueToman !== null ? (
                            <TomanAmount value={feeBag.feeToman + feeBag.feeUsdtValueToman} />
                          ) : (
                            <TomanAmount value={feeBag.feeToman} />
                          )}
                        </>
                      ) : (
                        <span className="sa-unknown">{NA_FA}</span>
                      )}
                    </dd>
                  </div>
                  <div className="sa-venue-desk-wide">
                    <dt>پاها / مانع</dt>
                    <dd>
                      خرید {sem?.buyLegUsable ? "قابل استفاده" : "خیر"} · فروش{" "}
                      {sem?.sellLegUsable ? "قابل استفاده" : "خیر"}
                      {sem?.blockerFa ? <span className="sa-sub"> — {sem.blockerFa}</span> : null}
                      {h?.errorReason ? <span className="sa-sub"> — {h.errorReason}</span> : null}
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
