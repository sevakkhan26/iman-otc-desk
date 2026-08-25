"use client";

/**
 * Cheap discovery observation vs optimizer decision.
 * Observation is telemetry only — never the trading decision.
 */
import { TomanAmount } from "@/components/TomanAmount";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import {
  classifyOpportunity,
  formatPercentFa,
  toFaDigits
} from "@/components/shadowArbitrage/labels";
import type { RouteSizingView } from "@/components/shadowArbitrage/CommandCenter";
import type { ShadowOpportunity } from "@/components/shadowArbitrage/types";

const NA = <span className="sa-unknown">ناموجود</span>;

function pnlTone(n: number | null | undefined): "good" | "warn" | "muted" {
  if (n === null || n === undefined || !Number.isFinite(n)) return "muted";
  if (n > 0) return "good";
  if (n < 0) return "warn";
  return "muted";
}

export function ObservationTelemetry({
  opportunities,
  optimizerRoute
}: {
  opportunities: ShadowOpportunity[];
  optimizerRoute: RouteSizingView | null;
}) {
  const classified = opportunities.map((o) => ({
    o,
    kind: classifyOpportunity({
      eligibility: o.eligibility,
      feeUnknown: o.feeUnknown,
      netProfitToman: o.netProfitToman,
      rawSpreadPercent: o.rawSpreadPercent
    })
  }));
  const bestObs = [...classified].sort((a, b) => b.o.netProfitToman - a.o.netProfitToman)[0]?.o ?? null;

  const econ = optimizerRoute?.sizing.economics ?? null;
  const optPnl = econ?.riskAdjustedPnlToman ?? null;
  const optSize =
    optimizerRoute?.sizing.status === "SIZED" && optimizerRoute.sizing.sizeUsdt != null
      ? optimizerRoute.sizing.sizeUsdt
      : null;

  const obsTone = pnlTone(bestObs?.netProfitToman);
  const optTone = pnlTone(optPnl);

  return (
    <section className="sa-obs-split" aria-label="مشاهده در برابر بهینه‌ساز">
      <article className={`panel sa-panel sa-obs-card sa-rail-${obsTone}`}>
        <div className="panel-body">
          <div className="sa-obs-kicker">تلمتری کشف (مشاهده)</div>
          <h3 className="sa-obs-title">نه تصمیم معامله</h3>
          <p className="sa-sub">
            کشف ارزان ممکن است قرمز یا غیرمثبت باشد در حالی که بهینه‌ساز q* سودآور پیدا می‌کند.
            این رقم تصمیم نهایی معامله نیست.
          </p>
          {bestObs ? (
            <dl className="sa-obs-dl">
              <div>
                <dt>مسیر مشاهده‌شده</dt>
                <dd>
                  {bestObs.buySourceName} ← {bestObs.sellSourceName}
                </dd>
              </div>
              <div>
                <dt>سود خالص کشف</dt>
                <dd className={bestObs.netProfitToman > 0 ? "sa-pos" : "sa-neg"}>
                  <TomanAmount value={bestObs.netProfitToman} />
                </dd>
              </div>
              <div>
                <dt>اسپرد خام</dt>
                <dd>
                  <Bidi>{formatPercentFa(bestObs.rawSpreadPercent)}</Bidi>
                </dd>
              </div>
              <div>
                <dt>وضعیت</dt>
                <dd>{bestObs.eligibility}</dd>
              </div>
            </dl>
          ) : (
            <p className="sa-unknown">فرصت مشاهده‌شده‌ای در این چرخه نیست.</p>
          )}
        </div>
      </article>

      <article className={`panel sa-panel sa-obs-card sa-obs-card-auth sa-rail-${optTone}`}>
        <div className="panel-body">
          <div className="sa-obs-kicker">تصمیم بهینه‌ساز</div>
          <h3 className="sa-obs-title">اقتصاد کانونی — مرجع</h3>
          <p className="sa-sub">حجم و سود تعدیل‌شده از ممیزی MAX_RA_PNL؛ نه از کشف ارزان.</p>
          {optimizerRoute ? (
            <dl className="sa-obs-dl">
              <div>
                <dt>مسیر</dt>
                <dd>
                  {optimizerRoute.buySourceId} ← {optimizerRoute.sellSourceId}
                </dd>
              </div>
              <div>
                <dt>q* انتخاب‌شده</dt>
                <dd>
                  {optSize != null ? (
                    <>
                      <Bidi>{toFaDigits(optSize.toFixed(4))}</Bidi> تتر
                    </>
                  ) : (
                    NA
                  )}
                </dd>
              </div>
              <div>
                <dt>سود تعدیل‌شده با ریسک</dt>
                <dd className={optPnl != null && optPnl > 0 ? "sa-pos" : optPnl != null && optPnl < 0 ? "sa-neg" : undefined}>
                  {econ ? <TomanAmount value={econ.riskAdjustedPnlToman} /> : NA}
                </dd>
              </div>
              <div>
                <dt>سود اقتصادی خالص</dt>
                <dd>{econ ? <TomanAmount value={econ.economicNetPnlToman} /> : NA}</dd>
              </div>
              <div>
                <dt>سود نقدی</dt>
                <dd>{econ ? <TomanAmount value={econ.cashPnlIrtToman} /> : NA}</dd>
              </div>
              <div>
                <dt>وضعیت sizing</dt>
                <dd>
                  <span
                    className={`sa-chip sa-chip-sm sa-chip-${
                      optimizerRoute.sizing.status === "SIZED" ? "good" : "warn"
                    }`}
                  >
                    {optimizerRoute.sizing.status}
                  </span>
                </dd>
              </div>
            </dl>
          ) : (
            <p className="sa-unknown">نتیجهٔ بهینه‌ساز در این چرخه ارسال نشده است.</p>
          )}
        </div>
      </article>
    </section>
  );
}
