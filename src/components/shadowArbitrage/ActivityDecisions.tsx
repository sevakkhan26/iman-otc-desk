"use client";

/**
 * «فعالیت‌ها» — readable Persian decision summaries + completed trade evidence.
 *
 * Strictly read-only. Never invents values. Missing fields are omitted (or one
 * concise Persian note), never raw keys or null dumps in the operator view.
 */
import { useMemo, useState, type ReactNode } from "react";
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
  experimentContext?: {
    experimentId?: string | null;
    policyFingerprint?: string | null;
    releaseVersion?: string | null;
  } | null;
  minRiskAdjustedEdgePercent?: number | null;
};

const DASH = <span className="sa-unknown">—</span>;
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

function constraintFa(key: string | null | undefined): string | null {
  if (!key) return null;
  const known = SIZING_CONSTRAINT_FA[key as SizingConstraintKey];
  if (known) return known;
  // Already-Persian free text or unknown code — show as-is if looks Persian-ish.
  if (/[\u0600-\u06FF]/.test(key)) return key;
  return reasonLabel(key);
}

function PresentField({
  label,
  children
}: {
  label: string;
  children: ReactNode | null | undefined;
}) {
  if (children === null || children === undefined || children === false) return null;
  return (
    <div className="sa-why-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Group({
  title,
  children
}: {
  title: string;
  children: ReactNode;
}) {
  // Only render the group if at least one field rendered.
  const items = Array.isArray(children) ? children.filter(Boolean) : [children].filter(Boolean);
  if (!items.length) return null;
  return (
    <div className="sa-why-group">
      <h4 className="sa-why-group-title">{title}</h4>
      <dl className="sa-why-grid">{items}</dl>
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

  let grossSpread: number | null = null;
  if (quote) {
    grossSpread = quote.sellVwapToman - quote.buyVwapToman;
  }

  const riskAdj = econ?.riskAdjustedPnlToman ?? null;
  const economicNet = econ?.economicNetPnlToman ?? null;
  let minRequired: number | null = null;
  let shortfall: number | null = null;
  if (
    minEdgePct != null &&
    Number.isFinite(minEdgePct) &&
    econ?.capitalInvolvedToman != null &&
    Number.isFinite(econ.capitalInvolvedToman)
  ) {
    minRequired = (minEdgePct / 100) * econ.capitalInvolvedToman;
    if (riskAdj != null) shortfall = Math.max(0, minRequired - riskAdj);
  }

  const bindingFa = constraintFa(s.bindingConstraint);
  const blockerFa =
    s.blockers?.[0]?.detailFa ??
    (s.blockers?.length ? s.blockers.map((b) => b.detailFa).filter(Boolean).join(" · ") : null);
  const selectionFa = s.selection?.reasonFa ?? null;

  const rejectionFa =
    blockerFa ||
    selectionFa ||
    (s.blockers?.[0]?.code ? reasonLabel(s.blockers[0].code) : null) ||
    "مسیر در این چرخه حجم نگرفت";

  const headline = isSized
    ? `معامله انجام شد چون ${
        selectionFa ??
        (s.sizeUsdt != null
          ? `حجم ${toFaDigits(s.sizeUsdt.toFixed(4))} تتر روی مسیر ${r.buySourceId} ← ${r.sellSourceId} پذیرفته شد`
          : `مسیر ${r.buySourceId} ← ${r.sellSourceId} حجم‌گرفت`)
      }${bindingFa ? ` · محدودکننده: ${bindingFa}` : ""}.`
    : `معامله انجام نشد چون ${rejectionFa}${
        shortfall != null && shortfall > 0
          ? ` · کسری سود نسبت به حداقل لازم حدود ${toFaDigits(Math.round(shortfall).toLocaleString("en-US"))} تومان`
          : ""
      }.`;

  const missingNotes: string[] = [];
  if (!quote) missingNotes.push("قیمت میانگین (VWAP) این مسیر در sizing ثبت نشده");
  if (!econ) missingNotes.push("جزئیات اقتصادی (کارمزد/خالص) این مسیر در sizing ثبت نشده");
  if (buyAge?.ageMs == null && sellAge?.ageMs == null) {
    missingNotes.push("سن دادهٔ صرافی‌ها در این payload نیست");
  }

  return (
    <article className="sa-why-card panel sa-panel">
      <p className={`sa-why-headline ${isSized ? "is-ok" : "is-no"}`}>{headline}</p>

      <Group title="مسیر">
        <PresentField label="خرید از">{r.buySourceId}</PresentField>
        <PresentField label="فروش به">{r.sellSourceId}</PresentField>
      </Group>

      <Group title="دادهٔ بازار">
        <PresentField label="سن دادهٔ خرید">
          {buyAge?.ageMs != null ? (
            <Bidi>{toFaDigits(Math.round(buyAge.ageMs / 1000))} ثانیه</Bidi>
          ) : null}
        </PresentField>
        <PresentField label="سن دادهٔ فروش">
          {sellAge?.ageMs != null ? (
            <Bidi>{toFaDigits(Math.round(sellAge.ageMs / 1000))} ثانیه</Bidi>
          ) : null}
        </PresentField>
        <PresentField label="قیمت میانگین خرید">
          {quote ? <TomanAmount value={quote.buyVwapToman} /> : null}
        </PresentField>
        <PresentField label="قیمت میانگین فروش">
          {quote ? <TomanAmount value={quote.sellVwapToman} /> : null}
        </PresentField>
        <PresentField label="اختلاف قیمت (هر تتر)">
          {grossSpread != null ? <TomanAmount value={grossSpread} /> : null}
        </PresentField>
        <PresentField label="لغزش">
          {quote ? (
            <Bidi>
              خرید {toFaDigits(quote.buySlippageBps)} bps · فروش{" "}
              {toFaDigits(quote.sellSlippageBps)} bps
            </Bidi>
          ) : null}
        </PresentField>
      </Group>

      <Group title="حجم و محدودیت">
        <PresentField label="حجم انتخاب‌شده">
          {s.sizeUsdt != null ? (
            <Bidi>{toFaDigits(s.sizeUsdt.toFixed(4))} تتر</Bidi>
          ) : null}
        </PresentField>
        <PresentField label="سقف امن">
          {ceiling != null ? (
            <Bidi>{toFaDigits(ceiling.toFixed(4))} تتر</Bidi>
          ) : null}
        </PresentField>
        <PresentField label="محدودکننده">{bindingFa}</PresentField>
      </Group>

      <Group title="هزینه و سود">
        <PresentField label="کارمزد پای فروش (معادل تومان)">
          {econ ? <TomanAmount value={econ.sellFeeValueToman} /> : null}
        </PresentField>
        <PresentField label="بافر ریسک / لغزش">
          {econ?.slippageBufferToman != null ? (
            <TomanAmount value={econ.slippageBufferToman} />
          ) : null}
        </PresentField>
        <PresentField label="سود خالص اقتصادی">
          {economicNet != null ? <TomanAmount value={economicNet} /> : null}
        </PresentField>
        <PresentField label="سود تعدیل‌شده ریسک">
          {riskAdj != null ? <TomanAmount value={riskAdj} /> : null}
        </PresentField>
        <PresentField label="حداقل سود لازم">
          {minRequired != null ? <TomanAmount value={minRequired} /> : null}
        </PresentField>
        <PresentField label="کسری نسبت به حداقل">
          {!isSized && shortfall != null && shortfall > 0 ? (
            <TomanAmount value={shortfall} />
          ) : null}
        </PresentField>
      </Group>

      <Group title="تصمیم نهایی">
        <PresentField label="نتیجه">
          {isSized ? "قابل اجرا در این چرخه" : "رد / مسدود"}
        </PresentField>
        <PresentField label="دلیل">
          {isSized ? selectionFa ?? "حجم پذیرفته شد" : rejectionFa}
        </PresentField>
      </Group>

      {missingNotes.length ? (
        <p className="sa-why-missing">
          برخی جزئیات ثبت نشده: {missingNotes.slice(0, 2).join("؛ ")}.
        </p>
      ) : null}

      <details className="sa-why-advanced sa-advanced-details">
        <summary>جزئیات فنی</summary>
        <dl className="sa-why-grid">
          <PresentField label="کلید مسیر">
            <code className="sa-ps-key">{r.routeKey}</code>
          </PresentField>
          <PresentField label="وضعیت sizing">{s.status}</PresentField>
          <PresentField label="سیاست">{s.policy}</PresentField>
          <PresentField label="کد محدودکنندهٔ خام">{s.bindingConstraint}</PresentField>
          {s.blockers?.map((b, i) => (
            <PresentField key={`${b.code}-${i}`} label={`مانع ${toFaDigits(i + 1)}`}>
              {b.code ? `${reasonLabel(b.code)} — ` : ""}
              {b.detailFa}
            </PresentField>
          ))}
          <PresentField label="چرا بزرگ‌تر نه">
            {s.selection?.nextLarger
              ? `${s.selection.nextLarger.code} — ${s.selection.nextLarger.detailFa}`
              : null}
          </PresentField>
        </dl>
      </details>
    </article>
  );
}

function WhyLedgerCard({ r }: { r: ActivityLedgerRow }) {
  const isFilled = r.outcome === "FILLED";
  const bindingFa = constraintFa(r.bindingConstraint);
  const rejectFa =
    r.rejectionReason ||
    (r.rejectionCode ? reasonLabel(r.rejectionCode) : null) ||
    "دلیل رد در دفتر ثبت نشده";

  const headline = isFilled
    ? `معامله انجام شد چون ${
        r.sizingReason ||
        `معاملهٔ ${toFaDigits(r.sizeUsdt.toFixed(4))} تتری روی ${r.buySourceId} ← ${r.sellSourceId} در دفتر ثبت شد`
      }${bindingFa ? ` · محدودکننده: ${bindingFa}` : ""}.`
    : `معامله انجام نشد چون ${rejectFa}.`;

  const missing: string[] = [];
  if (r.buyVwapToman == null || r.sellVwapToman == null) {
    missing.push("قیمت میانگین دو پا");
  }
  if (r.economicNetPnlToman == null && isFilled) {
    missing.push("سود خالص اقتصادی");
  }

  return (
    <article className="sa-why-card panel sa-panel">
      <p className={`sa-why-headline ${isFilled ? "is-ok" : "is-no"}`}>{headline}</p>

      <Group title="مسیر">
        <PresentField label="خرید از">{r.buySourceId}</PresentField>
        <PresentField label="فروش به">{r.sellSourceId}</PresentField>
        <PresentField label="زمان">{formatTehran(r.occurredAt)}</PresentField>
      </Group>

      <Group title="دادهٔ بازار">
        <PresentField label="قیمت میانگین خرید">
          {r.buyVwapToman != null ? <TomanAmount value={r.buyVwapToman} /> : null}
        </PresentField>
        <PresentField label="قیمت میانگین فروش">
          {r.sellVwapToman != null ? <TomanAmount value={r.sellVwapToman} /> : null}
        </PresentField>
        <PresentField label="اسپرد / سود ناخالص">
          {r.grossSpreadToman != null ? <TomanAmount value={r.grossSpreadToman} /> : null}
        </PresentField>
      </Group>

      <Group title="حجم و محدودیت">
        <PresentField label="حجم">
          <Bidi>{toFaDigits(r.sizeUsdt.toFixed(4))} تتر</Bidi>
        </PresentField>
        <PresentField label="محدودکننده">{bindingFa}</PresentField>
        <PresentField label="سقف سرمایه">
          {r.capitalCapUsdtMicros != null ? (
            <Bidi>{toFaDigits(usdt(r.capitalCapUsdtMicros) ?? "")} تتر</Bidi>
          ) : null}
        </PresentField>
        <PresentField label="سقف عمق">
          {r.depthCapUsdtMicros != null ? (
            <Bidi>{toFaDigits(usdt(r.depthCapUsdtMicros) ?? "")} تتر</Bidi>
          ) : null}
        </PresentField>
      </Group>

      <Group title="هزینه و سود">
        <PresentField label="کارمزد تومان">
          {r.feeTomanTotal != null ? <TomanAmount value={r.feeTomanTotal} /> : null}
        </PresentField>
        <PresentField label="کارمزد فروش (معادل تومان)">
          {r.sellFeeValueToman != null ? (
            <TomanAmount value={r.sellFeeValueToman} />
          ) : null}
        </PresentField>
        <PresentField label="بافر ریسک">
          {r.slippageBufferToman != null ? (
            <TomanAmount value={r.slippageBufferToman} />
          ) : null}
        </PresentField>
        <PresentField label="سود خالص اقتصادی">
          {r.economicNetPnlToman != null ? (
            <TomanAmount value={r.economicNetPnlToman} />
          ) : null}
        </PresentField>
        <PresentField label="سود تعدیل‌شده">
          {r.riskAdjustedPnlToman != null ? (
            <TomanAmount value={r.riskAdjustedPnlToman} />
          ) : null}
        </PresentField>
      </Group>

      <Group title="تصمیم نهایی">
        <PresentField label="نتیجه">{isFilled ? "اجراشده" : "ردشده"}</PresentField>
        <PresentField label="دلیل">
          {isFilled ? r.sizingReason ?? "در دفتر ثبت شد" : rejectFa}
        </PresentField>
      </Group>

      {missing.length ? (
        <p className="sa-why-missing">
          برخی جزئیات این ردیف در دفتر نیست: {missing.join("، ")}.
        </p>
      ) : null}

      <details className="sa-why-advanced sa-advanced-details">
        <summary>جزئیات فنی</summary>
        <dl className="sa-why-grid">
          <PresentField label="شناسهٔ دفتر">
            <code className="sa-ps-key">{r.id}</code>
          </PresentField>
          <PresentField label="کلید مسیر">
            <code className="sa-ps-key">{r.routeKey}</code>
          </PresentField>
          <PresentField label="کد رد">{r.rejectionCode}</PresentField>
          <PresentField label="سیاست حجم">{r.sizingPolicy}</PresentField>
          <PresentField label="محدودکنندهٔ خام">{r.bindingConstraint}</PresentField>
        </dl>
      </details>
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

  const whyRoutes = routes.length
    ? [...routes].sort((a, b) => {
        const as = a.sizing.status === "SIZED" ? 0 : 1;
        const bs = b.sizing.status === "SIZED" ? 0 : 1;
        if (as !== bs) return as - bs;
        return (b.sizing.sizeUsdt ?? 0) - (a.sizing.sizeUsdt ?? 0);
      })
    : [];

  const latestLedger = useMemo(
    () =>
      [...ledger]
        .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
        .slice(0, 8),
    [ledger]
  );

  return (
    <div className="sa-stack">
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
                <WhyLedgerCard key={r.id} r={r} />
              ))}
            </div>
          ) : (
            <p className="sa-sub">هنوز مسیر یا تصمیمی برای توضیح وجود ندارد.</p>
          )}
        </div>
      </section>

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
                      <th className="num">قیمت میانگین</th>
                      <th className="num">خالص اقتصادی</th>
                      <th>زمان</th>
                      <th>وضعیت</th>
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
                              "قیمت ثبت نشده"
                            )}
                          </div>
                        </td>
                        <td>
                          {t.sellSourceId}
                          <div className="sa-sub">
                            {t.sellVwapToman != null ? (
                              <TomanAmount value={t.sellVwapToman} />
                            ) : (
                              "قیمت ثبت نشده"
                            )}
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
                            "ثبت نشده"
                          )}
                        </td>
                        <td className="sa-sub">{formatTehran(t.occurredAt)}</td>
                        <td className="sa-sub">تکمیل‌شده</td>
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
                      {formatTehran(t.occurredAt)}
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
                      <th scope="col" className="num">
                        حجم
                      </th>
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
                              محدودکننده: {constraintFa(r.bindingConstraint)}
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
