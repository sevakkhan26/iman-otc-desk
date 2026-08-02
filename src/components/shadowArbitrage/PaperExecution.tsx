"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { TomanAmount } from "@/components/TomanAmount";
import { formatTehran } from "@/components/format";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { Kpi, Pager } from "@/components/shadowArbitrage/panelKit";
import { formatCountFa, formatPercentFa, toFaDigits } from "@/components/shadowArbitrage/labels";
import { OPPORTUNITY_PAGE_SIZES, paginate } from "@/components/shadowArbitrage/opportunityModel";
import { readInt, useShadowViewState } from "@/components/shadowArbitrage/urlState";
import { CAP_LABEL_FA, VENUE_CAPACITY_REASON_FA } from "@/lib/shadowArbitrage/paper/liquidity";

/** Permanent, never hidden, never conditional. */
export const PAPER_BANNER_EN = "PAPER EXECUTION — NO REAL ORDERS OR TRANSFERS";

/* ── server DTOs, rendered as-is ──────────────────────────────────────────────
 *
 * Every figure below is computed on the server and displayed verbatim. This
 * component performs no capacity, VWAP, fee or PnL arithmetic: a second
 * implementation living in React would be a second answer, and the two would
 * diverge exactly when it mattered. A structural test enforces the rule.
 */

type Session = {
  id: string;
  observationId?: string | null;
  name: string;
  status: string;
  mode: string;
  startedAt: string | null;
};

type Stats = {
  filled: number;
  skipped: number;
  cashPnlIrtToman: number;
  inventoryDeltaUsdtMicros: number;
  sellFeeValueToman: number;
  economicNetPnlToman: number;
  riskAdjustedPnlToman: number;
  feeTomanTotal: number;
  feeUsdtTotal: number;
  opportunityCaptureRatePercent: number | null;
  lastFillAt: string | null;
};

type Trade = {
  id: string;
  lifecycleId: string;
  routeKey: string;
  outcome: "FILLED" | "SKIPPED";
  buySourceId: string;
  sellSourceId: string;
  sizeUsdt: number;
  buyVwapToman: number | null;
  sellVwapToman: number | null;
  buyFeeBps: number | null;
  sellFeeBps: number | null;
  buyFeeAsset: string | null;
  sellFeeAsset: string | null;
  markPriceToman: number | null;
  slippageBufferToman: number | null;
  cashPnlIrtToman: number | null;
  inventoryDeltaUsdtMicros: number | null;
  sellFeeValueToman: number | null;
  economicNetPnlToman: number | null;
  riskAdjustedPnlToman: number | null;
  rejectionCode: string | null;
  rejectionReason: string | null;
  reasonCodes: string[] | null;
  occurredAt: string;
};

type Candidate = {
  lifecycleId: string;
  routeKey: string;
  reason?: string | null;
  reasonCodes?: string[] | null;
  observationCount?: number;
};

type MatrixRow = {
  sourceId: string;
  nameFa: string;
  dataType: string;
  allocationRole: string | null;
  buyCapacityUsdtMicros: number | null;
  sellCapacityUsdtMicros: number | null;
  buyLimiter: string | null;
  sellLimiter: string | null;
  buyReason: string;
  sellReason: string;
  blockerFa: string | null;
};

type Payload = {
  realOrders: boolean;
  paperBannerFa: string;
  serverNow: string;
  session: Session | null;
  stats: Stats | null;
  balances: Array<{ sourceId: string; irtToman: number; usdt: number }>;
  trades: Trade[];
  transitions: Trade[];
  candidates: Candidate[];
  reasonBreakdown: Array<{ reason: string; count: number }>;
  cycleSummaries: Array<{
    occurredAt: string;
    evaluated?: number;
    filled?: number;
    skipped?: number;
  }>;
  sizing?: { venueSemantics?: { matrix: MatrixRow[] } };
  message?: string;
};

const STATUS_FA: Record<string, string> = {
  NOT_STARTED: "شروع‌نشده",
  RUNNING: "در حال اجرا",
  PAUSED: "متوقف موقت",
  STOPPED: "پایان‌یافته"
};

const MODE_FA: Record<string, string> = {
  PROVISIONAL_EVALUATION: "ارزیابی موقت",
  SHADOW: "سایه"
};

/** An unknown value is an em dash carrying its own reason, never a zero. */
function Unknown({ why }: { why: string }) {
  return (
    <span className="sa-unknown" title={why}>
      —
    </span>
  );
}

const PAPER_VIEWS = [
  { key: "balances", labelFa: "موجودی و ظرفیت" },
  { key: "fills", labelFa: "دفتر معاملات" },
  { key: "candidates", labelFa: "نامزدها و دلایل" },
  { key: "cycles", labelFa: "خلاصهٔ چرخه‌ها" }
] as const;

/**
 * Phase 8D-B — the Paper Execution tab.
 *
 * This replaces the previous layout in place; there is no second competing
 * panel. Every surface reuses the shared glass primitives — `.panel`,
 * `.glass-control`, `.glass-tabbar` — so Shadow never forks the OTC material
 * system, and the font is whatever the page inherits.
 *
 * Nothing here can trade. Mounting, reloading or deploying never creates,
 * starts or resumes a session: `pause` and `resume` are the only mutations, and
 * each needs an explicit confirmation first.
 */
export function PaperExecution() {
  const [data, setData] = useState<Payload | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Trade | null>(null);
  const [confirming, setConfirming] = useState<"pause" | "resume" | null>(null);

  const { read, write } = useShadowViewState();
  const view = read("pv", "balances");
  const query = read("pq", "");
  const outcome = read("pout", "ALL");
  const reason = read("preason", "");
  const perPage = readInt(read("pper", "20"), 20, 10, 50);
  const rawPage = readInt(read("ppage", "1"), 1, 1, 10_000);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/shadow-arbitrage/paper", {
        cache: "no-store",
        credentials: "same-origin"
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? "دریافت دادهٔ اجرای کاغذی ممکن نشد.");
        return;
      }
      setError(null);
      setData((await res.json()) as Payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطای غیرمنتظره در دریافت داده.");
    } finally {
      setLoading(false);
    }
  }, []);

  /*
   * Read-only polling. Mounting must never create, start or resume a session —
   * a deployment that silently began trading, even on paper, would be
   * indistinguishable from one that was told to.
   */
  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  const act = useCallback(
    async (action: "pause" | "resume", sessionId: string) => {
      setBusy(true);
      setNotice(null);
      try {
        const res = await fetch("/api/shadow-arbitrage/paper", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ action, sessionId })
        });
        const j = (await res.json().catch(() => null)) as { message?: string } | null;
        if (!res.ok) throw new Error(j?.message ?? "تغییر وضعیت ممکن نشد");
        setNotice(action === "pause" ? "نشست متوقف شد." : "نشست ادامه یافت.");
        await load();
      } catch (e) {
        setNotice(e instanceof Error ? e.message : "تغییر وضعیت ممکن نشد");
      } finally {
        setBusy(false);
        setConfirming(null);
      }
    },
    [load]
  );

  const session = data?.session ?? null;
  const stats = data?.stats ?? null;
  const matrix = data?.sizing?.venueSemantics?.matrix ?? [];
  const balanceById = useMemo(
    () => new Map((data?.balances ?? []).map((b) => [b.sourceId, b])),
    [data]
  );

  /** Fills and skips together, newest first. Both are evidence. */
  const ledger = useMemo(() => {
    const all = [...(data?.trades ?? []), ...(data?.transitions ?? [])];
    const q = query.trim().toLowerCase();
    return all
      .filter((t) => (outcome === "ALL" ? true : t.outcome === outcome))
      .filter((t) => (reason ? (t.rejectionCode ?? "") === reason : true))
      .filter((t) =>
        q
          ? t.routeKey.toLowerCase().includes(q) ||
            t.lifecycleId.toLowerCase().includes(q) ||
            t.buySourceId.toLowerCase().includes(q) ||
            t.sellSourceId.toLowerCase().includes(q)
          : true
      )
      .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  }, [data, query, outcome, reason]);

  // An out-of-range page self-corrects rather than rendering an empty table.
  const page = useMemo(() => paginate(ledger, rawPage, perPage), [ledger, rawPage, perPage]);

  /** Any filter change returns to page 1; paging never resets a filter. */
  const setFilter = (patch: Record<string, string | null>) => write({ ...patch, ppage: "1" });

  if (loading && !data) {
    return (
      <div className="sa-stack">
        <div className="panel sa-panel sa-empty">در حال بارگذاری وضعیت اجرای کاغذی…</div>
      </div>
    );
  }

  return (
    <div className="sa-stack sa-paper">
      <div className="sa-callout sa-callout-warn" role="status">
        <span className="sa-strong">{PAPER_BANNER_EN}</span>
        <span className="sa-sub">
          {" "}
          — {data?.paperBannerFa ?? "اجرای کاغذی"} · موجودی‌ها مجازی‌اند و هیچ سفارش یا انتقال
          واقعی انجام نمی‌شود.
        </span>
      </div>

      {error ? (
        <div className="sa-callout sa-callout-danger" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? <div className="sa-callout sa-callout-muted">{notice}</div> : null}

      {/* ── session ─────────────────────────────────────────────────────── */}
      <section className="panel sa-panel" aria-label="نشست اجرای کاغذی">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title">نشست اجرای کاغذی</h3>
          <div className="sa-panel-note">
            {session ? (STATUS_FA[session.status] ?? session.status) : "نشستی وجود ندارد"}
          </div>
        </div>
        <div className="panel-body sa-stack-2">
          {session ? (
            <>
              <dl className="sa-cc-best-grid">
                <div>
                  <dt>وضعیت</dt>
                  <dd>
                    <span
                      className={`sa-chip sa-chip-sm sa-chip-${
                        session.status === "RUNNING"
                          ? "good"
                          : session.status === "PAUSED"
                            ? "warn"
                            : "muted"
                      }`}
                    >
                      {STATUS_FA[session.status] ?? session.status}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>حالت</dt>
                  <dd>{MODE_FA[session.mode] ?? session.mode}</dd>
                </div>
                <div>
                  <dt>شناسهٔ نشست</dt>
                  <dd>
                    <Bidi>{session.id.slice(0, 8)}</Bidi>
                  </dd>
                </div>
                <div>
                  <dt>شناسهٔ مشاهده</dt>
                  <dd>
                    {session.observationId ? (
                      <Bidi>{session.observationId.slice(0, 8)}</Bidi>
                    ) : (
                      <Unknown why="این نشست به نشست مشاهده‌ای متصل نشده است" />
                    )}
                  </dd>
                </div>
                <div>
                  <dt>آخرین چرخهٔ ارزیابی‌شده</dt>
                  <dd>
                    {data?.cycleSummaries?.length ? (
                      formatTehran(data.cycleSummaries[0].occurredAt)
                    ) : (
                      <Unknown why="هنوز چرخه‌ای برای این نشست ثبت نشده است" />
                    )}
                  </dd>
                </div>
                <div>
                  <dt>آخرین معاملهٔ انجام‌شده</dt>
                  <dd>
                    {stats?.lastFillAt ? (
                      formatTehran(stats.lastFillAt)
                    ) : (
                      <Unknown why="هنوز هیچ معامله‌ای در این نشست پر نشده است" />
                    )}
                  </dd>
                </div>
              </dl>

              <div className="sa-chips">
                {confirming ? (
                  <>
                    <span className="sa-sub">
                      {confirming === "pause"
                        ? "نشست متوقف شود؟ چرخه‌های بعدی ارزیابی نمی‌شوند."
                        : "نشست ادامه یابد؟ ارزیابی چرخه‌ها از سر گرفته می‌شود."}
                    </span>
                    <button
                      type="button"
                      className="sa-btn-clear glass-control"
                      disabled={busy}
                      onClick={() => void act(confirming, session.id)}
                    >
                      بله، انجام بده
                    </button>
                    <button
                      type="button"
                      className="sa-btn-clear glass-control"
                      onClick={() => setConfirming(null)}
                    >
                      انصراف
                    </button>
                  </>
                ) : session.status === "RUNNING" ? (
                  <button
                    type="button"
                    className="sa-btn-clear glass-control"
                    disabled={busy}
                    onClick={() => setConfirming("pause")}
                  >
                    توقف موقت…
                  </button>
                ) : session.status === "PAUSED" ? (
                  <button
                    type="button"
                    className="sa-btn-clear glass-control"
                    disabled={busy}
                    onClick={() => setConfirming("resume")}
                  >
                    ادامهٔ ارزیابی…
                  </button>
                ) : (
                  <span className="sa-sub">
                    این نشست پایان یافته است؛ ساخت نشست تازه از «مرکز فرماندهی» انجام می‌شود.
                  </span>
                )}
              </div>
              <p className="sa-sub">
                استقرار یا بازکردن این صفحه هرگز نشستی نمی‌سازد، شروع نمی‌کند و از سر نمی‌گیرد.
              </p>
            </>
          ) : (
            <p className="sa-cc-empty">
              نشست کاغذی فعالی وجود ندارد. ساخت نشست از «مرکز فرماندهی» انجام می‌شود — این صفحه
              هیچ نشستی ایجاد نمی‌کند.
            </p>
          )}
        </div>
      </section>

      {/* ── five financial metrics, never merged ────────────────────────── */}
      {stats ? (
        <>
          <div className="sa-kpi-grid">
            <Kpi
              label="جریان نقدی تومانی"
              value={<TomanAmount value={stats.cashPnlIrtToman} />}
              hint="فقط حرکت تومان — کارمزد تتری در آن دیده نمی‌شود"
              tone={
                stats.cashPnlIrtToman > 0 ? "good" : stats.cashPnlIrtToman < 0 ? "warn" : "muted"
              }
            />
            <Kpi
              label="تغییر موجودی تتری"
              value={
                <Bidi>{toFaDigits((stats.inventoryDeltaUsdtMicros / 1_000_000).toFixed(6))}</Bidi>
              }
              hint="تتری که کارمزد فروش مصرف کرده است"
              tone={stats.inventoryDeltaUsdtMicros < 0 ? "warn" : "muted"}
            />
            <Kpi
              label="ارزش تومانی کارمزد تتری"
              value={<TomanAmount value={stats.sellFeeValueToman} />}
              hint="به قیمت مرجع همان چرخه ارزش‌گذاری شده"
              tone="muted"
            />
            <Kpi
              label="سود خالص اقتصادی"
              value={<TomanAmount value={stats.economicNetPnlToman} />}
              hint="جریان نقدی منهای ارزش کارمزد تتری"
              tone={
                stats.economicNetPnlToman > 0
                  ? "good"
                  : stats.economicNetPnlToman < 0
                    ? "warn"
                    : "muted"
              }
            />
          </div>
          <div className="sa-kpi-grid">
            <Kpi
              label="سود تعدیل‌شده با ریسک"
              value={<TomanAmount value={stats.riskAdjustedPnlToman} />}
              hint="دروازهٔ اجرا — فقط وقتی اکیداً مثبت باشد معامله انجام می‌شود"
              tone={stats.riskAdjustedPnlToman > 0 ? "good" : "warn"}
            />
            <Kpi
              label="معاملات"
              value={
                <Bidi>{`${toFaDigits(stats.filled)} / ${toFaDigits(stats.filled + stats.skipped)}`}</Bidi>
              }
              hint={`رد‌شده: ${formatCountFa(stats.skipped)}`}
              tone="muted"
            />
            <Kpi
              label="نرخ تبدیل فرصت"
              value={
                stats.opportunityCaptureRatePercent === null ? (
                  <Unknown why="هنوز نامزدی ارزیابی نشده است" />
                ) : (
                  <Bidi>{formatPercentFa(stats.opportunityCaptureRatePercent, 2)}</Bidi>
                )
              }
              hint="انجام‌شده ÷ همهٔ نامزدهای بررسی‌شده"
              tone="muted"
            />
            <Kpi
              label="کارمزد پرداخت‌شده"
              value={<TomanAmount value={stats.feeTomanTotal} />}
              hint={`و ${toFaDigits(stats.feeUsdtTotal.toFixed(6))} تتر`}
              tone="muted"
            />
          </div>
        </>
      ) : null}

      {/* ── segmented view control ──────────────────────────────────────── */}
      <div className="sa-segmented glass-tabbar" role="tablist" aria-label="نمای اجرای کاغذی">
        {PAPER_VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            role="tab"
            aria-selected={view === v.key}
            className={`sa-seg${view === v.key ? " is-active glass-control" : ""}`}
            onClick={() => write({ pv: v.key })}
          >
            {v.labelFa}
          </button>
        ))}
      </div>

      {/* ── balances and capacity ───────────────────────────────────────── */}
      {view === "balances" ? (
        <section className="panel sa-panel" aria-label="موجودی مجازی و ظرفیت">
          <div className="panel-header sa-panel-header">
            <h3 className="panel-title">موجودی مجازی و ظرفیت هر صرافی</h3>
            <div className="sa-panel-note">{formatCountFa(matrix.length)} صرافی</div>
          </div>
          <div className="panel-body sa-table-wrap sa-paper-desktop">
            <table className="sa-table">
              <thead>
                <tr>
                  <th scope="col">صرافی</th>
                  <th scope="col">مدل داده</th>
                  <th scope="col">نقش</th>
                  <th scope="col" className="num">تومان مجازی</th>
                  <th scope="col" className="num">تتر مجازی</th>
                  <th scope="col" className="num">ظرفیت خرید</th>
                  <th scope="col">محدودکنندهٔ خرید</th>
                  <th scope="col" className="num">ظرفیت فروش</th>
                  <th scope="col">محدودکنندهٔ فروش</th>
                </tr>
              </thead>
              <tbody>
                {matrix.map((m) => {
                  const b = balanceById.get(m.sourceId);
                  return (
                    <tr key={m.sourceId}>
                      <td>{m.nameFa}</td>
                      <td className="sa-sub">
                        {m.dataType === "EXECUTABLE_QUOTE" ? "نقل‌قول اجراپذیر" : "دفتر سفارش"}
                      </td>
                      <td className="sa-sub">{m.allocationRole ?? "—"}</td>
                      <td className="num">
                        {b ? (
                          <TomanAmount value={b.irtToman} />
                        ) : (
                          <Unknown why="موجودی مجازی برای این صرافی ثبت نشده است" />
                        )}
                      </td>
                      <td className="num">
                        {b ? (
                          <Bidi>{toFaDigits(b.usdt.toFixed(4))}</Bidi>
                        ) : (
                          <Unknown why="موجودی مجازی برای این صرافی ثبت نشده است" />
                        )}
                      </td>
                      <td className="num">
                        {m.buyCapacityUsdtMicros === null ? (
                          <Unknown
                            why={
                              VENUE_CAPACITY_REASON_FA[
                                m.buyReason as keyof typeof VENUE_CAPACITY_REASON_FA
                              ] ?? m.buyReason
                            }
                          />
                        ) : (
                          <Bidi>
                            {toFaDigits((m.buyCapacityUsdtMicros / 1_000_000).toFixed(2))}
                          </Bidi>
                        )}
                      </td>
                      <td className="sa-sub">
                        {CAP_LABEL_FA[m.buyLimiter as keyof typeof CAP_LABEL_FA] ??
                          VENUE_CAPACITY_REASON_FA[
                            m.buyReason as keyof typeof VENUE_CAPACITY_REASON_FA
                          ] ??
                          "—"}
                      </td>
                      <td className="num">
                        {m.sellCapacityUsdtMicros === null ? (
                          <Unknown
                            why={
                              VENUE_CAPACITY_REASON_FA[
                                m.sellReason as keyof typeof VENUE_CAPACITY_REASON_FA
                              ] ?? m.sellReason
                            }
                          />
                        ) : (
                          <Bidi>
                            {toFaDigits((m.sellCapacityUsdtMicros / 1_000_000).toFixed(2))}
                          </Bidi>
                        )}
                      </td>
                      <td className="sa-sub">
                        {CAP_LABEL_FA[m.sellLimiter as keyof typeof CAP_LABEL_FA] ??
                          VENUE_CAPACITY_REASON_FA[
                            m.sellReason as keyof typeof VENUE_CAPACITY_REASON_FA
                          ] ??
                          "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Real cards on a phone, never a squeezed table. */}
          <div className="panel-body sa-paper-cards">
            {matrix.map((m) => {
              const b = balanceById.get(m.sourceId);
              return (
                <div className="panel sa-panel sa-paper-card" key={m.sourceId}>
                  <div className="sa-paper-card-head">
                    <span className="sa-strong">{m.nameFa}</span>
                    <span className="sa-chip sa-chip-sm sa-chip-muted">
                      {m.dataType === "EXECUTABLE_QUOTE" ? "نقل‌قول اجراپذیر" : "دفتر سفارش"}
                    </span>
                  </div>
                  <dl className="sa-paper-card-grid">
                    <div>
                      <dt>نقش</dt>
                      <dd>{m.allocationRole ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>تومان</dt>
                      <dd>{b ? <TomanAmount value={b.irtToman} /> : "—"}</dd>
                    </div>
                    <div>
                      <dt>تتر</dt>
                      <dd>{b ? <Bidi>{toFaDigits(b.usdt.toFixed(2))}</Bidi> : "—"}</dd>
                    </div>
                    <div>
                      <dt>ظرفیت خرید</dt>
                      <dd>
                        {m.buyCapacityUsdtMicros === null ? (
                          "—"
                        ) : (
                          <Bidi>
                            {toFaDigits((m.buyCapacityUsdtMicros / 1_000_000).toFixed(2))}
                          </Bidi>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>ظرفیت فروش</dt>
                      <dd>
                        {m.sellCapacityUsdtMicros === null ? (
                          "—"
                        ) : (
                          <Bidi>
                            {toFaDigits((m.sellCapacityUsdtMicros / 1_000_000).toFixed(2))}
                          </Bidi>
                        )}
                      </dd>
                    </div>
                  </dl>
                  {m.blockerFa ? <p className="sa-sub">{m.blockerFa}</p> : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* ── ledger ─────────────────────────────────────────────────────── */}
      {view === "fills" ? (
        <section className="panel sa-panel" aria-label="دفتر معاملات">
          <div className="panel-header sa-panel-header">
            <h3 className="panel-title">دفتر معاملات</h3>
            <div className="sa-panel-note">{formatCountFa(ledger.length)} رکورد</div>
          </div>

          <div className="panel-body sa-filter-body">
            <label className="sa-field">
              <span className="sa-field-label">جست‌وجوی مسیر یا شناسهٔ چرخهٔ عمر</span>
              <input
                type="search"
                className="sa-control glass-control"
                value={query}
                onChange={(e) => setFilter({ pq: e.target.value || null })}
              />
            </label>
            <label className="sa-field">
              <span className="sa-field-label">نتیجه</span>
              <select
                className="sa-control glass-control"
                value={outcome}
                onChange={(e) => setFilter({ pout: e.target.value })}
              >
                <option value="ALL">همه</option>
                <option value="FILLED">انجام‌شده</option>
                <option value="SKIPPED">رد‌شده</option>
              </select>
            </label>
            <label className="sa-field">
              <span className="sa-field-label">دلیل رد</span>
              <select
                className="sa-control glass-control"
                value={reason}
                onChange={(e) => setFilter({ preason: e.target.value || null })}
              >
                <option value="">همهٔ دلایل</option>
                {(data?.reasonBreakdown ?? []).map((r) => (
                  <option key={r.reason} value={r.reason}>
                    {r.reason} ({r.count})
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="panel-body sa-table-wrap sa-paper-desktop">
            <table className="sa-table">
              <thead>
                <tr>
                  <th scope="col">مسیر</th>
                  <th scope="col" className="num">حجم</th>
                  <th scope="col" className="num">جریان نقدی</th>
                  <th scope="col" className="num">کارمزد تتری</th>
                  <th scope="col" className="num">خالص اقتصادی</th>
                  <th scope="col" className="num">تعدیل‌شده</th>
                  <th scope="col">وضعیت و زمان</th>
                  <th scope="col">جزئیات</th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Bidi>{t.routeKey}</Bidi>
                    </td>
                    <td className="num">
                      <Bidi>{toFaDigits(t.sizeUsdt.toFixed(4))}</Bidi>
                    </td>
                    <td className="num">
                      {t.cashPnlIrtToman === null ? (
                        <Unknown why="این رکورد اجرا نشده است" />
                      ) : (
                        <TomanAmount value={t.cashPnlIrtToman} />
                      )}
                    </td>
                    <td className="num">
                      {t.sellFeeValueToman === null ? (
                        <Unknown why="این رکورد اجرا نشده است" />
                      ) : (
                        <TomanAmount value={t.sellFeeValueToman} />
                      )}
                    </td>
                    <td className="num">
                      {t.economicNetPnlToman === null ? (
                        <Unknown why="این رکورد اجرا نشده است" />
                      ) : (
                        <TomanAmount value={t.economicNetPnlToman} />
                      )}
                    </td>
                    <td className="num">
                      {t.riskAdjustedPnlToman === null ? (
                        <Unknown why="این رکورد اجرا نشده است" />
                      ) : (
                        <TomanAmount value={t.riskAdjustedPnlToman} />
                      )}
                    </td>
                    <td>
                      <div className="sa-stack-2">
                        <span
                          className={`sa-chip sa-chip-sm sa-chip-${
                            t.outcome === "FILLED" ? "good" : "muted"
                          }`}
                        >
                          {t.outcome === "FILLED" ? "انجام‌شده" : "رد‌شده"}
                        </span>
                        <span className="sa-sub">{formatTehran(t.occurredAt)}</span>
                        {t.rejectionReason ? (
                          <span className="sa-sub">{t.rejectionReason}</span>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="sa-btn-details glass-control"
                        onClick={() => setDetail(t)}
                        aria-label={`جزئیات محاسبهٔ ${t.routeKey}`}
                      >
                        محاسبه
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel-body sa-paper-cards">
            {page.rows.map((t) => (
              <div className="panel sa-panel sa-paper-card" key={t.id}>
                <div className="sa-paper-card-head">
                  <span className="sa-strong">
                    <Bidi>{t.routeKey}</Bidi>
                  </span>
                  <span
                    className={`sa-chip sa-chip-sm sa-chip-${
                      t.outcome === "FILLED" ? "good" : "muted"
                    }`}
                  >
                    {t.outcome === "FILLED" ? "انجام‌شده" : "رد‌شده"}
                  </span>
                </div>
                <dl className="sa-paper-card-grid">
                  <div>
                    <dt>حجم</dt>
                    <dd>
                      <Bidi>{toFaDigits(t.sizeUsdt.toFixed(4))}</Bidi>
                    </dd>
                  </div>
                  <div>
                    <dt>تعدیل‌شده</dt>
                    <dd>
                      {t.riskAdjustedPnlToman === null ? (
                        "—"
                      ) : (
                        <TomanAmount value={t.riskAdjustedPnlToman} />
                      )}
                    </dd>
                  </div>
                </dl>
                <div className="sa-sub">{formatTehran(t.occurredAt)}</div>
                {t.rejectionReason ? <div className="sa-sub">{t.rejectionReason}</div> : null}
                <button
                  type="button"
                  className="sa-btn-details glass-control"
                  onClick={() => setDetail(t)}
                >
                  محاسبه
                </button>
              </div>
            ))}
          </div>

          {ledger.length ? (
            <Pager
              page={page.page}
              pageCount={page.pageCount}
              total={page.total}
              from={page.from}
              to={page.to}
              perPage={perPage}
              pageSizes={OPPORTUNITY_PAGE_SIZES}
              onPage={(p) => write({ ppage: String(p) })}
              onPerPage={(n) => write({ pper: String(n), ppage: "1" })}
            />
          ) : (
            <div className="panel-body sa-cc-empty">با این فیلترها هیچ رکوردی وجود ندارد.</div>
          )}
        </section>
      ) : null}

      {/* ── candidates and grouped reasons ─────────────────────────────── */}
      {view === "candidates" ? (
        <>
          <section className="panel sa-panel" aria-label="شمارش گروهی دلایل">
            <div className="panel-header sa-panel-header">
              <h3 className="panel-title">شمارش گروهی دلایل</h3>
            </div>
            <div className="panel-body sa-chips">
              {(data?.reasonBreakdown ?? []).length ? (
                (data?.reasonBreakdown ?? []).map((r) => (
                  <span className="sa-chip sa-chip-sm sa-chip-muted" key={r.reason}>
                    {r.reason}: {formatCountFa(r.count)}
                  </span>
                ))
              ) : (
                <span className="sa-sub">هنوز دلیلی ثبت نشده است.</span>
              )}
            </div>
          </section>

          <section className="panel sa-panel" aria-label="نامزدهای باز">
            <div className="panel-header sa-panel-header">
              <h3 className="panel-title">نامزدهای باز</h3>
              <div className="sa-panel-note">
                {formatCountFa((data?.candidates ?? []).length)} نامزد
              </div>
            </div>
            <div className="panel-body sa-table-wrap">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th scope="col">مسیر</th>
                    <th scope="col">دلیل اصلی</th>
                    <th scope="col">همهٔ دلایل</th>
                    <th scope="col" className="num">مشاهده</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.candidates ?? []).slice(0, 100).map((c) => (
                    <tr key={c.lifecycleId}>
                      <td>
                        <Bidi>{c.routeKey}</Bidi>
                      </td>
                      <td>{c.reason ?? <Unknown why="دلیلی برای این نامزد ثبت نشده است" />}</td>
                      <td className="sa-sub">{(c.reasonCodes ?? []).join("، ") || "—"}</td>
                      <td className="num">
                        {c.observationCount === undefined ? (
                          "—"
                        ) : (
                          <Bidi>{toFaDigits(c.observationCount)}</Bidi>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}

      {/* ── cycle summaries ────────────────────────────────────────────── */}
      {view === "cycles" ? (
        <section className="panel sa-panel" aria-label="خلاصهٔ چرخه‌ها">
          <div className="panel-header sa-panel-header">
            <h3 className="panel-title">خلاصهٔ چرخه‌ها</h3>
            <div className="sa-panel-note">
              {formatCountFa((data?.cycleSummaries ?? []).length)} چرخه
            </div>
          </div>
          <div className="panel-body sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th scope="col">زمان</th>
                  <th scope="col" className="num">بررسی‌شده</th>
                  <th scope="col" className="num">انجام‌شده</th>
                  <th scope="col" className="num">رد‌شده</th>
                </tr>
              </thead>
              <tbody>
                {(data?.cycleSummaries ?? []).slice(0, 60).map((c) => (
                  <tr key={c.occurredAt}>
                    <td>{formatTehran(c.occurredAt)}</td>
                    <td className="num">
                      {c.evaluated === undefined ? "—" : <Bidi>{toFaDigits(c.evaluated)}</Bidi>}
                    </td>
                    <td className="num">
                      {c.filled === undefined ? "—" : <Bidi>{toFaDigits(c.filled)}</Bidi>}
                    </td>
                    <td className="num">
                      {c.skipped === undefined ? "—" : <Bidi>{toFaDigits(c.skipped)}</Bidi>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* ── calculation drawer ─────────────────────────────────────────── */}
      {detail ? (
        <section className="panel sa-panel" role="dialog" aria-label="جزئیات محاسبه">
          <div className="panel-header sa-panel-header">
            <h3 className="panel-title">
              محاسبهٔ <Bidi>{detail.routeKey}</Bidi>
            </h3>
            <button
              type="button"
              className="sa-btn-clear glass-control"
              onClick={() => setDetail(null)}
            >
              بستن
            </button>
          </div>
          <div className="panel-body">
            <dl className="sa-cc-best-grid">
              <div>
                <dt>پای خرید</dt>
                <dd>{detail.buySourceId}</dd>
              </div>
              <div>
                <dt>پای فروش</dt>
                <dd>{detail.sellSourceId}</dd>
              </div>
              <div>
                <dt>حجم</dt>
                <dd>
                  <Bidi>{toFaDigits(detail.sizeUsdt.toFixed(4))}</Bidi> تتر
                </dd>
              </div>
              <div>
                <dt>VWAP خرید / فروش</dt>
                <dd>
                  {detail.buyVwapToman === null || detail.sellVwapToman === null ? (
                    <Unknown why="این رکورد اجرا نشده است" />
                  ) : (
                    <Bidi>{`${toFaDigits(detail.buyVwapToman)} / ${toFaDigits(detail.sellVwapToman)}`}</Bidi>
                  )}
                </dd>
              </div>
              <div>
                <dt>کارمزد خرید</dt>
                <dd>
                  {detail.buyFeeBps === null ? (
                    <Unknown why="کارمزد تأییدشده‌ای برای این سمت ثبت نشده است" />
                  ) : (
                    <Bidi>{`${toFaDigits(detail.buyFeeBps)} bps · ${detail.buyFeeAsset}`}</Bidi>
                  )}
                </dd>
              </div>
              <div>
                <dt>کارمزد فروش</dt>
                <dd>
                  {detail.sellFeeBps === null ? (
                    <Unknown why="کارمزد تأییدشده‌ای برای این سمت ثبت نشده است" />
                  ) : (
                    <Bidi>{`${toFaDigits(detail.sellFeeBps)} bps · ${detail.sellFeeAsset}`}</Bidi>
                  )}
                </dd>
              </div>
              <div>
                <dt>قیمت مرجع</dt>
                <dd>
                  {detail.markPriceToman === null ? (
                    <Unknown why="قیمت مرجع این چرخه در دسترس نبود" />
                  ) : (
                    <TomanAmount value={detail.markPriceToman} />
                  )}
                </dd>
              </div>
              <div>
                <dt>بافر ریسک</dt>
                <dd>
                  {detail.slippageBufferToman === null ? (
                    <Unknown why="این رکورد اجرا نشده است" />
                  ) : (
                    <TomanAmount value={detail.slippageBufferToman} />
                  )}
                </dd>
              </div>
              <div>
                <dt>جریان نقدی تومانی</dt>
                <dd>
                  {detail.cashPnlIrtToman === null ? (
                    "—"
                  ) : (
                    <TomanAmount value={detail.cashPnlIrtToman} />
                  )}
                </dd>
              </div>
              <div>
                <dt>تغییر موجودی تتری</dt>
                <dd>
                  {detail.inventoryDeltaUsdtMicros === null ? (
                    "—"
                  ) : (
                    <Bidi>
                      {toFaDigits((detail.inventoryDeltaUsdtMicros / 1_000_000).toFixed(6))}
                    </Bidi>
                  )}
                </dd>
              </div>
              <div>
                <dt>ارزش تومانی کارمزد تتری</dt>
                <dd>
                  {detail.sellFeeValueToman === null ? (
                    "—"
                  ) : (
                    <TomanAmount value={detail.sellFeeValueToman} />
                  )}
                </dd>
              </div>
              <div>
                <dt>سود خالص اقتصادی</dt>
                <dd>
                  {detail.economicNetPnlToman === null ? (
                    "—"
                  ) : (
                    <TomanAmount value={detail.economicNetPnlToman} />
                  )}
                </dd>
              </div>
              <div>
                <dt>سود تعدیل‌شده</dt>
                <dd>
                  {detail.riskAdjustedPnlToman === null ? (
                    "—"
                  ) : (
                    <TomanAmount value={detail.riskAdjustedPnlToman} />
                  )}
                </dd>
              </div>
            </dl>
            {detail.rejectionReason ? (
              <p className="sa-sub">دلیل رد: {detail.rejectionReason}</p>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
