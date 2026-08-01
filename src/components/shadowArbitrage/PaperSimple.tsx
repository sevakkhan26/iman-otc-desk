"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { TomanAmount } from "@/components/TomanAmount";
import { formatTehran } from "@/components/format";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { Kpi, Pager } from "@/components/shadowArbitrage/panelKit";
import {
  formatCountFa,
  formatPercentFa,
  toFaDigits
} from "@/components/shadowArbitrage/labels";
import { paginate, OPPORTUNITY_PAGE_SIZES } from "@/components/shadowArbitrage/opportunityModel";
import {
  defaultAllocation,
  summarisePortfolio,
  validateAllocation,
  type VenueAllocation
} from "@/lib/shadowArbitrage/paper/portfolio";
import { usdtToMicros } from "@/lib/shadowArbitrage/paper/broker";

/* ── payload shapes, only what this view reads ─────────────────────────────── */

type Session = {
  id: string;
  name: string;
  status: string;
  mode: string;
  totalCapitalToman: number;
  valuationPriceToman: number;
  openingAllocations: VenueAllocation[];
  startedAt: string | null;
  createdBy: string;
};

type Trade = {
  id: string;
  outcome: "FILLED" | "SKIPPED";
  buySourceId: string;
  sellSourceId: string;
  sizeUsdt: number;
  buyVwapToman: number | null;
  sellVwapToman: number | null;
  buyFeeBps: number | null;
  sellFeeBps: number | null;
  feeTomanTotal: number | null;
  feeUsdtMicrosTotal: number | null;
  sellFeeValueToman: number | null;
  economicNetPnlToman: number | null;
  riskAdjustedPnlToman: number | null;
  rejectionReason: string | null;
  occurredAt: string;
};

type Balance = { sourceId: string; irtToman: number; usdt: number };

type Wizard = {
  markPriceToman: number | null;
  eligibleVenues: Array<{ sourceId: string; nameFa: string }>;
  capitalPlan: {
    id: string;
    name: string;
    totalCapitalToman: number;
    createdAt: string;
    allocations: VenueAllocation[];
  } | null;
};

type Payload = {
  realOrders: boolean;
  paperBannerFa: string;
  session: Session | null;
  balances: Balance[];
  trades: Trade[];
  transitions: Trade[];
  stats: { filled: number; skipped: number } | null;
  wizard?: Wizard;
  message?: string;
};

const TARGET_CAPITAL_TOMAN = 10_000_000_000;

const STATUS_FA: Record<string, string> = {
  NOT_STARTED: "شروع‌نشده",
  RUNNING: "در حال اجرا",
  PAUSED: "متوقف موقت",
  STOPPED: "پایان‌یافته"
};

/**
 * The plain paper-trading view.
 *
 * It answers three questions and hides everything else: how is the portfolio
 * doing, what did it trade, and how do I start a new virtual session from the
 * capital plan. Policies, gates, leases and raw calculations live behind
 * «جزئیات پیشرفته» — they matter, but not on the first screen.
 *
 * A capital plan and a paper session are deliberately different things here: the
 * plan is the intended split of virtual money, the session is a run that used a
 * snapshot of one. The header always says which snapshot a session came from.
 */
export function PaperSimple({ advanced }: { advanced?: React.ReactNode }) {
  const [data, setData] = useState<Payload | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/shadow-arbitrage/paper", {
        cache: "no-store",
        credentials: "same-origin"
      });
      if (!res.ok) return;
      setData((await res.json()) as Payload);
    } catch {
      /* the panel keeps its last good picture */
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  const session = data?.session ?? null;
  const wizard = data?.wizard ?? null;

  /* ── the three-step creation flow ───────────────────────────────────────── */

  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  const [capital, setCapital] = useState<number>(TARGET_CAPITAL_TOMAN);
  const [rows, setRows] = useState<VenueAllocation[]>([]);

  const markPrice = wizard?.markPriceToman ?? null;
  const venueName = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of wizard?.eligibleVenues ?? []) map.set(v.sourceId, v.nameFa);
    return map;
  }, [wizard]);

  const startWizard = () => {
    if (!wizard || !markPrice) return;
    setCapital(wizard.capitalPlan?.totalCapitalToman ?? TARGET_CAPITAL_TOMAN);
    setRows([]);
    setStep(1);
  };

  /** The offered default — proposed on screen, never saved until step 3. */
  const proposeDefault = () => {
    if (!markPrice) return;
    setRows(
      defaultAllocation(
        capital,
        (wizard?.eligibleVenues ?? []).map((v) => v.sourceId),
        markPrice
      )
    );
  };

  const validation = useMemo(() => {
    if (!markPrice || !rows.length) return null;
    return validateAllocation({
      totalCapitalToman: capital,
      allocations: rows,
      markPriceToman: markPrice,
      eligibleVenueIds: (wizard?.eligibleVenues ?? []).map((v) => v.sourceId)
    });
  }, [capital, rows, markPrice, wizard]);

  const act = async (body: Record<string, unknown>, okFa: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/shadow-arbitrage/paper", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body)
      });
      const j = (await res.json().catch(() => null)) as { message?: string } | null;
      if (!res.ok) throw new Error(j?.message ?? "عملیات ناموفق بود");
      setNotice(okFa);
      await load();
      return true;
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "عملیات ناموفق بود");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const createSession = async () => {
    if (!validation?.ok) return;
    const ok = await act(
      {
        action: "create",
        mode: "PROVISIONAL_EVALUATION",
        name: `نشست موقت ${Math.round(capital / 1_000_000_000)} میلیاردی`,
        totalCapitalToman: capital,
        allocations: rows
      },
      "نشست کاغذی جدید ساخته شد. تا زمانی که آن را شروع نکنید هیچ ارزیابی‌ای انجام نمی‌شود."
    );
    if (ok) setStep(0);
  };

  /* ── summary ─────────────────────────────────────────────────────────────── */

  const summary = useMemo(() => {
    if (!session) return null;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    return summarisePortfolio({
      initialCapitalToman: session.totalCapitalToman,
      balances: (data?.balances ?? []).map((b) => ({
        sourceId: b.sourceId as never,
        irtToman: b.irtToman,
        usdtMicros: usdtToMicros(b.usdt)
      })),
      markPriceToman: markPrice ?? session.valuationPriceToman ?? null,
      fills: (data?.trades ?? []).map((t) => ({
        economicNetPnlToman: t.economicNetPnlToman,
        riskAdjustedPnlToman: t.riskAdjustedPnlToman,
        occurredAt: t.occurredAt
      })),
      rejectedCount: data?.stats?.skipped ?? 0,
      todayStartMs: todayStart.getTime()
    });
  }, [session, data, markPrice]);

  /* ── ledger ──────────────────────────────────────────────────────────────── */

  const [ledgerOutcome, setLedgerOutcome] = useState<"FILLED" | "SKIPPED" | "ALL">("FILLED");
  const [ledgerVenue, setLedgerVenue] = useState("all");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<number>(20);

  const ledgerRows = useMemo(() => {
    const all = [...(data?.trades ?? []), ...(data?.transitions ?? [])];
    return all
      .filter((t) => (ledgerOutcome === "ALL" ? true : t.outcome === ledgerOutcome))
      .filter((t) =>
        ledgerVenue === "all" ? true : t.buySourceId === ledgerVenue || t.sellSourceId === ledgerVenue
      )
      .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  }, [data, ledgerOutcome, ledgerVenue]);

  const ledgerPage = useMemo(() => paginate(ledgerRows, page, perPage), [ledgerRows, page, perPage]);

  const name = (id: string) => venueName.get(id) ?? id;

  return (
    <div className="sa-stack">
      <div className="sa-callout sa-callout-muted" role="status">
        {data?.paperBannerFa ?? "اجرای کاغذی — هیچ سفارش یا انتقال واقعی انجام نمی‌شود"} · موجودی‌ها
        مجازی‌اند
      </div>

      {notice ? <div className="sa-callout sa-callout-muted">{notice}</div> : null}

      {/* ── current session identity ─────────────────────────────────────── */}
      <section className="panel sa-panel" aria-label="نشست اجرای کاغذی">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title">نشست اجرای کاغذی</h3>
          <div className="sa-panel-note">
            {session
              ? `${STATUS_FA[session.status] ?? session.status} · سرمایهٔ اولیه ${session.totalCapitalToman.toLocaleString("fa-IR")} تومان`
              : "نشستی وجود ندارد"}
          </div>
        </div>
        <div className="panel-body sa-stack-2">
          {session ? (
            <>
              <div className="sa-sub">
                نام نشست: <strong>{session.name}</strong> · شناسه:{" "}
                <Bidi>{session.id.slice(0, 8)}</Bidi>
              </div>
              <div className="sa-sub">
                برگرفته از طرح سرمایه با قیمت مبنای{" "}
                <Bidi>{session.valuationPriceToman.toLocaleString("fa-IR")}</Bidi> تومان و{" "}
                {toFaDigits(session.openingAllocations.length)} صرافی. طرح سرمایه و نشست دو چیز
                جدا هستند: طرح، تقسیم پول مجازی است و نشست، اجرایی است که از یک نسخهٔ ثبت‌شدهٔ آن
                استفاده می‌کند.
              </div>
              <div className="sa-sub">
                این نشست مجازی، موقت و غیرنهایی است؛ هیچ سفارش واقعی ثبت نمی‌شود.
              </div>
            </>
          ) : (
            <div className="sa-sub">هنوز نشستی ساخته نشده است.</div>
          )}

          <div className="sa-op-card-foot">
            {step === 0 ? (
              <button
                type="button"
                className="sa-btn-details glass-control"
                disabled={busy || !wizard || !markPrice}
                onClick={startWizard}
              >
                ساخت نشست ۱۰ میلیاردی از طرح فعلی
              </button>
            ) : null}
            {session && session.status === "RUNNING" ? (
              <button
                type="button"
                className="sa-btn-clear glass-control"
                disabled={busy}
                onClick={() =>
                  void act(
                    { action: "stop", sessionId: session.id },
                    "نشست پایان یافت و به‌عنوان سابقه نگه داشته شد؛ دفترهای آن دست‌نخورده باقی می‌ماند."
                  )
                }
              >
                پایان‌دادن نشست فعلی (حفظ سابقه)
              </button>
            ) : null}
            {session && session.status === "NOT_STARTED" ? (
              <button
                type="button"
                className="sa-btn-clear glass-control"
                disabled={busy}
                onClick={() => void act({ action: "start", sessionId: session.id }, "نشست شروع شد.")}
              >
                شروع ارزیابی
              </button>
            ) : null}
          </div>
        </div>
      </section>

      {/* ── the three-step flow ──────────────────────────────────────────── */}
      {step > 0 ? (
        <section className="panel sa-panel" aria-label="ساخت نشست جدید">
          <div className="panel-header sa-panel-header">
            <h3 className="panel-title">
              گام {toFaDigits(step)} از ۳ —{" "}
              {step === 1 ? "سرمایهٔ کل" : step === 2 ? "تخصیص بین صرافی‌ها" : "بازبینی و ساخت"}
            </h3>
            <button type="button" className="sa-btn-clear glass-control" onClick={() => setStep(0)}>
              انصراف
            </button>
          </div>

          {step === 1 ? (
            <div className="panel-body sa-form-grid">
              <label className="sa-field">
                <span className="sa-field-label">سرمایهٔ کل مجازی (تومان)</span>
                <input
                  className="sa-control glass-control"
                  inputMode="numeric"
                  value={String(capital)}
                  onChange={(e) => setCapital(Math.max(0, Number(e.target.value.replace(/\D/g, "")) || 0))}
                />
              </label>
              <div className="sa-sub">
                این عدد کل پرتفوی مجازی است، نه اندازهٔ هر معامله. اندازهٔ هر معامله همچنان با عمق
                فرصت، موجودی مجازی همان صرافی و حدود ریسک محدود می‌شود.
              </div>
              <button
                type="button"
                className="sa-btn-details glass-control"
                onClick={() => {
                  proposeDefault();
                  setStep(2);
                }}
                disabled={!markPrice || capital <= 0}
              >
                ادامه به تخصیص
              </button>
            </div>
          ) : null}

          {step === 2 ? (
            <>
              <div className="panel-body sa-stack-2">
                <div className="sa-sub">
                  پیشنهاد پیش‌فرض: سهم برابر برای هر صرافی و در هر صرافی نیمی تومان و نیمی تتر، با
                  قیمت مبنای <Bidi>{markPrice?.toLocaleString("fa-IR")}</Bidi> تومان در همین لحظه.
                  این پیشنهاد تا زمانی که در گام سوم تأیید نکنید ذخیره نمی‌شود.
                </div>
                <div className="sa-chips">
                  <button type="button" className="sa-btn-clear glass-control" onClick={proposeDefault}>
                    اعمال پیشنهاد پیش‌فرض
                  </button>
                </div>
              </div>
              <div className="panel-body sa-table-wrap">
                <table className="sa-table">
                  <thead>
                    <tr>
                      <th scope="col">صرافی</th>
                      <th scope="col" className="num">تومان</th>
                      <th scope="col" className="num">تتر</th>
                      <th scope="col" className="num">ارزش کل</th>
                      <th scope="col" className="num">سهم</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => {
                      const v = validation?.perVenue[index];
                      return (
                        <tr key={row.sourceId}>
                          <td>{name(row.sourceId)}</td>
                          <td className="num">
                            <input
                              className="sa-control glass-control"
                              inputMode="numeric"
                              value={String(row.irtToman)}
                              onChange={(e) => {
                                const next = [...rows];
                                next[index] = {
                                  ...row,
                                  irtToman: Math.max(0, Number(e.target.value.replace(/\D/g, "")) || 0)
                                };
                                setRows(next);
                              }}
                            />
                          </td>
                          <td className="num">
                            <input
                              className="sa-control glass-control"
                              inputMode="decimal"
                              value={String(row.usdtUnits)}
                              onChange={(e) => {
                                const next = [...rows];
                                next[index] = {
                                  ...row,
                                  usdtUnits: Math.max(0, Number(e.target.value) || 0)
                                };
                                setRows(next);
                              }}
                            />
                          </td>
                          <td className="num">
                            {v ? <TomanAmount value={v.valueToman} /> : "—"}
                          </td>
                          <td className="num">
                            <Bidi>{v ? formatPercentFa(v.sharePercent, 2) : "—"}</Bidi>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="panel-body sa-stack-2">
                <div className={validation?.ok ? "sa-sub" : "sa-sub sa-neg"}>
                  مجموع تخصیص:{" "}
                  {validation ? <TomanAmount value={validation.allocatedToman} /> : "—"} · باقی‌مانده:{" "}
                  {validation ? <TomanAmount value={validation.residualToman} /> : "—"}
                </div>
                {validation && !validation.ok ? (
                  <div className="sa-callout sa-callout-warn">{validation.errorsFa.join(" ")}</div>
                ) : null}
                <div className="sa-chips">
                  <button type="button" className="sa-btn-clear glass-control" onClick={() => setStep(1)}>
                    بازگشت
                  </button>
                  <button
                    type="button"
                    className="sa-btn-details glass-control"
                    disabled={!validation?.ok}
                    onClick={() => setStep(3)}
                  >
                    ادامه به بازبینی
                  </button>
                </div>
              </div>
            </>
          ) : null}

          {step === 3 ? (
            <div className="panel-body sa-stack-2">
              <div className="sa-sub">
                سرمایهٔ کل: <TomanAmount value={capital} /> · قیمت مبنا:{" "}
                <Bidi>{markPrice?.toLocaleString("fa-IR")}</Bidi> تومان ·{" "}
                {toFaDigits(rows.length)} صرافی · باقی‌مانده:{" "}
                {validation ? <TomanAmount value={validation.residualToman} /> : "—"}
              </div>
              <div className="sa-sub">
                با تأیید، یک نشست کاغذی <strong>مجازی، موقت و غیرنهایی</strong> ساخته می‌شود. نشست
                فعلی و دفترهای آن تغییر نمی‌کنند و به‌عنوان سابقه باقی می‌مانند. هیچ سفارش یا انتقال
                واقعی انجام نمی‌شود و تأیید فاز ۵ به‌صورت خودکار صادر نمی‌گردد.
              </div>
              <div className="sa-chips">
                <button type="button" className="sa-btn-clear glass-control" onClick={() => setStep(2)}>
                  بازگشت
                </button>
                <button
                  type="button"
                  className="sa-btn-details glass-control"
                  disabled={busy || !validation?.ok}
                  onClick={() => void createSession()}
                >
                  ساخت نشست کاغذی
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* ── summary ──────────────────────────────────────────────────────── */}
      {summary ? (
        <div className="sa-kpi-grid">
          <Kpi
            label="سرمایهٔ اولیه"
            value={<TomanAmount value={summary.initialCapitalToman} />}
            hint="کل پرتفوی مجازی این نشست"
            tone="muted"
          />
          <Kpi
            label="ارزش فعلی"
            value={
              summary.markedValueToman === null ? (
                <span className="sa-unknown" title="قیمت مبنا در دسترس نیست">—</span>
              ) : (
                <TomanAmount value={summary.markedValueToman} />
              )
            }
            hint={
              summary.roiPercent === null
                ? "بدون قیمت مبنا محاسبه نمی‌شود"
                : `بازده: ${formatPercentFa(summary.roiPercent, 2, true)}`
            }
            tone={summary.roiPercent !== null && summary.roiPercent > 0 ? "good" : "muted"}
          />
          <Kpi
            label="سود خالص اقتصادی"
            value={<TomanAmount value={summary.economicPnlToman} />}
            hint={`تعدیل‌شده با بافر: ${summary.riskAdjustedPnlToman.toLocaleString("fa-IR")} · امروز: ${summary.todayPnlToman.toLocaleString("fa-IR")}`}
            tone={summary.economicPnlToman > 0 ? "good" : summary.economicPnlToman < 0 ? "warn" : "muted"}
          />
          <Kpi
            label="معاملات"
            value={
              <Bidi>{`${toFaDigits(summary.filled)} / ${toFaDigits(summary.filled + summary.rejected)}`}</Bidi>
            }
            hint={`رد‌شده: ${formatCountFa(summary.rejected)} · بیشترین افت: ${summary.drawdownToman.toLocaleString("fa-IR")} تومان · آخرین معامله: ${
              summary.lastTradeAt ? formatTehran(summary.lastTradeAt) : "—"
            }`}
            tone="muted"
          />
        </div>
      ) : null}

      {/* ── ledger ───────────────────────────────────────────────────────── */}
      {session ? (
        <section className="panel sa-panel" aria-label="دفتر معاملات">
          <div className="panel-header sa-panel-header">
            <h3 className="panel-title">دفتر معاملات</h3>
            <div className="sa-panel-note">{formatCountFa(ledgerRows.length)} رکورد</div>
          </div>

          <div className="panel-body sa-filter-body">
            <label className="sa-field">
              <span className="sa-field-label">نوع رکورد</span>
              <select
                className="sa-control glass-control"
                value={ledgerOutcome}
                onChange={(e) => {
                  setLedgerOutcome(e.target.value as never);
                  setPage(1);
                }}
              >
                <option value="FILLED">انجام‌شده</option>
                <option value="SKIPPED">رد‌شده</option>
                <option value="ALL">همه</option>
              </select>
            </label>
            <label className="sa-field">
              <span className="sa-field-label">صرافی</span>
              <select
                className="sa-control glass-control"
                value={ledgerVenue}
                onChange={(e) => {
                  setLedgerVenue(e.target.value);
                  setPage(1);
                }}
              >
                <option value="all">همهٔ صرافی‌ها</option>
                {(wizard?.eligibleVenues ?? []).map((v) => (
                  <option key={v.sourceId} value={v.sourceId}>
                    {v.nameFa}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="panel-body sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th scope="col">صرافی خرید</th>
                  <th scope="col">صرافی فروش</th>
                  <th scope="col" className="num">حجم</th>
                  <th scope="col" className="num">قیمت خرید / فروش</th>
                  <th scope="col" className="num">کارمزد تومانی خرید</th>
                  <th scope="col" className="num">کارمزد تتری فروش</th>
                  <th scope="col" className="num">سود خالص اقتصادی</th>
                  <th scope="col" className="num">سود تعدیل‌شده</th>
                  <th scope="col">وضعیت و زمان</th>
                </tr>
              </thead>
              <tbody>
                {ledgerPage.rows.map((t) => (
                  <tr key={t.id}>
                    <td>{name(t.buySourceId)}</td>
                    <td>{name(t.sellSourceId)}</td>
                    <td className="num">{toFaDigits(t.sizeUsdt)} تتر</td>
                    <td className="num">
                      <div className="sa-stack-2">
                        {t.buyVwapToman !== null ? <TomanAmount value={t.buyVwapToman} /> : "—"}
                        <span className="sa-sub">
                          {t.sellVwapToman !== null ? <TomanAmount value={t.sellVwapToman} /> : "—"}
                        </span>
                      </div>
                    </td>
                    <td className="num">
                      {t.feeTomanTotal !== null ? <TomanAmount value={t.feeTomanTotal} /> : "—"}
                    </td>
                    <td className="num">
                      <div className="sa-stack-2">
                        <Bidi>
                          {t.feeUsdtMicrosTotal !== null
                            ? `${toFaDigits((t.feeUsdtMicrosTotal / 1_000_000).toFixed(6))} تتر`
                            : "—"}
                        </Bidi>
                        <span className="sa-sub">
                          {t.sellFeeValueToman !== null ? (
                            <TomanAmount value={t.sellFeeValueToman} />
                          ) : (
                            "—"
                          )}
                        </span>
                      </div>
                    </td>
                    <td className="num">
                      {t.economicNetPnlToman !== null ? (
                        <TomanAmount value={t.economicNetPnlToman} />
                      ) : (
                        <span className="sa-unknown" title="این رکورد اجرا نشده است">—</span>
                      )}
                    </td>
                    <td className="num">
                      {t.riskAdjustedPnlToman !== null ? (
                        <TomanAmount value={t.riskAdjustedPnlToman} />
                      ) : (
                        <span className="sa-unknown" title="این رکورد اجرا نشده است">—</span>
                      )}
                    </td>
                    <td>
                      <div className="sa-stack-2">
                        <span
                          className={`sa-chip sa-chip-sm sa-chip-${t.outcome === "FILLED" ? "good" : "muted"}`}
                        >
                          {t.outcome === "FILLED" ? "انجام‌شده" : "رد‌شده"}
                        </span>
                        <span className="sa-sub">{formatTehran(t.occurredAt)}</span>
                        {t.rejectionReason ? (
                          <span className="sa-sub">{t.rejectionReason}</span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pager
            page={ledgerPage.page}
            pageCount={ledgerPage.pageCount}
            total={ledgerPage.total}
            from={ledgerPage.from}
            to={ledgerPage.to}
            perPage={perPage}
            pageSizes={OPPORTUNITY_PAGE_SIZES}
            onPage={setPage}
            onPerPage={(n) => {
              setPerPage(n);
              setPage(1);
            }}
          />
        </section>
      ) : null}

      {/* ── everything technical, folded away ────────────────────────────── */}
      {advanced ? (
        <details className="panel sa-panel sa-advanced-details">
          <summary className="panel-header sa-panel-header">
            <span className="panel-title">جزئیات پیشرفته</span>
          </summary>
          <div className="panel-body">{advanced}</div>
        </details>
      ) : null}
    </div>
  );
}
