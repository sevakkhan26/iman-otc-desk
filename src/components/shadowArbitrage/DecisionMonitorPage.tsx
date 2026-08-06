"use client";

/**
 * Dedicated full-page decision-cycle console.
 * Read-only GET polling. Auto-follow latest by default.
 */
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { formatTehran } from "@/components/format";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { toFaDigits } from "@/components/shadowArbitrage/labels";
import type {
  DecisionCandidateTrace,
  DecisionTraceRow
} from "@/db/repositories/shadowDecisionTraces";
import {
  candidateStatusLabelFa,
  cycleCountsSentenceFa,
  cycleDecisionPathFa,
  dominantRejectionFa,
  formatAgeFa,
  outcomeLabelFa,
  venueNameFa
} from "@/lib/shadowArbitrage/paper/decisionMonitorLabels";
import "./DecisionMonitor.css";

const POLL_MS = 3_000;
const MAX_BUFFER = 250;
const CAND_PAGE = 20;

type FeedResponse = {
  session: { id: string; name: string; status: string; totalCapitalToman: number } | null;
  source: string;
  rows: DecisionTraceRow[];
  nextCursor: string | null;
  firstCompleteTraceAt: string | null;
  historicalNoteFa: string;
};

type LiveState = "live" | "stale" | "error" | "loading";

function resultClass(row: DecisionTraceRow): string {
  if (row.filledCount > 0) return "sa-dm-cycle-result--traded";
  if (row.selectedCount > 0) return "sa-dm-cycle-result--ok";
  if (!row.traceComplete || row.source === "cycle_summary_only") return "sa-dm-cycle-result--warn";
  if (row.rejectedCount > 0) return "sa-dm-cycle-result--reject";
  return "sa-dm-cycle-result--ok";
}

function pnlClass(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n === 0) return "";
  return n > 0 ? "sa-dm-pos" : "sa-dm-neg";
}

function fmtToman(n: number | null | undefined): ReactNode {
  if (n == null || !Number.isFinite(n)) return "ثبت نشده";
  return <Bidi>{toFaDigits(Math.round(n).toLocaleString("en-US"))}</Bidi>;
}

function CandidateCard({ c }: { c: DecisionCandidateTrace }) {
  const statusFa = candidateStatusLabelFa(c.status);
  const stClass =
    c.status === "traded"
      ? "sa-dm-cand-status--traded"
      : c.status === "selected" || c.status === "valid"
        ? "sa-dm-cand-status--selected"
        : c.status === "rejected"
          ? "sa-dm-cand-status--reject"
          : "";
  const rawSpreadToman =
    c.buyVwapToman != null && c.sellVwapToman != null
      ? (c.sellVwapToman - c.buyVwapToman) * c.sizeUsdt
      : null;
  const rawSpreadPct =
    c.buyVwapToman != null && c.sellVwapToman != null && c.buyVwapToman > 0
      ? ((c.sellVwapToman - c.buyVwapToman) / c.buyVwapToman) * 100
      : null;
  return (
    <article
      className={`sa-dm-cand${c.status === "traded" ? " sa-dm-cand--traded" : ""}`}
      aria-label={`کاندید رتبه ${c.rank}`}
    >
      <div className="sa-dm-cand-top">
        <div className="sa-dm-cand-route">
          رتبه <Bidi>{toFaDigits(c.rank)}</Bidi>
          {" · "}
          {venueNameFa(c.buySourceId)}
          <span aria-hidden> ← </span>
          {venueNameFa(c.sellSourceId)}
          {" · "}
          <Bidi>{toFaDigits(c.sizeUsdt.toFixed(2))}</Bidi> تتر
        </div>
        <div className={`sa-dm-cand-status ${stClass}`}>
          {c.status === "traded"
            ? "✓ معامله شد"
            : c.status === "selected"
              ? "انتخاب شد؛ اجرا تکمیل نشد"
              : statusFa}
        </div>
      </div>
      <dl className="sa-dm-cand-grid">
        <div>
          <dt>VWAP خرید / فروش</dt>
          <dd>
            {fmtToman(c.buyVwapToman)}
            {" / "}
            {fmtToman(c.sellVwapToman)}
          </dd>
        </div>
        <div>
          <dt>اسپرد خام</dt>
          <dd className={pnlClass(rawSpreadToman)}>
            {rawSpreadToman != null ? (
              <>
                {fmtToman(rawSpreadToman)}
                {rawSpreadPct != null ? (
                  <>
                    {" "}
                    (<Bidi>{toFaDigits(rawSpreadPct.toFixed(3))}</Bidi>٪)
                  </>
                ) : null}
              </>
            ) : (
              "ثبت نشده"
            )}
          </dd>
        </div>
        <div>
          <dt>سود ناخالص</dt>
          <dd className={pnlClass(c.grossSpreadToman)}>{fmtToman(c.grossSpreadToman)}</dd>
        </div>
        <div>
          <dt>سود اقتصادی خالص</dt>
          <dd className={pnlClass(c.economicNetPnlToman)}>
            {fmtToman(c.economicNetPnlToman)}
          </dd>
        </div>
        <div>
          <dt>کارمزد خرید / فروش / کل (تومان)</dt>
          <dd>
            {c.buyFeeBps != null ? (
              <>
                <Bidi>{toFaDigits(c.buyFeeBps)}</Bidi> bps
              </>
            ) : (
              "—"
            )}
            {" / "}
            {c.sellFeeBps != null ? (
              <>
                <Bidi>{toFaDigits(c.sellFeeBps)}</Bidi> bps
              </>
            ) : (
              "—"
            )}
            {" / "}
            {fmtToman(c.feeTomanTotal)}
          </dd>
        </div>
        <div>
          <dt>سقف سرمایه / عمق قابل‌استفاده (USDT)</dt>
          <dd>
            {c.capitalCapUsdt != null ? (
              <Bidi>{toFaDigits(c.capitalCapUsdt.toFixed(2))}</Bidi>
            ) : (
              "ثبت نشده"
            )}
            {" / "}
            {c.depthCapUsdt != null ? (
              <Bidi>{toFaDigits(c.depthCapUsdt.toFixed(2))}</Bidi>
            ) : (
              "ثبت نشده"
            )}
          </dd>
        </div>
        <div>
          <dt>دلیل پذیرش / رد</dt>
          <dd>{c.reasonFa ?? c.sizingReason ?? "ثبت نشده"}</dd>
        </div>
        {c.bindingConstraint ? (
          <div>
            <dt>محدودکنندهٔ الزام‌آور</dt>
            <dd>{c.bindingConstraint}</dd>
          </div>
        ) : null}
        {c.ledgerId ? (
          <div>
            <dt>معاملهٔ لینک‌شده</dt>
            <dd>
              <Link href={`/shadow-arbitrage?tab=activity&ledger=${encodeURIComponent(c.ledgerId)}`}>
                جزئیات معامله · <code dir="ltr">{c.ledgerId.slice(0, 12)}…</code>
              </Link>
            </dd>
          </div>
        ) : null}
      </dl>
      <details className="sa-dm-tech">
        <summary>جزئیات فنی</summary>
        <p>
          lifecycle: <code dir="ltr">{c.lifecycleId}</code>
          {" · "}
          route: <code dir="ltr">{c.routeKey}</code>
          {c.reasonCodes?.length ? (
            <>
              {" · "}
              codes: <code dir="ltr">{c.reasonCodes.join(",")}</code>
            </>
          ) : null}
          {c.slippageBufferToman != null ? (
            <>
              {" · "}
              slippage buffer: <Bidi>{toFaDigits(Math.round(c.slippageBufferToman))}</Bidi>
            </>
          ) : null}
        </p>
      </details>
    </article>
  );
}

export function DecisionMonitorPage() {
  const [rows, setRows] = useState<DecisionTraceRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [session, setSession] = useState<FeedResponse["session"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState>("loading");
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(false);
  const [pendingNew, setPendingNew] = useState(0);
  const [filter, setFilter] = useState<"all" | "rejected" | "valid" | "selected" | "traded">(
    "all"
  );
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [candPage, setCandPage] = useState<Record<string, number>>({});
  const [lastFetchAt, setLastFetchAt] = useState<number>(Date.now());
  const seen = useRef(new Set<string>());
  const followRef = useRef(true);
  const topRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    followRef.current = follow;
  }, [follow]);

  const mergeHead = useCallback((incoming: DecisionTraceRow[]) => {
    setRows((prev) => {
      const fresh: DecisionTraceRow[] = [];
      for (const r of incoming) {
        if (seen.current.has(r.id)) continue;
        seen.current.add(r.id);
        fresh.push(r);
      }
      if (!prev.length) {
        for (const r of incoming) seen.current.add(r.id);
        return incoming.slice(0, MAX_BUFFER);
      }
      if (!fresh.length) return prev;
      if (!followRef.current) {
        setPendingNew((n) => n + fresh.length);
      }
      return [...fresh, ...prev].slice(0, MAX_BUFFER);
    });
  }, []);

  const loadHead = useCallback(async () => {
    try {
      const res = await fetch("/api/shadow-arbitrage/decision-monitor?limit=40", {
        cache: "no-store",
        credentials: "same-origin"
      });
      if (!res.ok) throw new Error("خواندن مانیتور ناموفق بود");
      const data = (await res.json()) as FeedResponse;
      setSession(data.session);
      setNote(data.historicalNoteFa ?? "");
      setNextCursor(data.nextCursor);
      mergeHead(data.rows);
      setLastFetchAt(Date.now());
      setLive("live");
      setError(null);
    } catch (e) {
      setLive("error");
      setError(e instanceof Error ? e.message : "خطا");
    }
  }, [mergeHead]);

  const loadOlder = useCallback(async () => {
    if (!nextCursor) return;
    const res = await fetch(
      `/api/shadow-arbitrage/decision-monitor?limit=40&cursor=${encodeURIComponent(nextCursor)}`,
      { cache: "no-store", credentials: "same-origin" }
    );
    if (!res.ok) return;
    const data = (await res.json()) as FeedResponse;
    setNextCursor(data.nextCursor);
    setRows((prev) => {
      const add: DecisionTraceRow[] = [];
      for (const r of data.rows) {
        if (seen.current.has(r.id)) continue;
        seen.current.add(r.id);
        add.push(r);
      }
      return [...prev, ...add].slice(0, MAX_BUFFER);
    });
  }, [nextCursor]);

  useEffect(() => {
    void loadHead();
  }, [loadHead]);

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => void loadHead(), POLL_MS);
    return () => clearInterval(t);
  }, [paused, loadHead]);

  useEffect(() => {
    const t = setInterval(() => {
      const age = Date.now() - lastFetchAt;
      if (age > POLL_MS * 4 && live === "live") setLive("stale");
    }, 2000);
    return () => clearInterval(t);
  }, [lastFetchAt, live]);

  useEffect(() => {
    if (!follow || paused) return;
    topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [rows[0]?.id, follow, paused]);

  /** Pause auto-follow when the operator scrolls the page into history. */
  useEffect(() => {
    let lastY = typeof window !== "undefined" ? window.scrollY : 0;
    const onScroll = () => {
      const y = window.scrollY;
      if (y > lastY + 24 && followRef.current) {
        setFollow(false);
      }
      if (y < 48 && !followRef.current) {
        // near top — do not auto-re-enable; user must click resume/go-latest
      }
      lastY = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (q) {
        const qq = q.trim();
        if (!r.id.includes(qq) && !(r.runId ?? "").includes(qq)) return false;
      }
      if (filter === "rejected") return r.rejectedCount > 0 && r.filledCount === 0;
      if (filter === "valid") return r.validCount > 0;
      if (filter === "selected") return r.selectedCount > 0;
      if (filter === "traded") return r.filledCount > 0;
      return true;
    });
  }, [rows, filter, q]);

  const latest = filtered[0] ?? rows[0] ?? null;
  const ageMs = latest ? Date.now() - Date.parse(latest.occurredAt) : 0;

  const goLatest = () => {
    setFollow(true);
    setPendingNew(0);
    topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    void loadHead();
  };

  const liveLabel =
    live === "live"
      ? "زنده"
      : live === "stale"
        ? "کهنه / در حال اتصال مجدد"
        : live === "error"
          ? "قطع"
          : "بارگذاری";

  return (
    <div className="sa-dm-page" dir="rtl">
      <div className="sa-dm-sticky-bar">
        <div className="sa-dm-title-row">
          <div>
            <Link href="/shadow-arbitrage?tab=activity" className="sa-dm-link-back">
              ← بازگشت به فعالیت و تصمیم‌ها
            </Link>
            <h1 className="sa-dm-title">مانیتور زندهٔ چرخه‌های تصمیم‌گیری</h1>
          </div>
          <span className={`sa-dm-live sa-dm-live--${live === "live" ? "on" : live === "stale" ? "stale" : "off"}`}>
            <span className="sa-dm-dot" aria-hidden />
            {liveLabel}
            {paused ? " · متوقف" : ""}
          </span>
        </div>

        <div className="sa-dm-latest" ref={topRef} aria-label="آخرین چرخه">
          <div className="sa-dm-latest-head">
            <span className="sa-dm-latest-label">آخرین چرخه</span>
            {latest ? (
              <span className="sa-dm-latest-time">
                <Bidi>{formatTehran(latest.occurredAt)}</Bidi>
                <span className="sa-dm-latest-label">
                  {" "}
                  · {formatAgeFa(ageMs)}
                </span>
              </span>
            ) : (
              <span className="sa-dm-latest-time">هنوز چرخه‌ای نیست</span>
            )}
          </div>
          {session ? (
            <div className="sa-dm-latest-stats">
              <span>
                نشست: {session.name} ·{" "}
                <Bidi>{toFaDigits(session.totalCapitalToman.toLocaleString("en-US"))}</Bidi>{" "}
                تومان · {session.status}
              </span>
            </div>
          ) : (
            <div className="sa-dm-latest-stats">نشست کاغذی فعال نیست</div>
          )}
          {latest ? (
            <>
              <div className="sa-dm-latest-stats">
                <span>
                  {cycleCountsSentenceFa({
                    candidatesEvaluated: latest.candidatesEvaluated,
                    rejectedCount: latest.rejectedCount,
                    validCount: latest.validCount,
                    selectedCount: latest.selectedCount,
                    filledCount: latest.filledCount
                  })}
                </span>
              </div>
              <div className={`sa-dm-cycle-result ${resultClass(latest)}`}>
                {outcomeLabelFa(latest.outcome)}
              </div>
              <div className="sa-dm-latest-reason">
                {dominantRejectionFa(latest.candidates, latest.outcomeReasonFa)}
              </div>
            </>
          ) : null}
          {note ? (
            <p className="sa-dm-missing">
              {note.includes(":") ? (
                <>
                  {note.slice(0, note.indexOf(":") + 1)}{" "}
                  <Bidi>{note.slice(note.indexOf(":") + 1).trim()}</Bidi>
                </>
              ) : (
                note
              )}
            </p>
          ) : null}
        </div>

        <div className="sa-dm-toolbar">
          <div className="sa-dm-seg" role="tablist" aria-label="فیلتر وضعیت">
            {(
              [
                ["all", "همه"],
                ["rejected", "ردشده"],
                ["valid", "معتبر"],
                ["selected", "انتخاب‌شده"],
                ["traded", "معامله‌شده"]
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={filter === id ? "is-active" : ""}
                onClick={() => setFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            className="sa-control"
            style={{ minWidth: 140, flex: "1 1 140px", background: "#0c100e", color: "#e6ebe6", border: "1px solid #243028" }}
            placeholder="جستجوی شناسه چرخه"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            dir="ltr"
          />
          <button
            type="button"
            className="sa-btn sa-btn-ghost"
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? "ادامهٔ دنبال‌کردن" : "توقف دنبال‌کردن"}
          </button>
          <button
            type="button"
            className="sa-btn sa-btn-ghost"
            onClick={goLatest}
          >
            رفتن به آخرین چرخه
          </button>
          <button
            type="button"
            className="sa-btn sa-btn-ghost"
            disabled={!nextCursor}
            onClick={() => void loadOlder()}
          >
            تاریخچهٔ قدیمی‌تر
          </button>
        </div>
      </div>

      {!follow && pendingNew > 0 ? (
        <button type="button" className="sa-dm-new-badge" onClick={goLatest}>
          <Bidi>{toFaDigits(pendingNew)}</Bidi> چرخهٔ جدید — بازگشت به آخرین
        </button>
      ) : null}

      <div
        className="sa-dm-feed"
        onWheel={() => {
          if (follow) setFollow(false);
        }}
        onTouchMove={() => {
          if (follow) setFollow(false);
        }}
      >
        {error ? <p className="sa-dm-missing">{error}</p> : null}
        {!filtered.length ? (
          <p className="sa-dm-empty">چرخه‌ای برای نمایش نیست. منتظر جمع‌آورنده بمانید…</p>
        ) : null}

        {filtered.map((r) => {
          const open = expanded === r.id;
          const page = candPage[r.id] ?? 0;
          const cands = r.candidates;
          const pageCands = cands.slice(page * CAND_PAGE, page * CAND_PAGE + CAND_PAGE);
          const pages = Math.max(1, Math.ceil(cands.length / CAND_PAGE));
          return (
            <article key={r.id} className="sa-dm-cycle">
              <button
                type="button"
                className="sa-dm-cycle-head"
                aria-expanded={open}
                onClick={() => {
                  // Expanding a historical cycle must not fight auto-follow scroll.
                  if (!open) setFollow(false);
                  setExpanded(open ? null : r.id);
                  setCandPage((p) => ({ ...p, [r.id]: 0 }));
                }}
              >
                <div className="sa-dm-cycle-primary">
                  <div className="sa-dm-cycle-time">
                    <Bidi>{formatTehran(r.occurredAt)}</Bidi>
                  </div>
                  <div className="sa-dm-cycle-sentence">
                    {cycleCountsSentenceFa({
                      candidatesEvaluated: r.candidatesEvaluated,
                      rejectedCount: r.rejectedCount,
                      validCount: r.validCount,
                      selectedCount: r.selectedCount,
                      filledCount: r.filledCount
                    })}
                  </div>
                  {r.rejectedCount > 0 ? (
                    <div className="sa-dm-cycle-reject">
                      دلیل غالب:{" "}
                      {dominantRejectionFa(r.candidates, r.outcomeReasonFa)}
                    </div>
                  ) : null}
                </div>
                <div className={`sa-dm-cycle-result ${resultClass(r)}`}>
                  {outcomeLabelFa(r.outcome)}
                </div>
              </button>

              {open ? (
                <div className="sa-dm-cycle-body">
                  <div className="sa-dm-path">
                    {cycleDecisionPathFa({
                      outcome: r.outcome,
                      outcomeReasonFa: r.outcomeReasonFa,
                      candidates: r.candidates,
                      filledCount: r.filledCount
                    })}
                  </div>

                  <details className="sa-dm-tech">
                    <summary>جزئیات فنی چرخه</summary>
                    <p>
                      cycle id: <code dir="ltr">{r.id}</code>
                      {r.runId ? (
                        <>
                          {" · "}
                          run: <code dir="ltr">{r.runId}</code>
                        </>
                      ) : null}
                      {" · "}
                      outcome code: <code dir="ltr">{r.outcome}</code>
                      {" · "}
                      source: <code dir="ltr">{r.source}</code>
                    </p>
                  </details>

                  {!r.traceComplete || r.source === "cycle_summary_only" || !cands.length ? (
                    <p className="sa-dm-missing">
                      جزئیات کامل این چرخه ثبت نشده است — شمارنده‌های خلاصه جایگزین ردپای کاندید
                      نیستند.
                    </p>
                  ) : (
                    <>
                      <div className="sa-dm-cands">
                        {pageCands.map((c) => (
                          <CandidateCard key={`${r.id}-${c.rank}-${c.lifecycleId}`} c={c} />
                        ))}
                      </div>
                      {pages > 1 ? (
                        <div className="sa-dm-toolbar">
                          <button
                            type="button"
                            className="sa-btn sa-btn-ghost"
                            disabled={page <= 0}
                            onClick={() =>
                              setCandPage((p) => ({ ...p, [r.id]: Math.max(0, page - 1) }))
                            }
                          >
                            کاندیدهای قبلی
                          </button>
                          <span style={{ fontSize: 12, color: "#8fa090" }}>
                            صفحه <Bidi>{toFaDigits(page + 1)}</Bidi> از{" "}
                            <Bidi>{toFaDigits(pages)}</Bidi> ·{" "}
                            <Bidi>{toFaDigits(cands.length)}</Bidi> کاندید
                          </span>
                          <button
                            type="button"
                            className="sa-btn sa-btn-ghost"
                            disabled={page >= pages - 1}
                            onClick={() =>
                              setCandPage((p) => ({
                                ...p,
                                [r.id]: Math.min(pages - 1, page + 1)
                              }))
                            }
                          >
                            کاندیدهای بعدی
                          </button>
                        </div>
                      ) : (
                        <p style={{ fontSize: 12, color: "#8fa090", margin: 0 }}>
                          <Bidi>{toFaDigits(cands.length)}</Bidi> کاندید در این چرخه
                        </p>
                      )}
                    </>
                  )}

                  <details className="sa-dm-tech">
                    <summary>جزئیات فنی</summary>
                    <p>
                      cycleId: <code>{r.id}</code>
                    </p>
                    <p>
                      runId: <code>{r.runId ?? "—"}</code>
                    </p>
                    <p>
                      snapshot: <code>{r.snapshotRef ?? "—"}</code>
                    </p>
                    <p>
                      outcome raw: <code>{r.outcome}</code>
                    </p>
                    <p>
                      release: <code>{r.releaseVersion ?? "—"}</code> · fp:{" "}
                      <code>{r.policyFingerprint ?? "—"}</code>
                    </p>
                  </details>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
