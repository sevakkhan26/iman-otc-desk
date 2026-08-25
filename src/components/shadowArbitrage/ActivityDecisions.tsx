"use client";

/**
 * «فعالیت‌ها» — named sections, sticky local nav, bounded logs.
 * Live Decision Monitor vs completed trade history are separate views.
 */
import { useMemo, useState } from "react";
import { TomanAmount } from "@/components/TomanAmount";
import { formatTehran } from "@/components/format";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { toFaDigits } from "@/components/shadowArbitrage/labels";
import { reasonLabel } from "@/lib/shadowArbitrage/paper/reasons";
import {
  SIZING_CONSTRAINT_FA,
  type SizingConstraintKey
} from "@/lib/shadowArbitrage/paper/sizing";
import { readInt, useShadowViewState } from "@/components/shadowArbitrage/urlState";
import type { RouteSizingView } from "@/components/shadowArbitrage/CommandCenter";
import type { NormalizedSourceSnapshot, ShadowOpportunity } from "@/components/shadowArbitrage/types";
import { TradeDetailsPanel } from "@/components/shadowArbitrage/TradeDetailsPanel";
import { FilterToolbar } from "@/components/shadowArbitrage/FilterToolbar";
import type { ClosedTradeEvidence } from "@/lib/shadowArbitrage/paper/tradeDetailsView";
import { ObservationTelemetry } from "@/components/shadowArbitrage/ObservationTelemetry";
import { SizingWaterfall } from "@/components/shadowArbitrage/SizingWaterfall";
import { ExperimentHistoryTable } from "@/components/shadowArbitrage/ExperimentSummary";
import {
  parseActivityView,
  ACTIVITY_VIEWS,
  type ActivityViewId
} from "@/components/shadowArbitrage/tabs";
import type { ExperimentHistoryRow } from "@/components/shadowArbitrage/sessionLifecycle";

export type ActivityLedgerRow = {
  id: string;
  lifecycleId: string;
  routeKey: string;
  outcome: "FILLED" | "SKIPPED";
  buySourceId: string;
  sellSourceId: string;
  sizeUsdt: number;
  buyVwapToman: number | null;
  sellVwapToman: number | null;
  buyNotionalToman?: number | null;
  sellNotionalToman?: number | null;
  buyFeeBps?: number | null;
  sellFeeBps?: number | null;
  buyFeeAsset?: string | null;
  sellFeeAsset?: string | null;
  feeTomanTotal?: number | null;
  feeUsdtMicrosTotal?: number | null;
  sellFeeValueToman?: number | null;
  grossSpreadToman?: number | null;
  cashPnlIrtToman?: number | null;
  rejectionCode: string | null;
  rejectionReason: string | null;
  reasonCodes?: string[];
  riskAdjustedPnlToman: number | null;
  economicNetPnlToman: number | null;
  slippageBufferToman?: number | null;
  markPriceToman?: number | null;
  occurredAt: string;
  sizingPolicy?: string | null;
  sizingReason?: string | null;
  bindingConstraint?: string | null;
  limitingSide?: string | null;
  limitingSourceId?: string | null;
  capitalCapUsdtMicros?: number | null;
  depthCapUsdtMicros?: number | null;
  riskAdjustedReturnBps?: number | null;
  selectedPercentOfUsable?: number | null;
  inventoryImpactPoints?: number | null;
  nextLargerSizeUsdt?: number | null;
  nextLargerRejectionCode?: string | null;
  nextLargerRejectionReason?: string | null;
  nextLargerMarginalPnlToman?: number | null;
  balancesAfter?: Array<{ sourceId: string; irtToman: number; usdtMicros: number }>;
};

export type ActivityCycleSummary = {
  occurredAt: string;
  candidatesEvaluated: number;
  filled: number;
  skipped: number;
  detailedEventsWritten: number;
  reasonCounts: Record<string, number>;
};

type Props = {
  session: {
    id: string;
    name: string;
    status: string;
    mode: string;
    totalCapitalToman: number;
    valuationPriceToman: number;
  } | null;
  ledger: ActivityLedgerRow[];
  cycleSummaries: ActivityCycleSummary[];
  routes: RouteSizingView[];
  sizingPolicy: string | null;
  sources: NormalizedSourceSnapshot[];
  serverNow: string | null;
  loading: boolean;
  experimentContext?: {
    experimentId?: string | null;
    policyFingerprint?: string | null;
    releaseVersion?: string | null;
  } | null;
  minRiskAdjustedEdgePercent?: number | null;
  opportunities?: ShadowOpportunity[];
  sessionHistory?: ExperimentHistoryRow[];
  stats?: { filled?: number; skipped?: number } | null;
};

const DASH = <span className="sa-unknown">—</span>;

const WINDOWS: Array<{ id: string; labelFa: string; ms: number | null }> = [
  { id: "all", labelFa: "همهٔ زمان‌ها", ms: null },
  { id: "1h", labelFa: "یک ساعت اخیر", ms: 3_600_000 },
  { id: "6h", labelFa: "شش ساعت اخیر", ms: 21_600_000 },
  { id: "24h", labelFa: "۲۴ ساعت اخیر", ms: 86_400_000 },
  { id: "7d", labelFa: "هفت روز اخیر", ms: 604_800_000 }
];

function constraintFa(key: string | null | undefined): string | null {
  if (!key) return null;
  const known = SIZING_CONSTRAINT_FA[key as SizingConstraintKey];
  if (known) return known;
  if (/[\u0600-\u06FF]/.test(key)) return key;
  return reasonLabel(key);
}

function pickOptimizerRoute(routes: RouteSizingView[]): RouteSizingView | null {
  if (!routes.length) return null;
  const sized = routes.filter((r) => r.sizing.status === "SIZED");
  const pool = sized.length ? sized : routes;
  return (
    [...pool].sort((a, b) => {
      const ap = a.sizing.economics?.riskAdjustedPnlToman ?? Number.NEGATIVE_INFINITY;
      const bp = b.sizing.economics?.riskAdjustedPnlToman ?? Number.NEGATIVE_INFINITY;
      return bp - ap;
    })[0] ?? null
  );
}

function MoneyOrNa({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  return (
    <span className={value > 0 ? "sa-pos" : value < 0 ? "sa-neg" : undefined}>
      <TomanAmount value={value} />
    </span>
  );
}

export function ActivityDecisions({
  session,
  ledger,
  cycleSummaries,
  routes,
  sizingPolicy,
  sources,
  serverNow,
  loading,
  experimentContext = null,
  opportunities = [],
  sessionHistory = [],
  stats = null
}: Props) {
  const { read, write } = useShadowViewState();
  const view: ActivityViewId = parseActivityView(read("aview", "engine"));
  const venue = read("av", "all");
  const outcome = read("ao", "all");
  const reason = read("ar", "all");
  const window = read("aw", "all");
  const page = readInt(read("ap", "1"), 1, 1, 10_000);
  const perPage = readInt(read("an", "20"), 20, 10, 100);
  const [openTradeId, setOpenTradeId] = useState<string | null>(null);

  void sources;

  const venues = useMemo(() => {
    const set = new Set<string>();
    for (const r of ledger) {
      set.add(r.buySourceId);
      set.add(r.sellSourceId);
    }
    return [...set].sort();
  }, [ledger]);

  const reasons = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of ledger) {
      const code = r.rejectionCode;
      if (!code) continue;
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [ledger]);

  const nowMs = serverNow ? Date.parse(serverNow) : Date.now();

  const sectionOutcome: "FILLED" | "SKIPPED" | "all" =
    view === "executed" ? "FILLED" : view === "skipped" ? "SKIPPED" : outcome === "FILLED" || outcome === "SKIPPED" ? outcome : "all";

  const filtered = useMemo(() => {
    const windowMs = WINDOWS.find((w) => w.id === window)?.ms ?? null;
    return ledger.filter((r) => {
      if (sectionOutcome !== "all" && r.outcome !== sectionOutcome) return false;
      if (venue !== "all" && r.buySourceId !== venue && r.sellSourceId !== venue) return false;
      if (reason !== "all" && r.rejectionCode !== reason) return false;
      if (windowMs !== null && nowMs - Date.parse(r.occurredAt) > windowMs) return false;
      return true;
    });
  }, [ledger, venue, reason, window, nowMs, sectionOutcome]);

  const filledTrades = useMemo(
    () => ledger.filter((r) => r.outcome === "FILLED") as unknown as ClosedTradeEvidence[],
    [ledger]
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const safePage = Math.min(page, totalPages);
  const shown = filtered.slice((safePage - 1) * perPage, safePage * perPage);

  const filledCount = stats?.filled ?? ledger.filter((r) => r.outcome === "FILLED").length;
  const skippedCount = stats?.skipped ?? ledger.filter((r) => r.outcome === "SKIPPED").length;

  const openTrade =
    openTradeId != null ? (filledTrades.find((t) => t.id === openTradeId) ?? null) : null;

  const optimizer = pickOptimizerRoute(routes);

  const liveRows = useMemo(() => {
    return [...routes].sort((a, b) => {
      const as = a.sizing.status === "SIZED" ? 0 : 1;
      const bs = b.sizing.status === "SIZED" ? 0 : 1;
      if (as !== bs) return as - bs;
      return (b.sizing.sizeUsdt ?? 0) - (a.sizing.sizeUsdt ?? 0);
    });
  }, [routes]);

  const latestSkip = useMemo(() => {
    const skips = ledger.filter((r) => r.outcome === "SKIPPED");
    if (!skips.length) return null;
    return [...skips].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0] ?? null;
  }, [ledger]);

  const counts: Record<ActivityViewId, number> = {
    engine: liveRows.length,
    executed: filledCount,
    skipped: skippedCount,
    session: sessionHistory.length
  };

  const selectView = (id: ActivityViewId) => write({ aview: id, ap: "1" });

  return (
    <div className="sa-stack sa-desk sa-activity">
      <nav className="sa-activity-nav" aria-label="زیربخش فعالیت‌ها">
        {ACTIVITY_VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className={`sa-activity-nav-btn${view === v.id ? " is-active" : ""}`}
            aria-pressed={view === v.id}
            title={v.hintFa}
            onClick={() => selectView(v.id)}
          >
            <span>{v.labelFa}</span>
            <span className="sa-activity-nav-count">
              <Bidi>{toFaDigits(counts[v.id])}</Bidi>
            </span>
          </button>
        ))}
      </nav>

      {latestSkip ? (
        <button
          type="button"
          className="sa-latest-skip"
          onClick={() => selectView("skipped")}
        >
          <strong>آخرین رد:</strong>{" "}
          {latestSkip.rejectionReason ?? reasonLabel(latestSkip.rejectionCode ?? "")}{" "}
          <span className="sa-sub">{formatTehran(latestSkip.occurredAt)}</span>
        </button>
      ) : null}

      {view === "engine" ? (
        <>
          <ObservationTelemetry opportunities={opportunities} optimizerRoute={optimizer} />
          <SizingWaterfall route={optimizer} compact />
          <section className="panel sa-panel" aria-label="تصمیم‌های موتور">
            <div className="panel-header sa-panel-header">
              <h3 className="panel-title">تصمیم‌های موتور</h3>
              <div className="sa-panel-note">
                جریان زندهٔ sizing این چرخه — معاملهٔ تکمیل‌شده نیست ·{" "}
                {sizingPolicy ?? "MAX_RA_PNL"} ·{" "}
                <Bidi>{toFaDigits(liveRows.length)}</Bidi> مسیر
              </div>
            </div>
            <div className="panel-body">
              {loading && !liveRows.length && !ledger.length ? (
                <p className="sa-sub">در حال خواندن…</p>
              ) : null}
              {liveRows.length ? (
                <div className="sa-table-wrap sa-term-wrap sa-activity-scroll">
                  <table className="sa-table sa-term-table">
                    <thead>
                      <tr>
                        <th>خرید</th>
                        <th>فروش</th>
                        <th className="num">q*</th>
                        <th className="num">VWAP</th>
                        <th className="num">نقدی</th>
                        <th className="num">اقتصادی</th>
                        <th className="num">RA</th>
                        <th>نتیجه</th>
                        <th>محدودکننده</th>
                      </tr>
                    </thead>
                    <tbody>
                      {liveRows.map((r) => {
                        const s = r.sizing;
                        const e = s.economics;
                        const q = s.quote;
                        const sized = s.status === "SIZED";
                        return (
                          <tr key={r.routeKey} className="sa-row">
                            <td>{r.buySourceId}</td>
                            <td>{r.sellSourceId}</td>
                            <td className="num">
                              {s.sizeUsdt != null ? (
                                <Bidi>{toFaDigits(s.sizeUsdt.toFixed(4))}</Bidi>
                              ) : (
                                DASH
                              )}
                            </td>
                            <td className="num">
                              {q ? (
                                <Bidi>
                                  {toFaDigits(q.buyVwapToman.toLocaleString("en-US"))} ↤{" "}
                                  {toFaDigits(q.sellVwapToman.toLocaleString("en-US"))}
                                </Bidi>
                              ) : (
                                DASH
                              )}
                            </td>
                            <td className="num">
                              <MoneyOrNa value={e?.cashPnlIrtToman} />
                            </td>
                            <td className="num">
                              <MoneyOrNa value={e?.economicNetPnlToman} />
                            </td>
                            <td className="num">
                              <MoneyOrNa value={e?.riskAdjustedPnlToman} />
                            </td>
                            <td>
                              <span className={`sa-chip sa-chip-sm sa-chip-${sized ? "good" : "warn"}`}>
                                {sized ? "حجم‌گرفت" : "رد sizing"}
                              </span>
                              <div className="sa-sub">
                                {sized
                                  ? s.selection?.reasonFa ?? "q* پذیرفته شد"
                                  : s.blockers[0]?.detailFa ?? "دلیل ثبت نشده"}
                              </div>
                            </td>
                            <td className="sa-sub">
                              {constraintFa(s.bindingConstraint) ?? "—"}
                              {s.inventory?.measurable ? (
                                <>
                                  <br />
                                  موجودی {toFaDigits(s.inventory.impactPoints.toFixed(2))}
                                </>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="sa-empty">هنوز مسیر sizing برای این چرخه نیست.</p>
              )}
            </div>
          </section>
        </>
      ) : null}

      {view === "executed" || view === "skipped" ? (
        <section
          className="panel sa-panel"
          aria-label={view === "executed" ? "معاملات اجراشده" : "تصمیم‌های ردشده"}
        >
          <div className="panel-header sa-panel-header">
            <h3 className="panel-title">
              {view === "executed" ? "معاملات اجراشده" : "رد یا ردشده"}
            </h3>
            <div className="sa-panel-note">
              {view === "executed"
                ? "تاریخچهٔ پر شدن‌های دفتر این نشست — نه جریان زندهٔ sizing"
                : "نامزدهایی که اجرا نشدند و دلیل ثبت‌شده"}
              {" · "}
              <Bidi>
                {toFaDigits(filtered.length)} از {toFaDigits(view === "executed" ? filledCount : skippedCount)}
              </Bidi>
            </div>
          </div>
          <div className="panel-body">
            <FilterToolbar
              venues={venues}
              reasons={reasons}
              reasonLabel={reasonLabel}
              windows={WINDOWS}
              hideOutcome
            />
          </div>
          <div className="panel-body">
            {shown.length ? (
              <>
                <div className="sa-table-wrap sa-term-wrap sa-activity-scroll">
                  <table className="sa-table sa-term-table">
                    <thead>
                      <tr>
                        <th>زمان</th>
                        <th>خرید</th>
                        <th>فروش</th>
                        <th className="num">حجم</th>
                        <th className="num">VWAP</th>
                        <th className="num">کارمزد</th>
                        <th className="num">نقدی</th>
                        <th className="num">اقتصادی</th>
                        <th className="num">RA</th>
                        <th className="num">لبه</th>
                        <th>نتیجه / دلیل</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((r) => (
                        <tr key={r.id} className="sa-row">
                          <td className="sa-sub">{formatTehran(r.occurredAt)}</td>
                          <td>{r.buySourceId}</td>
                          <td>{r.sellSourceId}</td>
                          <td className="num">
                            <Bidi>{toFaDigits(r.sizeUsdt.toFixed(4))}</Bidi>
                          </td>
                          <td className="num">
                            {r.buyVwapToman != null && r.sellVwapToman != null ? (
                              <Bidi>
                                {toFaDigits(r.buyVwapToman.toLocaleString("en-US"))} ↤{" "}
                                {toFaDigits(r.sellVwapToman.toLocaleString("en-US"))}
                              </Bidi>
                            ) : (
                              DASH
                            )}
                          </td>
                          <td className="num">
                            {r.feeTomanTotal != null || r.sellFeeValueToman != null ? (
                              <>
                                {r.feeTomanTotal != null ? <TomanAmount value={r.feeTomanTotal} /> : DASH}
                                {r.sellFeeValueToman != null ? (
                                  <>
                                    {" / "}
                                    <TomanAmount value={r.sellFeeValueToman} />
                                  </>
                                ) : null}
                              </>
                            ) : (
                              DASH
                            )}
                          </td>
                          <td className="num">
                            <MoneyOrNa value={r.cashPnlIrtToman} />
                          </td>
                          <td className="num">
                            <MoneyOrNa value={r.economicNetPnlToman} />
                          </td>
                          <td className="num">
                            <MoneyOrNa value={r.riskAdjustedPnlToman} />
                          </td>
                          <td className="num">
                            {r.riskAdjustedReturnBps != null ? (
                              <Bidi>{toFaDigits(r.riskAdjustedReturnBps)} bps</Bidi>
                            ) : (
                              DASH
                            )}
                          </td>
                          <td>
                            <span
                              className={`sa-chip sa-chip-sm sa-chip-${
                                r.outcome === "FILLED" ? "good" : "warn"
                              }`}
                            >
                              {r.outcome === "FILLED" ? "اجراشده" : "ردشده"}
                            </span>
                            <div className="sa-sub">
                              {r.outcome === "FILLED"
                                ? (r.sizingReason ?? "در دفتر ثبت شد")
                                : (r.rejectionReason ?? reasonLabel(r.rejectionCode ?? ""))}
                              {r.bindingConstraint ? (
                                <>
                                  {" · "}
                                  {constraintFa(r.bindingConstraint)}
                                </>
                              ) : null}
                            </div>
                            {r.outcome === "FILLED" ? (
                              <button
                                type="button"
                                className="sa-linkish"
                                onClick={() =>
                                  setOpenTradeId((cur) => (cur === r.id ? null : r.id))
                                }
                              >
                                جزئیات
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="sa-pager">
                  <button
                    type="button"
                    className="sa-btn-page"
                    disabled={safePage <= 1}
                    onClick={() => write({ ap: String(safePage - 1) })}
                  >
                    قبلی
                  </button>
                  <span className="sa-pager-page">
                    <Bidi>
                      {toFaDigits(safePage)} / {toFaDigits(totalPages)}
                    </Bidi>
                  </span>
                  <button
                    type="button"
                    className="sa-btn-page"
                    disabled={safePage >= totalPages}
                    onClick={() => write({ ap: String(safePage + 1) })}
                  >
                    بعدی
                  </button>
                </div>
              </>
            ) : (
              <p className="sa-empty">
                {loading
                  ? "در حال خواندن…"
                  : ledger.length
                    ? "هیچ ردیفی با این فیلترها مطابقت ندارد."
                    : view === "executed"
                      ? "هنوز معاملهٔ اجراشده‌ای در این نشست نیست."
                      : "هنوز تصمیم ردشده‌ای ثبت نشده است."}
              </p>
            )}
            {openTrade ? (
              <TradeDetailsPanel
                trade={openTrade}
                context={{
                  experimentId: experimentContext?.experimentId ?? null,
                  policyFingerprint: experimentContext?.policyFingerprint ?? null,
                  releaseVersion: experimentContext?.releaseVersion ?? null
                }}
                open
                onClose={() => setOpenTradeId(null)}
              />
            ) : null}
          </div>
        </section>
      ) : null}

      {view === "session" ? (
        <section className="panel sa-panel" aria-label="خلاصه نشست">
          <div className="panel-header sa-panel-header">
            <h3 className="panel-title">خلاصه نشست</h3>
            <div className="sa-panel-note">
              شمارنده‌های دفتر همین نشست · نوار بالا وضعیت آزمایش فعال است
              {session ? ` · ${session.name}` : ""}
            </div>
          </div>
          <div className="panel-body sa-stack">
            <dl className="sa-exp-strip-grid">
              <div>
                <dt>چرخه‌های ثبت‌شده</dt>
                <dd>
                  <Bidi>{toFaDigits(cycleSummaries.length)}</Bidi>
                </dd>
              </div>
              <div>
                <dt>اجراشده</dt>
                <dd>
                  <Bidi>{toFaDigits(filledCount)}</Bidi>
                </dd>
              </div>
              <div>
                <dt>رد / ردشده</dt>
                <dd>
                  <Bidi>{toFaDigits(skippedCount)}</Bidi>
                </dd>
              </div>
            </dl>
            <ExperimentHistoryTable rows={sessionHistory} loading={loading} />
          </div>
        </section>
      ) : null}
    </div>
  );
}
