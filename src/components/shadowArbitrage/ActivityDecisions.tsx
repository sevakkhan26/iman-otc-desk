"use client";

/**
 * «فعالیت‌ها» — why traded / not traded, and completed trade evidence.
 *
 * Strictly read-only. Never invents values; missing data → Unavailable + reason.
 */
import { useMemo, useState } from "react";
import { TomanAmount } from "@/components/TomanAmount";
import { formatTehran } from "@/components/format";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { toFaDigits } from "@/components/shadowArbitrage/labels";
import { reasonLabel } from "@/lib/shadowArbitrage/paper/reasons";
import { readInt, useShadowViewState } from "@/components/shadowArbitrage/urlState";
import type { RouteSizingView } from "@/components/shadowArbitrage/CommandCenter";
import type { NormalizedSourceSnapshot } from "@/lib/shadowArbitrage/types";
import { TradeDetailsPanel } from "@/components/shadowArbitrage/TradeDetailsPanel";
import type { ClosedTradeEvidence } from "@/lib/shadowArbitrage/paper/tradeDetailsView";

/** One recorded decision, as the paper API returns it. */
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
  /** Optional experiment context for trade detail panel. */
  experimentContext?: {
    experimentId?: string | null;
    policyFingerprint?: string | null;
    releaseVersion?: string | null;
  } | null;
  /** Min required risk-adjusted edge percent from policy, if known. */
  minRiskAdjustedEdgePercent?: number | null;
};

const DASH = <span className="sa-unknown">—</span>;
const UNAVAILABLE = "Unavailable";
const usdt = (micros: number | null | undefined) =>
  micros === null || micros === undefined ? null : (micros / 1_000_000).toFixed(4);

const WINDOWS: Array<{ id: string; labelFa: string; ms: number | null }> = [
  { id: "all", labelFa: "همهٔ زمان‌ها", ms: null },
  { id: "1h", labelFa: "یک ساعت اخیر", ms: 3_600_000 },
  { id: "6h", labelFa: "شش ساعت اخیر", ms: 21_600_000 },
  { id: "24h", labelFa: "۲۴ ساعت اخیر", ms: 86_400_000 },
  { id: "7d", labelFa: "هفت روز اخیر", ms: 604_800_000 }
];

const SESSION_STATUS_FA: Record<string, string> = {
  RUNNING: "در حال اجرا",
  PAUSED: "متوقف موقت",
  STOPPED: "پایان‌یافته",
  CREATED: "شروع‌نشده"
};

function Unavail({ reason }: { reason: string }) {
  return (
    <span className="sa-unknown" title={reason}>
      {UNAVAILABLE}
      <span className="sa-sub"> — {reason}</span>
    </span>
  );
}

function Field({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="sa-why-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function WhyRouteCard({
  r,
  sourceAge,
  minEdgePct
}: {
  r: RouteSizingView;
  sourceAge: Map<string, { ageMs: number | null; asOf: string | null }>;
  minEdgePct: number | null | undefined;
}) {
  const s = r.sizing;
  const buyAge = sourceAge.get(r.buySourceId);
  const sellAge = sourceAge.get(r.sellSourceId);
  const ceiling =
    s.capacity?.ceilingMicros != null
      ? s.capacity.ceilingMicros / 1e6
      : s.maxFeasibleUsdtMicros != null
        ? s.maxFeasibleUsdtMicros / 1e6
        : null;
  const econ = s.economics;
  const quote = s.quote;
  const isSized = s.status === "SIZED";
  const isBlocked = s.status === "BLOCKED";

  // Gross spread: sell VWAP − buy VWAP × size when quote present
  let grossSpread: number | null = null;
  let grossPnl: number | null = null;
  if (quote && s.sizeUsdt != null) {
    grossSpread = quote.sellVwapToman - quote.buyVwapToman;
    grossPnl = grossSpread * s.sizeUsdt;
  } else if (econ) {
    // cash PnL is after fees in some models — show only when we have it as labeled cash
    grossPnl = econ.cashPnlIrtToman ?? null;
  }

  const riskAdj = econ?.riskAdjustedPnlToman ?? null;
  const economicNet = econ?.economicNetPnlToman ?? null;
  // Min required profit in toman: min edge % of capital involved when both known
  let minRequired: number | null = null;
  let shortfall: number | null = null;
  if (
    minEdgePct != null &&
    Number.isFinite(minEdgePct) &&
    econ?.capitalInvolvedToman != null &&
    Number.isFinite(econ.capitalInvolvedToman)
  ) {
    minRequired = (minEdgePct / 100) * econ.capitalInvolvedToman;
    if (riskAdj != null) {
      shortfall = Math.max(0, minRequired - riskAdj);
    }
  }

  const rejectionReason =
    s.blockers?.[0]?.detailFa ??
    s.selection?.nextLarger?.detailFa ??
    (isBlocked ? s.blockers?.map((b) => b.detailFa).join(" · ") || null : null) ??
    (!isSized ? "مسیر حجم نگرفت — جزئیات در blockers" : null);

  const executionReason =
    isSized
      ? s.selection?.reasonFa ?? s.policy ?? "SIZED"
      : rejectionReason;

  return (
    <article className="sa-why-card panel sa-panel">
      <header className="sa-why-card-head">
        <strong>
          {r.buySourceId} ← {r.sellSourceId}
        </strong>
        <span
          className={`sa-chip sa-chip-sm sa-chip-${isSized ? "good" : "muted"}`}
        >
          {isSized ? "قابل اجرا / حجم‌گرفته" : "رد / مسدود"}
        </span>
      </header>
      <dl className="sa-why-grid">
        <Field label="مسیر ارزیابی‌شده">
          <code className="sa-ps-key">{r.routeKey}</code>
        </Field>
        <Field label="صرافی خرید / فروش">
          {r.buySourceId} / {r.sellSourceId}
        </Field>
        <Field label="زمان / سن داده خرید">
          {buyAge?.ageMs != null ? (
            <Bidi>{toFaDigits(Math.round(buyAge.ageMs / 1000))} ثانیه</Bidi>
          ) : (
            <Unavail reason="سن اسنپ‌شات خرید در payload نیست" />
          )}
        </Field>
        <Field label="زمان / سن داده فروش">
          {sellAge?.ageMs != null ? (
            <Bidi>{toFaDigits(Math.round(sellAge.ageMs / 1000))} ثانیه</Bidi>
          ) : (
            <Unavail reason="سن اسنپ‌شات فروش در payload نیست" />
          )}
        </Field>
        <Field label="VWAP خرید">
          {quote ? (
            <TomanAmount value={quote.buyVwapToman} />
          ) : (
            <Unavail reason="quote.buyVwapToman در sizing موجود نیست" />
          )}
        </Field>
        <Field label="VWAP فروش">
          {quote ? (
            <TomanAmount value={quote.sellVwapToman} />
          ) : (
            <Unavail reason="quote.sellVwapToman در sizing موجود نیست" />
          )}
        </Field>
        <Field label="سقف امن">
          {ceiling != null ? (
            <Bidi>{toFaDigits(ceiling.toFixed(4))} USDT</Bidi>
          ) : (
            <Unavail reason="capacity.ceilingMicros / maxFeasible ثبت نشده" />
          )}
        </Field>
        <Field label="حجم انتخاب‌شده">
          {s.sizeUsdt != null ? (
            <Bidi>{toFaDigits(s.sizeUsdt.toFixed(4))} USDT</Bidi>
          ) : (
            <Unavail reason="sizeUsdt برای این مسیر null است" />
          )}
        </Field>
        <Field label="محدودکننده قطعی">
          {s.bindingConstraint ?? (
            <Unavail reason="bindingConstraint در sizing ثبت نشده" />
          )}
        </Field>
        <Field label="اسپرد ناخالص (هر تتر)">
          {grossSpread != null ? (
            <TomanAmount value={grossSpread} />
          ) : (
            <Unavail reason="نیاز به quote.buy/sell VWAP" />
          )}
        </Field>
        <Field label="P&L ناخالص تقریبی">
          {grossPnl != null ? (
            <TomanAmount value={grossPnl} />
          ) : (
            <Unavail reason="quote+size یا cashPnlIrtToman موجود نیست" />
          )}
        </Field>
        <Field label="کارمزد پای خرید (venue / asset)">
          {econ?.sellFeeValueToman != null || quote ? (
            <span className="sa-sub">
              venue: {r.buySourceId}
              {" · "}
              {econ ? (
                <>
                  sell-leg fee value: <TomanAmount value={econ.sellFeeValueToman} />
                </>
              ) : (
                <Unavail reason="economics.sellFeeValueToman (و تفکیک buy-leg) در payload نیست" />
              )}
            </span>
          ) : (
            <Unavail reason="economics برای کارمزد پاها موجود نیست" />
          )}
        </Field>
        <Field label="کارمزد پای فروش (venue / asset)">
          <span className="sa-sub">
            venue: {r.sellSourceId}
            {" · "}
            {econ ? (
              <>
                sellFeeValueToman: <TomanAmount value={econ.sellFeeValueToman} />
              </>
            ) : (
              <Unavail reason="economics.sellFeeValueToman موجود نیست" />
            )}
          </span>
        </Field>
        <Field label="لغزش (slippage)">
          {quote ? (
            <Bidi>
              buy {toFaDigits(quote.buySlippageBps)} bps · sell{" "}
              {toFaDigits(quote.sellSlippageBps)} bps
            </Bidi>
          ) : econ?.slippageBufferToman != null ? (
            <TomanAmount value={econ.slippageBufferToman} />
          ) : (
            <Unavail reason="quote.slippageBps و economics.slippageBufferToman موجود نیست" />
          )}
        </Field>
        <Field label="بافر ریسک">
          {econ?.slippageBufferToman != null ? (
            <TomanAmount value={econ.slippageBufferToman} />
          ) : (
            <Unavail reason="economics.slippageBufferToman موجود نیست" />
          )}
        </Field>
        <Field label="خالص اقتصادی">
          {economicNet != null ? (
            <TomanAmount value={economicNet} />
          ) : (
            <Unavail reason="economics.economicNetPnlToman موجود نیست" />
          )}
        </Field>
        <Field label="خالص تعدیل‌شده ریسک">
          {riskAdj != null ? (
            <TomanAmount value={riskAdj} />
          ) : (
            <Unavail reason="economics.riskAdjustedPnlToman موجود نیست" />
          )}
        </Field>
        <Field label="حداقل سود لازم">
          {minRequired != null ? (
            <TomanAmount value={minRequired} />
          ) : minEdgePct != null ? (
            <Bidi>{toFaDigits(minEdgePct)}٪ لبه (سرمایهٔ درگیر نامشخص)</Bidi>
          ) : (
            <Unavail reason="min_risk_adjusted_edge_percent یا capitalInvolved ثبت نشده" />
          )}
        </Field>
        <Field label="کسری دقیق (رد)">
          {!isSized && shortfall != null ? (
            <TomanAmount value={shortfall} />
          ) : !isSized ? (
            <Unavail reason="کوتاهی قابل محاسبه نیست بدون minRequired و riskAdj" />
          ) : (
            <span className="sa-sub">— (مسیر رد نشده)</span>
          )}
        </Field>
        <Field label="دلیل اجرا یا رد">
          {executionReason ?? (
            <Unavail reason="selection.reasonFa / blockers خالی است" />
          )}
        </Field>
      </dl>
    </article>
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
  minRiskAdjustedEdgePercent = null
}: Props) {
  const { read, write } = useShadowViewState();
  const venue = read("av", "all");
  const outcome = read("ao", "all");
  const reason = read("ar", "all");
  const window = read("aw", "all");
  const page = readInt(read("ap", "1"), 1, 1, 10_000);
  const perPage = readInt(read("an", "20"), 20, 10, 100);
  const [openTradeId, setOpenTradeId] = useState<string | null>(null);

  const sourceAge = useMemo(() => {
    const m = new Map<string, { ageMs: number | null; asOf: string | null }>();
    for (const s of sources) {
      m.set(s.sourceId, {
        ageMs: typeof s.ageMs === "number" ? s.ageMs : null,
        asOf: null
      });
    }
    return m;
  }, [sources]);

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

  const filtered = useMemo(() => {
    const windowMs = WINDOWS.find((w) => w.id === window)?.ms ?? null;
    return ledger.filter((r) => {
      if (venue !== "all" && r.buySourceId !== venue && r.sellSourceId !== venue) return false;
      if (outcome !== "all" && r.outcome !== outcome) return false;
      if (reason !== "all" && r.rejectionCode !== reason) return false;
      if (windowMs !== null && nowMs - Date.parse(r.occurredAt) > windowMs) return false;
      return true;
    });
  }, [ledger, venue, outcome, reason, window, nowMs]);

  const filledTrades = useMemo(
    () =>
      ledger.filter((r) => r.outcome === "FILLED") as unknown as ClosedTradeEvidence[],
    [ledger]
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const safePage = Math.min(page, totalPages);
  const shown = filtered.slice((safePage - 1) * perPage, safePage * perPage);

  const filledCount = ledger.filter((r) => r.outcome === "FILLED").length;
  const skippedCount = ledger.length - filledCount;

  const setFilter = (patch: Record<string, string | null>) => write({ ...patch, ap: "1" });

  const openTrade =
    openTradeId != null
      ? filledTrades.find((t) => t.id === openTradeId) ?? null
      : null;

  // Prefer routes with any evaluation signal for the why section
  const whyRoutes = routes.length
    ? [...routes].sort((a, b) => {
        const as = a.sizing.status === "SIZED" ? 0 : 1;
        const bs = b.sizing.status === "SIZED" ? 0 : 1;
        if (as !== bs) return as - bs;
        return (b.sizing.sizeUsdt ?? 0) - (a.sizing.sizeUsdt ?? 0);
      })
    : [];

  // Latest ledger rows as fallback explainability when routes empty
  const latestLedger = useMemo(
    () => [...ledger].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).slice(0, 8),
    [ledger]
  );

  return (
    <div className="sa-stack">
      {/* ── Why traded / not ─────────────────────────────────────────────── */}
      <section className="panel sa-panel" aria-label="چرا معامله شد یا نشد؟">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title sa-panel-title">چرا معامله شد یا نشد؟</h3>
          <div className="sa-panel-note">
            آخرین چرخه
            {sizingPolicy ? ` · ${sizingPolicy}` : ""}
          </div>
        </div>
        <div className="panel-body sa-stack">
          {loading && !whyRoutes.length && !latestLedger.length ? (
            <p className="sa-sub">در حال خواندن…</p>
          ) : null}

          {whyRoutes.length ? (
            <div className="sa-why-list">
              {whyRoutes.slice(0, 12).map((r) => (
                <WhyRouteCard
                  key={r.routeKey}
                  r={r}
                  sourceAge={sourceAge}
                  minEdgePct={minRiskAdjustedEdgePercent}
                />
              ))}
            </div>
          ) : latestLedger.length ? (
            <div className="sa-why-list">
              {latestLedger.map((r) => (
                <article key={r.id} className="sa-why-card panel sa-panel">
                  <header className="sa-why-card-head">
                    <strong>
                      {r.buySourceId} ← {r.sellSourceId}
                    </strong>
                    <span
                      className={`sa-chip sa-chip-sm sa-chip-${
                        r.outcome === "FILLED" ? "good" : "muted"
                      }`}
                    >
                      {r.outcome === "FILLED" ? "اجراشده" : "ردشده"}
                    </span>
                  </header>
                  <dl className="sa-why-grid">
                    <Field label="مسیر">{r.routeKey}</Field>
                    <Field label="صرافی خرید / فروش">
                      {r.buySourceId} / {r.sellSourceId}
                    </Field>
                    <Field label="زمان">{formatTehran(r.occurredAt)}</Field>
                    <Field label="سن داده">
                      <Unavail reason="سن quote در ردیف دفتر ذخیره نشده" />
                    </Field>
                    <Field label="VWAP خرید">
                      {r.buyVwapToman != null ? (
                        <TomanAmount value={r.buyVwapToman} />
                      ) : (
                        <Unavail reason="buyVwapToman در ledger null است" />
                      )}
                    </Field>
                    <Field label="VWAP فروش">
                      {r.sellVwapToman != null ? (
                        <TomanAmount value={r.sellVwapToman} />
                      ) : (
                        <Unavail reason="sellVwapToman در ledger null است" />
                      )}
                    </Field>
                    <Field label="سقف امن">
                      {r.capitalCapUsdtMicros != null || r.depthCapUsdtMicros != null ? (
                        <Bidi>
                          capital {usdt(r.capitalCapUsdtMicros) ?? "—"} · depth{" "}
                          {usdt(r.depthCapUsdtMicros) ?? "—"} USDT
                        </Bidi>
                      ) : (
                        <Unavail reason="capitalCap/depthCap در ledger ثبت نشده" />
                      )}
                    </Field>
                    <Field label="حجم انتخاب‌شده">
                      <Bidi>{toFaDigits(r.sizeUsdt.toFixed(4))} USDT</Bidi>
                    </Field>
                    <Field label="محدودکننده">
                      {r.bindingConstraint ?? (
                        <Unavail reason="bindingConstraint در ledger ثبت نشده" />
                      )}
                    </Field>
                    <Field label="اسپرد / P&L ناخالص">
                      {r.grossSpreadToman != null ? (
                        <TomanAmount value={r.grossSpreadToman} />
                      ) : (
                        <Unavail reason="grossSpreadToman در ledger موجود نیست" />
                      )}
                    </Field>
                    <Field label="کارمزد خرید (venue / asset)">
                      {r.buyFeeBps != null || r.feeTomanTotal != null ? (
                        <span className="sa-sub">
                          {r.buySourceId}
                          {r.buyFeeAsset ? ` · ${r.buyFeeAsset}` : ""}
                          {r.buyFeeBps != null ? ` · ${toFaDigits(r.buyFeeBps)} bps` : ""}
                          {r.feeTomanTotal != null ? (
                            <>
                              {" · "}
                              <TomanAmount value={r.feeTomanTotal} />
                            </>
                          ) : null}
                        </span>
                      ) : (
                        <Unavail reason="buyFeeBps / feeTomanTotal در ledger نیست" />
                      )}
                    </Field>
                    <Field label="کارمزد فروش (venue / asset)">
                      {r.sellFeeBps != null || r.sellFeeValueToman != null ? (
                        <span className="sa-sub">
                          {r.sellSourceId}
                          {r.sellFeeAsset ? ` · ${r.sellFeeAsset}` : ""}
                          {r.sellFeeBps != null ? ` · ${toFaDigits(r.sellFeeBps)} bps` : ""}
                          {r.sellFeeValueToman != null ? (
                            <>
                              {" · "}
                              <TomanAmount value={r.sellFeeValueToman} />
                            </>
                          ) : null}
                        </span>
                      ) : (
                        <Unavail reason="sellFeeBps / sellFeeValueToman در ledger نیست" />
                      )}
                    </Field>
                    <Field label="لغزش / بافر ریسک">
                      {r.slippageBufferToman != null ? (
                        <TomanAmount value={r.slippageBufferToman} />
                      ) : (
                        <Unavail reason="slippageBufferToman در ledger موجود نیست" />
                      )}
                    </Field>
                    <Field label="خالص اقتصادی">
                      {r.economicNetPnlToman != null ? (
                        <TomanAmount value={r.economicNetPnlToman} />
                      ) : (
                        <Unavail reason="economicNetPnlToman null است" />
                      )}
                    </Field>
                    <Field label="خالص تعدیل‌شده">
                      {r.riskAdjustedPnlToman != null ? (
                        <TomanAmount value={r.riskAdjustedPnlToman} />
                      ) : (
                        <Unavail reason="riskAdjustedPnlToman null است" />
                      )}
                    </Field>
                    <Field label="حداقل سود لازم">
                      <Unavail reason="حداقل سود در ردیف دفتر ذخیره نشده؛ از سیاست چرخه استفاده کنید" />
                    </Field>
                    <Field label="کسری / دلیل">
                      {r.outcome === "SKIPPED" ? (
                        r.rejectionReason ?? reasonLabel(r.rejectionCode ?? "") ?? (
                          <Unavail reason="rejectionReason خالی است" />
                        )
                      ) : (
                        r.sizingReason ?? "اجرا شد"
                      )}
                    </Field>
                  </dl>
                </article>
              ))}
            </div>
          ) : (
            <p className="sa-sub">
              هنوز مسیر یا تصمیمی برای توضیح وجود ندارد.
            </p>
          )}
        </div>
      </section>

      {/* ── Completed trades ─────────────────────────────────────────────── */}
      <section className="panel sa-panel" aria-label="معاملات تکمیل‌شده">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title">معاملات تکمیل‌شده</h3>
          <div className="sa-panel-note">
            <Bidi>{toFaDigits(filledTrades.length)}</Bidi> معامله
          </div>
        </div>
        <div className="panel-body sa-stack">
          {filledTrades.length ? (
            <>
              <div className="sa-table-wrap sa-ad-desktop">
                <table className="sa-table">
                  <thead>
                    <tr>
                      <th>خرید</th>
                      <th>فروش</th>
                      <th className="num">حجم</th>
                      <th className="num">VWAP</th>
                      <th className="num">خالص اقتصادی</th>
                      <th>زمان / مدت</th>
                      <th>ledger</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {filledTrades.slice(0, 50).map((t) => (
                      <tr key={t.id}>
                        <td>
                          {t.buySourceId}
                          <div className="sa-sub">
                            {t.buyVwapToman != null ? (
                              <TomanAmount value={t.buyVwapToman} />
                            ) : (
                              <Unavail reason="buyVwapToman" />
                            )}
                            {t.buyFeeBps != null ? (
                              <> · fee {toFaDigits(t.buyFeeBps)} bps</>
                            ) : null}
                            {t.buyFeeAsset ? ` (${t.buyFeeAsset})` : ""}
                          </div>
                        </td>
                        <td>
                          {t.sellSourceId}
                          <div className="sa-sub">
                            {t.sellVwapToman != null ? (
                              <TomanAmount value={t.sellVwapToman} />
                            ) : (
                              <Unavail reason="sellVwapToman" />
                            )}
                            {t.sellFeeBps != null ? (
                              <> · fee {toFaDigits(t.sellFeeBps)} bps</>
                            ) : null}
                            {t.sellFeeAsset ? ` (${t.sellFeeAsset})` : ""}
                          </div>
                        </td>
                        <td className="num">
                          <Bidi>{toFaDigits(t.sizeUsdt.toFixed(4))}</Bidi>
                        </td>
                        <td className="num">
                          {t.buyVwapToman != null && t.sellVwapToman != null ? (
                            <Bidi>
                              {toFaDigits(t.buyVwapToman.toLocaleString("en-US"))} ↤{" "}
                              {toFaDigits(t.sellVwapToman.toLocaleString("en-US"))}
                            </Bidi>
                          ) : (
                            DASH
                          )}
                        </td>
                        <td className="num">
                          {t.economicNetPnlToman != null ? (
                            <TomanAmount value={t.economicNetPnlToman} />
                          ) : (
                            <Unavail reason="economicNetPnlToman" />
                          )}
                          {t.markPriceToman != null && t.economicNetPnlToman != null ? (
                            <div className="sa-sub">
                              ≈{" "}
                              <Bidi>
                                {toFaDigits(
                                  (t.economicNetPnlToman / t.markPriceToman).toFixed(4)
                                )}
                              </Bidi>{" "}
                              USDT
                            </div>
                          ) : null}
                        </td>
                        <td className="sa-sub">
                          {formatTehran(t.occurredAt)}
                          <div>مدت: atomic dual-leg · ۰ ms</div>
                        </td>
                        <td className="sa-sub">
                          <code className="sa-ps-key">{t.id}</code>
                          <div>FILLED</div>
                          {t.bindingConstraint ? (
                            <div>sizing: {t.bindingConstraint}</div>
                          ) : null}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="sa-btn sa-btn-ghost sa-td-open-btn"
                            onClick={() =>
                              setOpenTradeId((cur) => (cur === t.id ? null : t.id))
                            }
                          >
                            جزئیات
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="sa-ad-cards">
                {filledTrades.slice(0, 50).map((t) => (
                  <li key={t.id} className="sa-ad-card">
                    <div className="sa-ad-card-head">
                      <span className="sa-ad-card-title">
                        {t.buySourceId} ← {t.sellSourceId}
                      </span>
                      {t.economicNetPnlToman != null ? (
                        <TomanAmount value={t.economicNetPnlToman} />
                      ) : (
                        DASH
                      )}
                    </div>
                    <p className="sa-sub">
                      <Bidi>{toFaDigits(t.sizeUsdt.toFixed(4))}</Bidi> تتر ·{" "}
                      {formatTehran(t.occurredAt)} · {t.id}
                    </p>
                    <button
                      type="button"
                      className="sa-btn sa-btn-ghost"
                      onClick={() =>
                        setOpenTradeId((cur) => (cur === t.id ? null : t.id))
                      }
                    >
                      جزئیات معامله
                    </button>
                  </li>
                ))}
              </ul>
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
            </>
          ) : (
            <p className="sa-sub">
              {loading ? "در حال خواندن…" : "هنوز معاملهٔ تکمیل‌شده‌ای در دفتر نیست."}
            </p>
          )}
        </div>
      </section>

      {/* ── session headline ─────────────────────────────────────────────── */}
      <section className="panel sa-panel" aria-label="خلاصه نشست">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title sa-panel-title">خلاصه نشست</h3>
        </div>
        <div className="panel-body">
          <dl className="sa-ad-summary">
            <div>
              <dt>نشست</dt>
              <dd>
                {session ? (
                  <>
                    {session.name}{" "}
                    <span
                      className={`sa-chip sa-chip-sm sa-chip-${
                        session.status === "RUNNING"
                          ? "good"
                          : session.status === "PAUSED"
                            ? "warn"
                            : "muted"
                      }`}
                    >
                      {SESSION_STATUS_FA[session.status] ?? session.status}
                    </span>
                  </>
                ) : (
                  "نشستی وجود ندارد"
                )}
              </dd>
            </div>
            <div>
              <dt>اجراشده · رد‌شده</dt>
              <dd>
                <Bidi>
                  {toFaDigits(filledCount)} · {toFaDigits(skippedCount)}
                </Bidi>
              </dd>
            </div>
            <div>
              <dt>چرخه‌های ثبت‌شده</dt>
              <dd>
                <Bidi>{toFaDigits(cycleSummaries.length)}</Bidi>
              </dd>
            </div>
          </dl>
        </div>
      </section>

      {/* ── recorded decisions ───────────────────────────────────────────── */}
      <section className="panel sa-panel" aria-label="تصمیم‌های ثبت‌شده">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title sa-panel-title">تصمیم‌های ثبت‌شده</h3>
          <div className="sa-panel-note">
            <Bidi>
              {toFaDigits(filtered.length)} از {toFaDigits(ledger.length)}
            </Bidi>
          </div>
        </div>

        <div className="panel-body sa-ad-filters">
          <label className="sa-field">
            <span className="sa-field-label">صرافی</span>
            <select
              className="sa-control"
              value={venue}
              onChange={(e) => setFilter({ av: e.target.value })}
            >
              <option value="all">همه</option>
              {venues.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="sa-field">
            <span className="sa-field-label">نتیجه</span>
            <select
              className="sa-control"
              value={outcome}
              onChange={(e) => setFilter({ ao: e.target.value })}
            >
              <option value="all">همه</option>
              <option value="FILLED">اجراشده</option>
              <option value="SKIPPED">ردشده</option>
            </select>
          </label>
          <label className="sa-field">
            <span className="sa-field-label">دلیل رد</span>
            <select
              className="sa-control"
              value={reason}
              onChange={(e) => setFilter({ ar: e.target.value })}
            >
              <option value="all">همه</option>
              {reasons.map(([code, n]) => (
                <option key={code} value={code}>
                  {`${reasonLabel(code)} (${n})`}
                </option>
              ))}
            </select>
          </label>
          <label className="sa-field">
            <span className="sa-field-label">بازه</span>
            <select
              className="sa-control"
              value={window}
              onChange={(e) => setFilter({ aw: e.target.value })}
            >
              {WINDOWS.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.labelFa}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="panel-body">
          {shown.length ? (
            <>
              <div className="sa-table-wrap sa-ad-desktop">
                <table className="sa-table">
                  <thead>
                    <tr>
                      <th scope="col">زمان</th>
                      <th scope="col">مسیر</th>
                      <th scope="col">نتیجه</th>
                      <th scope="col" className="num">حجم</th>
                      <th scope="col">دلیل</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.id}>
                        <td>{formatTehran(r.occurredAt)}</td>
                        <td>
                          {r.buySourceId} ← {r.sellSourceId}
                        </td>
                        <td>
                          <span
                            className={`sa-chip sa-chip-sm sa-chip-${
                              r.outcome === "FILLED" ? "good" : "muted"
                            }`}
                          >
                            {r.outcome === "FILLED" ? "اجراشده" : "ردشده"}
                          </span>
                        </td>
                        <td className="num">
                          <Bidi>{toFaDigits(r.sizeUsdt.toFixed(4))}</Bidi>
                        </td>
                        <td className="sa-sub">
                          {r.outcome === "FILLED"
                            ? (r.sizingReason ?? "—")
                            : (r.rejectionReason ?? reasonLabel(r.rejectionCode ?? ""))}
                          {r.bindingConstraint ? (
                            <>
                              <br />
                              محدودکننده: {r.bindingConstraint}
                            </>
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
            <p className="sa-sub">
              {loading
                ? "در حال خواندن…"
                : ledger.length
                  ? "هیچ ردیفی با این فیلترها مطابقت ندارد."
                  : "هنوز هیچ تصمیمی ثبت نشده است."}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
