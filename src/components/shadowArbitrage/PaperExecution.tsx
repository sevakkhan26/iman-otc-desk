"use client";

import { useCallback, useEffect, useState } from "react";
import { formatTehran } from "@/components/format";
import { formatCountFa, formatPercentFa, toFaDigits } from "@/components/shadowArbitrage/labels";

/** Permanent, never hidden, never conditional. */
export const PAPER_BANNER_EN = "PAPER EXECUTION — NO REAL ORDERS OR TRANSFERS";

type SessionRow = {
  id: string;
  name: string;
  mode: "PROVISIONAL_EVALUATION" | "APPROVED_PLAN";
  status: "NOT_STARTED" | "RUNNING" | "PAUSED" | "STOPPED";
  totalCapitalToman: number;
  valuationPriceToman: number;
  observationId: string | null;
  startedAt: string | null;
  lastCycleAt: string | null;
  cyclesEvaluated: number;
  createdBy: string;
  createdAt: string;
};

type Balance = { sourceId: string; irtToman: number; usdt: number; feeBasis: string };

type Trade = {
  id: string;
  lifecycleId: string;
  routeKey: string;
  buySourceId: string;
  sellSourceId: string;
  sizeUsdt: number;
  buyVwapToman: number | null;
  sellVwapToman: number | null;
  buyNotionalToman: number | null;
  sellNotionalToman: number | null;
  buyFeeBps: number | null;
  sellFeeBps: number | null;
  buyFeeBasis: string | null;
  sellFeeBasis: string | null;
  feeTomanTotal: number | null;
  feeUsdtMicrosTotal: number | null;
  slippageBufferToman: number | null;
  grossSpreadToman: number | null;
  netPnlToman: number | null;
  netPnlAfterBufferToman: number | null;
  occurredAt: string;
};

type Skipped = {
  id: string;
  routeKey: string;
  sizeUsdt: number;
  rejectionCode: string | null;
  rejectionReason: string | null;
  requiredRebalance: string | null;
  occurredAt: string;
};

type Stats = {
  filled: number;
  skipped: number;
  realizedPnlToman: number;
  realizedPnlAfterBufferToman: number;
  feeTomanTotal: number;
  feeUsdtTotal: number;
  opportunityCaptureRatePercent: number | null;
  blockReasons: Array<{ code: string; reasonFa: string; count: number }>;
  drift: Array<{ sourceId: string; irtTomanDelta: number; usdtDelta: number }>;
  lastFillAt: string | null;
};

type Payload = {
  paperBanner: string;
  session: SessionRow | null;
  balances: Balance[];
  trades: Trade[];
  skipped: Skipped[];
  stats: Stats | null;
  history?: SessionRow[];
  message?: string;
};

const STATUS_FA: Record<SessionRow["status"], string> = {
  NOT_STARTED: "شروع‌نشده",
  RUNNING: "در حال اجرا",
  PAUSED: "متوقف",
  STOPPED: "پایان‌یافته"
};

const STATUS_TONE: Record<SessionRow["status"], string> = {
  NOT_STARTED: "muted",
  RUNNING: "good",
  PAUSED: "warn",
  STOPPED: "muted"
};

const MODE_FA: Record<SessionRow["mode"], string> = {
  PROVISIONAL_EVALUATION: "ارزیابی موقت (غیرنهایی)",
  APPROVED_PLAN: "طرح تأییدشدهٔ فاز ۵"
};

function toman(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${toFaDigits(Math.round(v).toLocaleString("en-US"))} تومان`;
}

function usdtText(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${toFaDigits(v.toFixed(2))} تتر`;
}

function signedToman(v: number | null | undefined): { text: string; cls: string } {
  if (v === null || v === undefined || !Number.isFinite(v)) return { text: "—", cls: "" };
  return {
    text: `${v > 0 ? "+" : ""}${toFaDigits(Math.round(v).toLocaleString("en-US"))}`,
    cls: v > 0 ? "sa-pos" : v < 0 ? "sa-neg" : ""
  };
}

/**
 * Phase 6 — admin-only paper execution panel.
 *
 * Everything shown here is simulated. No control on this page can place a real
 * order or move real funds.
 */
export function PaperExecution() {
  const [data, setData] = useState<Payload | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Trade | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/shadow-arbitrage/paper", {
      cache: "no-store",
      credentials: "same-origin"
    });
    if (!res.ok) return;
    setData((await res.json()) as Payload);
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
    const id = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(id);
  }, [open, load]);

  const act = useCallback(
    async (action: "create" | "start" | "pause" | "resume" | "stop", mode?: SessionRow["mode"]) => {
      setBusy(true);
      setNotice(null);
      try {
        const res = await fetch("/api/shadow-arbitrage/paper", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ action, mode })
        });
        const j = (await res.json().catch(() => null)) as (Payload & { message?: string }) | null;
        if (!res.ok) throw new Error(j?.message ?? "درخواست ناموفق بود");
        if (j) setData(j);
        if (action === "create") setNotice("نشست کاغذی ساخته شد. برای اجرا باید آن را شروع کنید.");
        if (action === "start") setNotice("نشست کاغذی شروع شد.");
        if (action === "pause") setNotice("نشست کاغذی متوقف شد.");
        if (action === "resume") setNotice("نشست کاغذی ادامه یافت.");
      } catch (e) {
        setNotice(e instanceof Error ? e.message : "درخواست ناموفق بود");
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const s = data?.session ?? null;
  const stats = data?.stats ?? null;

  return (
    <section className="panel sa-panel">
      <div className="panel-header sa-panel-header">
        <h3 className="panel-title sa-panel-title">اجرای کاغذی خودکار</h3>
        <div className="sa-panel-note">
          <button type="button" className="sa-linkish" onClick={() => setOpen((v) => !v)}>
            {open ? "بستن" : "باز کردن"}
          </button>
        </div>
      </div>

      {/* Permanent banner — rendered whether or not the panel is expanded. */}
      <div className="sa-warning" role="status">
        <span className="sa-warning-icon" aria-hidden="true">
          ⚠
        </span>
        <span>
          {PAPER_BANNER_EN} · اجرای کاغذی — بدون سفارش واقعی و بدون انتقال وجه
        </span>
      </div>

      {!open ? null : (
        <>
          {notice ? (
            <div className="panel-body">
              <div className="sa-callout sa-callout-muted">{notice}</div>
            </div>
          ) : null}

          {s?.mode === "PROVISIONAL_EVALUATION" ? (
            <div className="panel-body">
              <div className="sa-callout sa-callout-warn">
                این نشست یک <strong>ارزیابی موقت</strong> روی طرح مجازی پیش‌فرض
                ۵۰٬۰۰۰٬۰۰۰ تومانی است. نتایج آن نهایی نیستند و مبنای تصمیم واقعی قرار نمی‌گیرند.
              </div>
            </div>
          ) : null}

          <div className="panel-body sa-capital-controls">
            {s ? (
              <>
                <div className="sa-field">
                  <span>وضعیت نشست</span>
                  <strong>
                    <span className={`sa-chip sa-chip-sm sa-chip-${STATUS_TONE[s.status]}`}>
                      {STATUS_FA[s.status]}
                    </span>
                  </strong>
                </div>
                <div className="sa-field">
                  <span>حالت</span>
                  <strong>{MODE_FA[s.mode]}</strong>
                </div>
                <div className="sa-field">
                  <span>سرمایهٔ مجازی</span>
                  <strong>{toman(s.totalCapitalToman)}</strong>
                </div>
                <div className="sa-field">
                  <span>آخرین چرخه</span>
                  <strong className="text-micro">
                    {s.lastCycleAt ? formatTehran(s.lastCycleAt) : "—"}
                  </strong>
                </div>
                <div className="sa-capital-actions">
                  {s.status === "NOT_STARTED" ? (
                    <button type="button" className="sa-btn sa-btn-primary" disabled={busy} onClick={() => void act("start")}>
                      شروع نشست
                    </button>
                  ) : null}
                  {s.status === "RUNNING" ? (
                    <button type="button" className="sa-btn" disabled={busy} onClick={() => void act("pause")}>
                      توقف موقت
                    </button>
                  ) : null}
                  {s.status === "PAUSED" ? (
                    <button type="button" className="sa-btn sa-btn-primary" disabled={busy} onClick={() => void act("resume")}>
                      ادامهٔ نشست
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <div className="sa-field">
                  <span>نشست فعالی وجود ندارد</span>
                  <strong className="text-micro">استقرار به‌تنهایی هیچ نشستی را شروع نمی‌کند.</strong>
                </div>
                <div className="sa-capital-actions">
                  <button
                    type="button"
                    className="sa-btn"
                    disabled={busy}
                    onClick={() => void act("create", "PROVISIONAL_EVALUATION")}
                  >
                    ساخت نشست ارزیابی موقت
                  </button>
                  <button
                    type="button"
                    className="sa-btn sa-btn-primary"
                    disabled={busy}
                    onClick={() => void act("create", "APPROVED_PLAN")}
                  >
                    ساخت نشست طرح تأییدشده
                  </button>
                </div>
              </>
            )}
          </div>

          {stats ? (
            <div className="panel-body sa-metric-grid">
              <div className="sa-metric">
                <div className="sa-metric-label">معاملات کاغذی</div>
                <div className="sa-metric-value">{formatCountFa(stats.filled)}</div>
                <div className="sa-metric-note">ردشده: {formatCountFa(stats.skipped)}</div>
              </div>
              <div className="sa-metric">
                <div className="sa-metric-label">سود نظری محقق‌شده</div>
                <div className={`sa-metric-value ${signedToman(stats.realizedPnlToman).cls}`}>
                  {signedToman(stats.realizedPnlToman).text}
                </div>
                <div className="sa-metric-note">
                  پس از بافر: {signedToman(stats.realizedPnlAfterBufferToman).text}
                </div>
              </div>
              <div className="sa-metric">
                <div className="sa-metric-label">کارمزد پرداختی</div>
                <div className="sa-metric-value">{toman(stats.feeTomanTotal)}</div>
                <div className="sa-metric-note">و {usdtText(stats.feeUsdtTotal)}</div>
              </div>
              <div className="sa-metric">
                <div className="sa-metric-label">نرخ گرفتن فرصت</div>
                <div className="sa-metric-value">
                  {stats.opportunityCaptureRatePercent === null
                    ? "—"
                    : formatPercentFa(stats.opportunityCaptureRatePercent)}
                </div>
                <div className="sa-metric-note">اجراشده از کل نامزدها</div>
              </div>
            </div>
          ) : null}

          {data?.balances?.length ? (
            <div className="panel-body sa-table-wrap">
              <div className="sa-subpanel-title">موجودی مجازی و رانش موجودی</div>
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>صرافی</th>
                    <th className="num">تومان</th>
                    <th className="num">تتر</th>
                    <th className="num">تغییر تومان</th>
                    <th className="num">تغییر تتر</th>
                    <th>واحد کارمزد</th>
                  </tr>
                </thead>
                <tbody>
                  {data.balances.map((b) => {
                    const d = stats?.drift.find((x) => x.sourceId === b.sourceId);
                    const irtD = signedToman(d?.irtTomanDelta);
                    return (
                      <tr key={b.sourceId}>
                        <td>
                          <strong>{b.sourceId}</strong>
                        </td>
                        <td className="num">{toman(b.irtToman)}</td>
                        <td className="num">{usdtText(b.usdt)}</td>
                        <td className={`num ${irtD.cls}`}>{irtD.text}</td>
                        <td className="num">
                          {d ? `${d.usdtDelta > 0 ? "+" : ""}${toFaDigits(d.usdtDelta.toFixed(2))}` : "—"}
                        </td>
                        <td>{b.feeBasis === "UNKNOWN" ? <span className="sa-reason">نامشخص</span> : b.feeBasis}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          {data?.trades?.length ? (
            <div className="panel-body sa-table-wrap">
              <div className="sa-subpanel-title">معاملات کاغذی</div>
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>مسیر</th>
                    <th className="num">حجم</th>
                    <th className="num">اسپرد ناخالص</th>
                    <th className="num">کارمزد</th>
                    <th className="num">سود خالص</th>
                    <th>زمان</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.trades.map((t) => {
                    const net = signedToman(t.netPnlToman);
                    return (
                      <tr key={t.id}>
                        <td className="sa-route-cell">
                          {t.buySourceId} ← {t.sellSourceId}
                        </td>
                        <td className="num">{usdtText(t.sizeUsdt)}</td>
                        <td className="num">{toman(t.grossSpreadToman)}</td>
                        <td className="num">{toman(t.feeTomanTotal)}</td>
                        <td className={`num ${net.cls}`}>{net.text}</td>
                        <td className="text-micro">{formatTehran(t.occurredAt)}</td>
                        <td>
                          <button type="button" className="sa-linkish" onClick={() => setDetail(t)}>
                            محاسبات
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          {data?.skipped?.length ? (
            <div className="panel-body sa-table-wrap">
              <div className="sa-subpanel-title">نامزدهای ردشده و دلیل</div>
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>مسیر</th>
                    <th className="num">حجم</th>
                    <th>دلیل</th>
                    <th>بازتوازن لازم</th>
                    <th>زمان</th>
                  </tr>
                </thead>
                <tbody>
                  {data.skipped.slice(0, 50).map((k) => (
                    <tr key={k.id}>
                      <td className="sa-route-cell">{k.routeKey}</td>
                      <td className="num">{usdtText(k.sizeUsdt)}</td>
                      <td className="sa-wrap-cell">{k.rejectionReason ?? k.rejectionCode ?? "—"}</td>
                      <td className="sa-wrap-cell">
                        {k.requiredRebalance ? (
                          <span className="sa-reason">{k.requiredRebalance}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="text-micro">{formatTehran(k.occurredAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {stats?.blockReasons?.length ? (
            <div className="panel-body">
              <div className="sa-subpanel">
                <div className="sa-subpanel-title">دلایل مسدودی</div>
                <ul className="sa-list">
                  {stats.blockReasons.map((r) => (
                    <li key={r.code}>
                      {r.reasonFa} — {formatCountFa(r.count)} مورد
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          {detail ? (
            <>
              <div className="sa-drawer-backdrop" onClick={() => setDetail(null)} />
              <aside className="sa-drawer" role="dialog" aria-label="جزئیات محاسبهٔ معاملهٔ کاغذی">
                <div className="sa-drawer-head">
                  <div className="sa-drawer-route">
                    {detail.buySourceId} ← {detail.sellSourceId}
                  </div>
                  <button type="button" className="sa-btn sa-btn-ghost" onClick={() => setDetail(null)}>
                    بستن
                  </button>
                </div>
                <div className="sa-drawer-body">
                  <div className="sa-drawer-section">
                    <div className="sa-line">
                      <span className="sa-line-label">حجم</span>
                      <span className="sa-line-value">{usdtText(detail.sizeUsdt)}</span>
                    </div>
                    <div className="sa-line">
                      <span className="sa-line-label">VWAP خرید</span>
                      <span className="sa-line-value">{toman(detail.buyVwapToman)}</span>
                    </div>
                    <div className="sa-line">
                      <span className="sa-line-label">VWAP فروش</span>
                      <span className="sa-line-value">{toman(detail.sellVwapToman)}</span>
                    </div>
                    <div className="sa-line">
                      <span className="sa-line-label">ارزش خرید</span>
                      <span className="sa-line-value">{toman(detail.buyNotionalToman)}</span>
                    </div>
                    <div className="sa-line">
                      <span className="sa-line-label">ارزش فروش</span>
                      <span className="sa-line-value">{toman(detail.sellNotionalToman)}</span>
                    </div>
                    <div className="sa-line">
                      <span className="sa-line-label">کارمزد خرید</span>
                      <span className="sa-line-value">
                        {toFaDigits((detail.buyFeeBps ?? 0) / 100)}٪ · {detail.buyFeeBasis ?? "—"}
                      </span>
                    </div>
                    <div className="sa-line">
                      <span className="sa-line-label">کارمزد فروش</span>
                      <span className="sa-line-value">
                        {toFaDigits((detail.sellFeeBps ?? 0) / 100)}٪ · {detail.sellFeeBasis ?? "—"}
                      </span>
                    </div>
                    <div className="sa-line">
                      <span className="sa-line-label">بافر لغزش (گزارشی)</span>
                      <span className="sa-line-value">{toman(detail.slippageBufferToman)}</span>
                    </div>
                    <div className="sa-line">
                      <span className="sa-line-label">سود خالص</span>
                      <span className="sa-line-value">{toman(detail.netPnlToman)}</span>
                    </div>
                    <div className="sa-line">
                      <span className="sa-line-label">سود پس از بافر</span>
                      <span className="sa-line-value">{toman(detail.netPnlAfterBufferToman)}</span>
                    </div>
                  </div>
                  <div className="sa-footnote">
                    بافر لغزش یک عدد گزارشی و محافظه‌کارانه است و جابه‌جایی نقدی ایجاد نمی‌کند؛ فقط
                    شرط اجرا را سخت‌گیرانه‌تر می‌کند. این معامله شبیه‌سازی است و هیچ سفارش واقعی ثبت
                    نشده است.
                  </div>
                </div>
              </aside>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
