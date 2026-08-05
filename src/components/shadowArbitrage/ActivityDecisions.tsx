"use client";

/**
 * Activity and decisions — what the desk did, and exactly why.
 *
 * Strictly read-only. It issues no POST on load, on refresh, on filtering, on
 * paging or on opening a detail: every filter is applied to data already
 * fetched, and every filter lives in the query string so a link reproduces the
 * exact view. A read-only surface that quietly posts is a surface that can
 * change state by being looked at.
 *
 * It creates no second activity system either. Everything here is already
 * persisted: the paper ledger with its SMART_CAPITAL_DEPTH evidence columns,
 * the per-cycle summaries, the session row, and the live sizing study the
 * Command Center already computes.
 */
import { useMemo } from "react";
import { TomanAmount } from "@/components/TomanAmount";
import { formatTehran } from "@/components/format";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { toFaDigits } from "@/components/shadowArbitrage/labels";
import { reasonLabel } from "@/lib/shadowArbitrage/paper/reasons";
import { readInt, useShadowViewState } from "@/components/shadowArbitrage/urlState";
import type { RouteSizingView } from "@/components/shadowArbitrage/CommandCenter";
import type { NormalizedSourceSnapshot } from "@/lib/shadowArbitrage/types";
import { PAPER_POLICY_SET_KEY } from "@/lib/shadowArbitrage/live/paperPolicySet";

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
  rejectionCode: string | null;
  rejectionReason: string | null;
  reasonCodes?: string[];
  riskAdjustedPnlToman: number | null;
  economicNetPnlToman: number | null;
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

export function ActivityDecisions({
  session,
  ledger,
  cycleSummaries,
  routes,
  sizingPolicy,
  sources,
  serverNow,
  loading
}: Props) {
  const { read, write } = useShadowViewState();

  const venue = read("av", "all");
  const outcome = read("ao", "all");
  const reason = read("ar", "all");
  const window = read("aw", "all");
  const page = readInt(read("ap", "1"), 1, 1, 10_000);
  const perPage = readInt(read("an", "20"), 20, 10, 100);

  /** Every venue that appears on either leg of a recorded decision. */
  const venues = useMemo(() => {
    const set = new Set<string>();
    for (const r of ledger) {
      set.add(r.buySourceId);
      set.add(r.sellSourceId);
    }
    return [...set].sort();
  }, [ledger]);

  /** Every rejection code actually present, with how often. */
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

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const safePage = Math.min(page, totalPages);
  const shown = filtered.slice((safePage - 1) * perPage, safePage * perPage);

  const filledCount = ledger.filter((r) => r.outcome === "FILLED").length;
  const skippedCount = ledger.length - filledCount;
  const sizedRoutes = routes.filter((r) => r.sizing.status === "SIZED");

  /** Any filter change returns to page one; nothing else changes. */
  const setFilter = (patch: Record<string, string | null>) => write({ ...patch, ap: "1" });

  return (
    <div className="sa-stack">
      {/* ── session and headline counts ──────────────────────────────────── */}
      <section className="panel sa-panel" aria-label="وضعیت نشست کاغذی">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title sa-panel-title">فعالیت و تصمیم‌ها</h3>
          <div className="sa-panel-note">فقط خواندنی — این نما هیچ چیزی را تغییر نمی‌دهد</div>
        </div>
        <div className="panel-body">
          <dl className="sa-ad-summary">
            <div>
              <dt>نشست کاغذی</dt>
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
              <dt>سرمایهٔ نشست</dt>
              <dd>{session ? <TomanAmount value={session.totalCapitalToman} /> : DASH}</dd>
            </div>
            <div>
              <dt>سیاست حجم‌دهی</dt>
              <dd>
                {sizingPolicy ? (
                  <span className="sa-chip sa-chip-sm sa-chip-muted">{sizingPolicy}</span>
                ) : (
                  DASH
                )}
              </dd>
            </div>
            <div>
              <dt>مجموعهٔ سیاست Paper</dt>
              <dd>
                <span className="sa-chip sa-chip-sm sa-chip-muted">{PAPER_POLICY_SET_KEY}</span>
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
              <dt>مسیرهای حجم‌گرفته (چرخهٔ فعلی)</dt>
              <dd>
                <Bidi>
                  {toFaDigits(sizedRoutes.length)} از {toFaDigits(routes.length)}
                </Bidi>
              </dd>
            </div>
            <div>
              <dt>آخرین به‌روزرسانی</dt>
              <dd>{serverNow ? formatTehran(serverNow) : DASH}</dd>
            </div>
          </dl>
        </div>
      </section>

      {/* ── recent evaluation cycles ─────────────────────────────────────── */}
      <section className="panel sa-panel" aria-label="چرخه‌های ارزیابی اخیر">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title sa-panel-title">چرخه‌های ارزیابی اخیر</h3>
          <div className="sa-panel-note">هر ردیف یک چرخهٔ کامل ارزیابی است</div>
        </div>
        <div className="panel-body">
          {cycleSummaries.length ? (
            <div className="sa-table-wrap">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th scope="col">زمان</th>
                    <th scope="col" className="num">نامزد بررسی‌شده</th>
                    <th scope="col" className="num">اجراشده</th>
                    <th scope="col" className="num">ردشده</th>
                    <th scope="col">دلایل غالب</th>
                  </tr>
                </thead>
                <tbody>
                  {cycleSummaries.slice(0, 30).map((c) => (
                    <tr key={c.occurredAt}>
                      <td data-label="زمان">{formatTehran(c.occurredAt)}</td>
                      <td data-label="نامزد بررسی‌شده" className="num">
                        <Bidi>{toFaDigits(c.candidatesEvaluated)}</Bidi>
                      </td>
                      <td data-label="اجراشده" className="num">
                        <Bidi>{toFaDigits(c.filled)}</Bidi>
                      </td>
                      <td data-label="ردشده" className="num">
                        <Bidi>{toFaDigits(c.skipped)}</Bidi>
                      </td>
                      <td data-label="دلایل غالب" className="sa-sub">
                        {Object.entries(c.reasonCounts ?? {})
                          .sort((a, b) => b[1] - a[1])
                          .slice(0, 3)
                          .map(([code, n]) => `${reasonLabel(code)} (${toFaDigits(n)})`)
                          .join(" · ") || DASH}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="sa-sub">
              {loading ? "در حال خواندن…" : "هنوز هیچ چرخهٔ ارزیابی ثبت نشده است."}
            </p>
          )}
        </div>
      </section>

      {/* ── the current cycle's sizing study, with the fixed baseline ────── */}
      <section className="panel sa-panel" aria-label="تصمیم حجم در چرخهٔ فعلی">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title sa-panel-title">تصمیم حجم در چرخهٔ فعلی</h3>
          <div className="sa-panel-note">
            حجم هوشمند در برابر نردبان ثابت — نردبان ثابت هرگز اجرا نمی‌شود
          </div>
        </div>
        <div className="panel-body">
          {sizedRoutes.length ? (
            <>
              <div className="sa-table-wrap sa-ad-desktop">
                <table className="sa-table">
                  <thead>
                    <tr>
                      <th scope="col">مسیر</th>
                      <th scope="col" className="num">حجم هوشمند</th>
                      <th scope="col" className="num">مبنای ثابت</th>
                      <th scope="col">سقف محدودکننده</th>
                      <th scope="col" className="num">VWAP دو پا</th>
                      <th scope="col" className="num">سود · بازده</th>
                      <th scope="col" className="num">اثر موجودی</th>
                      <th scope="col">چرا بزرگ‌تر نه</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sizedRoutes.map((r) => (
                      <tr key={r.routeKey}>
                        <td data-label="مسیر">
                          {r.buySourceId} ← {r.sellSourceId}
                        </td>
                        <td data-label="حجم هوشمند" className="num">
                          <Bidi>{toFaDigits((r.sizing.sizeUsdt ?? 0).toFixed(4))}</Bidi>
                        </td>
                        <td data-label="مبنای ثابت" className="num">
                          {r.sizing.baseline?.bestRiskAdjustedPnlToman === null ||
                          r.sizing.baseline?.bestRiskAdjustedPnlToman === undefined ? (
                            DASH
                          ) : (
                            <>
                              <Bidi>{toFaDigits(r.sizing.baseline.bestSizeUsdt ?? 0)}</Bidi> تتر ·{" "}
                              <TomanAmount value={r.sizing.baseline.bestRiskAdjustedPnlToman} />
                            </>
                          )}
                        </td>
                        <td data-label="سقف محدودکننده" className="sa-sub">
                          {r.sizing.bindingConstraint ?? "منحنی سود، نه یک سقف"}
                        </td>
                        <td data-label="VWAP دو پا" className="num">
                          {r.sizing.quote ? (
                            <Bidi>
                              {toFaDigits(r.sizing.quote.buyVwapToman.toLocaleString("en-US"))} ↤{" "}
                              {toFaDigits(r.sizing.quote.sellVwapToman.toLocaleString("en-US"))}
                            </Bidi>
                          ) : (
                            DASH
                          )}
                        </td>
                        <td data-label="سود · بازده" className="num">
                          {r.sizing.economics ? (
                            <>
                              <TomanAmount value={r.sizing.economics.riskAdjustedPnlToman} />
                              <br />
                              <Bidi>
                                {toFaDigits(r.sizing.economics.riskAdjustedReturnBps)} bps
                              </Bidi>
                            </>
                          ) : (
                            DASH
                          )}
                        </td>
                        <td data-label="اثر موجودی" className="num">
                          {r.sizing.inventory?.measurable ? (
                            <Bidi>
                              {r.sizing.inventory.impactPoints > 0 ? "+" : ""}
                              {toFaDigits(r.sizing.inventory.impactPoints.toFixed(2))}
                            </Bidi>
                          ) : (
                            DASH
                          )}
                        </td>
                        <td data-label="چرا بزرگ‌تر نه" className="sa-sub">
                          {r.sizing.selection?.nextLarger
                            ? `${r.sizing.selection.nextLarger.code} — ${r.sizing.selection.nextLarger.detailFa}`
                            : "نامزد بزرگ‌تری وجود نداشت"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <ul className="sa-ad-cards">
                {sizedRoutes.map((r) => (
                  <li key={r.routeKey} className="sa-ad-card">
                    <div className="sa-ad-card-head">
                      <span className="sa-ad-card-title">
                        {r.buySourceId} ← {r.sellSourceId}
                      </span>
                      <span className="sa-chip sa-chip-sm sa-chip-good">
                        <Bidi>{toFaDigits((r.sizing.sizeUsdt ?? 0).toFixed(4))}</Bidi> تتر
                      </span>
                    </div>
                    <dl className="sa-ad-card-grid">
                      <div>
                        <dt>سود تعدیل‌شده</dt>
                        <dd>
                          {r.sizing.economics ? (
                            <TomanAmount value={r.sizing.economics.riskAdjustedPnlToman} />
                          ) : (
                            DASH
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>بازده</dt>
                        <dd>
                          {r.sizing.economics ? (
                            <Bidi>
                              {toFaDigits(r.sizing.economics.riskAdjustedReturnBps)} bps
                            </Bidi>
                          ) : (
                            DASH
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>مبنای ثابت</dt>
                        <dd>
                          {r.sizing.baseline?.bestRiskAdjustedPnlToman === null ||
                          r.sizing.baseline?.bestRiskAdjustedPnlToman === undefined ? (
                            DASH
                          ) : (
                            <TomanAmount value={r.sizing.baseline.bestRiskAdjustedPnlToman} />
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>اثر موجودی</dt>
                        <dd>
                          {r.sizing.inventory?.measurable ? (
                            <Bidi>
                              {toFaDigits(r.sizing.inventory.impactPoints.toFixed(2))} واحد
                            </Bidi>
                          ) : (
                            DASH
                          )}
                        </dd>
                      </div>
                    </dl>
                    <p className="sa-sub sa-ad-card-note">
                      {r.sizing.selection?.reasonFa ?? "دلیل ثبت نشده"}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="sa-sub">
              در این چرخه هیچ مسیری حجم نگرفت. دلیل دقیق هر مسیر در «مرکز فرماندهی» و در فهرست
              تصمیم‌های ثبت‌شدهٔ پایین همین صفحه آمده است.
            </p>
          )}
        </div>
      </section>

      {/* ── recorded decisions, filtered ─────────────────────────────────── */}
      <section className="panel sa-panel" aria-label="تصمیم‌های ثبت‌شده">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title sa-panel-title">تصمیم‌های ثبت‌شده</h3>
          <div className="sa-panel-note">
            <Bidi>
              {toFaDigits(filtered.length)} از {toFaDigits(ledger.length)}
            </Bidi>{" "}
            ردیف
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
            <span className="sa-field-label">بازهٔ زمانی</span>
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
                      <th scope="col" className="num">VWAP دو پا</th>
                      <th scope="col" className="num">سود · بازده</th>
                      <th scope="col" className="num">اثر موجودی</th>
                      <th scope="col">دلیل</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.id}>
                        <td data-label="زمان">{formatTehran(r.occurredAt)}</td>
                        <td data-label="مسیر">
                          {r.buySourceId} ← {r.sellSourceId}
                        </td>
                        <td data-label="نتیجه">
                          <span
                            className={`sa-chip sa-chip-sm sa-chip-${
                              r.outcome === "FILLED" ? "good" : "muted"
                            }`}
                          >
                            {r.outcome === "FILLED" ? "اجراشده" : "ردشده"}
                          </span>
                        </td>
                        <td data-label="حجم" className="num">
                          <Bidi>{toFaDigits(r.sizeUsdt.toFixed(4))}</Bidi>
                        </td>
                        <td data-label="VWAP دو پا" className="num">
                          {r.buyVwapToman && r.sellVwapToman ? (
                            <Bidi>
                              {toFaDigits(r.buyVwapToman.toLocaleString("en-US"))} ↤{" "}
                              {toFaDigits(r.sellVwapToman.toLocaleString("en-US"))}
                            </Bidi>
                          ) : (
                            DASH
                          )}
                        </td>
                        <td data-label="سود · بازده" className="num">
                          {r.riskAdjustedPnlToman === null ? (
                            DASH
                          ) : (
                            <>
                              <TomanAmount value={r.riskAdjustedPnlToman} />
                              {r.riskAdjustedReturnBps !== null &&
                              r.riskAdjustedReturnBps !== undefined ? (
                                <>
                                  <br />
                                  <Bidi>{toFaDigits(r.riskAdjustedReturnBps)} bps</Bidi>
                                </>
                              ) : null}
                            </>
                          )}
                        </td>
                        <td data-label="اثر موجودی" className="num">
                          {r.inventoryImpactPoints === null ||
                          r.inventoryImpactPoints === undefined ? (
                            DASH
                          ) : (
                            <Bidi>{toFaDigits(r.inventoryImpactPoints.toFixed(2))}</Bidi>
                          )}
                        </td>
                        <td data-label="دلیل" className="sa-sub">
                          {r.outcome === "FILLED"
                            ? (r.sizingReason ?? "دلیل ثبت نشده")
                            : (r.rejectionReason ?? reasonLabel(r.rejectionCode ?? ""))}
                          {r.nextLargerRejectionCode ? (
                            <>
                              <br />
                              <span className="sa-strong">چرا بزرگ‌تر نه: </span>
                              {r.nextLargerRejectionCode} —{" "}
                              {r.nextLargerRejectionReason ?? ""}
                            </>
                          ) : null}
                          {r.bindingConstraint ? (
                            <>
                              <br />
                              محدودکننده: {r.bindingConstraint}
                              {r.limitingSourceId ? ` (${r.limitingSourceId})` : ""}
                            </>
                          ) : null}
                          {r.capitalCapUsdtMicros !== null &&
                          r.capitalCapUsdtMicros !== undefined ? (
                            <>
                              <br />
                              سقف سرمایه <Bidi>{toFaDigits(usdt(r.capitalCapUsdtMicros) ?? "")}</Bidi>{" "}
                              · سقف عمق{" "}
                              <Bidi>{toFaDigits(usdt(r.depthCapUsdtMicros) ?? "")}</Bidi>
                            </>
                          ) : null}
                          {r.sizingPolicy ? (
                            <>
                              <br />
                              <span className="sa-chip sa-chip-sm sa-chip-muted">
                                {r.sizingPolicy}
                              </span>
                            </>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <ul className="sa-ad-cards">
                {shown.map((r) => (
                  <li key={r.id} className="sa-ad-card">
                    <div className="sa-ad-card-head">
                      <span className="sa-ad-card-title">
                        {r.buySourceId} ← {r.sellSourceId}
                      </span>
                      <span
                        className={`sa-chip sa-chip-sm sa-chip-${
                          r.outcome === "FILLED" ? "good" : "muted"
                        }`}
                      >
                        {r.outcome === "FILLED" ? "اجراشده" : "ردشده"}
                      </span>
                    </div>
                    <dl className="sa-ad-card-grid">
                      <div>
                        <dt>زمان</dt>
                        <dd>{formatTehran(r.occurredAt)}</dd>
                      </div>
                      <div>
                        <dt>حجم</dt>
                        <dd>
                          <Bidi>{toFaDigits(r.sizeUsdt.toFixed(4))}</Bidi> تتر
                        </dd>
                      </div>
                      <div>
                        <dt>سود تعدیل‌شده</dt>
                        <dd>
                          {r.riskAdjustedPnlToman === null ? (
                            DASH
                          ) : (
                            <TomanAmount value={r.riskAdjustedPnlToman} />
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>VWAP دو پا</dt>
                        <dd>
                          {r.buyVwapToman && r.sellVwapToman ? (
                            <Bidi>
                              {toFaDigits(r.buyVwapToman.toLocaleString("en-US"))} ↤{" "}
                              {toFaDigits(r.sellVwapToman.toLocaleString("en-US"))}
                            </Bidi>
                          ) : (
                            DASH
                          )}
                        </dd>
                      </div>
                    </dl>
                    <p className="sa-sub sa-ad-card-note">
                      {r.outcome === "FILLED"
                        ? (r.sizingReason ?? "دلیل ثبت نشده")
                        : (r.rejectionReason ?? reasonLabel(r.rejectionCode ?? ""))}
                    </p>
                  </li>
                ))}
              </ul>

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
                <span className="sa-pager-count">
                  <Bidi>{toFaDigits(filtered.length)}</Bidi> ردیف
                </span>
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

      {/* ── source health and freshness ──────────────────────────────────── */}
      <section className="panel sa-panel" aria-label="سلامت و تازگی منابع">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title sa-panel-title">سلامت و تازگی منابع</h3>
          <div className="sa-panel-note">دادهٔ همان چرخه‌ای که تصمیم‌ها روی آن گرفته شد</div>
        </div>
        <div className="panel-body sa-table-wrap">
          <table className="sa-table">
            <thead>
              <tr>
                <th scope="col">صرافی</th>
                <th scope="col">سلامت</th>
                <th scope="col" className="num">سن داده</th>
                <th scope="col">مدل بازار</th>
                <th scope="col">مانع</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.sourceId}>
                  <td data-label="صرافی">{s.sourceName}</td>
                  <td data-label="سلامت">
                    <span
                      className={`sa-chip sa-chip-sm sa-chip-${
                        s.health === "healthy" ? "good" : s.health === "degraded" ? "warn" : "danger"
                      }`}
                    >
                      {s.health}
                    </span>
                  </td>
                  <td data-label="سن داده" className="num">
                    <Bidi>{toFaDigits(Math.round(s.ageMs / 1000))}</Bidi> ثانیه
                    {s.stale ? " (کهنه)" : ""}
                  </td>
                  <td data-label="مدل بازار">{s.marketModel}</td>
                  <td data-label="مانع" className="sa-sub">
                    {s.errorReason ?? s.degradedReason ?? DASH}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="sa-sub sa-ad-foot">
        این نما فقط خواندنی است: بارگذاری، تازه‌سازی، فیلتر، صفحه‌بندی و باز کردن جزئیات هیچ
        درخواست تغییردهنده‌ای نمی‌فرستند. ارقام از همان ردیف‌های ثبت‌شدهٔ دفتر کاغذی و خلاصهٔ
        چرخه‌ها خوانده می‌شوند و دوباره محاسبه نمی‌گردند.
      </p>
    </div>
  );
}
