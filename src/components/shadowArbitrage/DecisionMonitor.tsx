"use client";

/**
 * Live decision-cycle terminal — read-only.
 * Polls GET /api/shadow-arbitrage/decision-monitor. No POST/PUT/PATCH/DELETE.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatTehran } from "@/components/format";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { toFaDigits } from "@/components/shadowArbitrage/labels";
import type { DecisionTraceRow } from "@/db/repositories/shadowDecisionTraces";
import "./DecisionMonitor.css";

const POLL_MS = 4_000;
const MAX_BUFFER = 200;
const ROW_H = 36;

type FeedResponse = {
  session: { id: string; name: string; status: string; totalCapitalToman: number } | null;
  source: string;
  rows: DecisionTraceRow[];
  nextCursor: string | null;
  pageCounters: {
    cycles: number;
    candidates: number;
    valid: number;
    selected: number;
    traded: number;
  };
  firstCompleteTraceAt: string | null;
  historicalNoteFa: string;
};

function toneClass(row: DecisionTraceRow): string {
  if (row.filledCount > 0) return "sa-term-row--traded";
  if (row.validCount > 0 || row.selectedCount > 0) return "sa-term-row--valid";
  if (row.rejectedCount > 0 && row.candidatesEvaluated > 0) return "sa-term-row--reject";
  if (!row.traceComplete || row.source === "cycle_summary_only") return "sa-term-row--amber";
  return "sa-term-row--neutral";
}

export function DecisionMonitor() {
  const [rows, setRows] = useState<DecisionTraceRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");
  const [firstComplete, setFirstComplete] = useState<string | null>(null);
  const [sessionLabel, setSessionLabel] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState<"all" | "rejected" | "valid" | "selected" | "traded">(
    "all"
  );
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const seen = useRef(new Set<string>());

  const load = useCallback(
    async (opts?: { cursor?: string | null; append?: boolean }) => {
      try {
        const params = new URLSearchParams({ limit: "40" });
        if (opts?.cursor) params.set("cursor", opts.cursor);
        const res = await fetch(`/api/shadow-arbitrage/decision-monitor?${params}`, {
          cache: "no-store",
          credentials: "same-origin"
        });
        if (!res.ok) throw new Error("خواندن مانیتور ناموفق بود");
        const data = (await res.json()) as FeedResponse;
        setNote(data.historicalNoteFa ?? "");
        setFirstComplete(data.firstCompleteTraceAt);
        setSessionLabel(
          data.session
            ? `${data.session.name} · ${data.session.status} · ${toFaDigits(
                data.session.totalCapitalToman.toLocaleString("en-US")
              )} تومان`
            : "بدون نشست کاغذی"
        );
        setNextCursor(data.nextCursor);
        setRows((prev) => {
          if (opts?.append) {
            const merged = [...prev];
            for (const r of data.rows) {
              if (seen.current.has(r.id)) continue;
              seen.current.add(r.id);
              merged.push(r);
            }
            return merged.slice(-MAX_BUFFER);
          }
          // Live head: prepend newer rows, keep bound.
          const head: DecisionTraceRow[] = [];
          for (const r of data.rows) {
            if (seen.current.has(r.id)) continue;
            seen.current.add(r.id);
            head.push(r);
          }
          if (!head.length && prev.length) return prev;
          const next = [...head, ...prev];
          // On first load, seed from page
          if (!prev.length) {
            for (const r of data.rows) seen.current.add(r.id);
            return data.rows.slice(0, MAX_BUFFER);
          }
          return next.slice(0, MAX_BUFFER);
        });
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "خطا");
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [paused, load]);

  useEffect(() => {
    if (!follow || paused) return;
    const el = viewportRef.current;
    if (el) el.scrollTop = 0;
  }, [rows, follow, paused]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (q && !r.id.includes(q) && !(r.runId ?? "").includes(q)) return false;
      if (filter === "rejected") return r.rejectedCount > 0 && r.filledCount === 0;
      if (filter === "valid") return r.validCount > 0;
      if (filter === "selected") return r.selectedCount > 0;
      if (filter === "traded") return r.filledCount > 0;
      return true;
    });
  }, [rows, filter, q]);

  const counters = useMemo(() => {
    let candidates = 0;
    let valid = 0;
    let selected = 0;
    let traded = 0;
    for (const r of rows) {
      candidates += r.candidatesEvaluated;
      valid += r.validCount;
      selected += r.selectedCount;
      traded += r.filledCount;
    }
    return { cycles: rows.length, candidates, valid, selected, traded };
  }, [rows]);

  // Virtual window
  const vh = 420;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 4);
  const visibleCount = Math.ceil(vh / ROW_H) + 8;
  const slice = filtered.slice(start, start + visibleCount);
  const padTop = start * ROW_H;
  const padBottom = Math.max(0, (filtered.length - start - slice.length) * ROW_H);

  const toggle = (id: string) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  return (
    <section className="panel sa-panel" aria-label="مانیتور زنده تصمیم‌گیری">
      <div className="panel-header sa-panel-header">
        <h3 className="panel-title">مانیتور زندهٔ چرخه‌های تصمیم‌گیری</h3>
        <div className="sa-panel-note">
          فقط خواندنی · ارقام چرخه = ارزیابی (نه تعداد پوزیشن باز)
        </div>
      </div>
      <div className="panel-body sa-stack">
        <p className="sa-sub">
          هر ردیف یک <strong>چرخه ارزیابی</strong> است (مثلاً هزاران چرخه ≠ هزاران پوزیشن). تیک سبز{" "}
          <span className="sa-term-check">✓ معامله شد</span> فقط وقتی به پر دفتر کاغذی لینک شده
          باشد.
        </p>
        <p className="sa-sub">
          نشست: {sessionLabel || "—"}
          {firstComplete ? (
            <>
              {" "}
              · اولین ردپای کامل: <Bidi>{formatTehran(firstComplete)}</Bidi>
            </>
          ) : null}
        </p>
        {note ? (
          <p className="sa-callout sa-callout-warn" role="status">
            {note}
          </p>
        ) : null}

        <div className="sa-term-toolbar">
          <div className="sa-term-counters">
            <span>
              چرخه: <Bidi>{toFaDigits(counters.cycles)}</Bidi>
            </span>
            <span>
              کاندید: <Bidi>{toFaDigits(counters.candidates)}</Bidi>
            </span>
            <span>
              معتبر: <Bidi>{toFaDigits(counters.valid)}</Bidi>
            </span>
            <span>
              انتخاب: <Bidi>{toFaDigits(counters.selected)}</Bidi>
            </span>
            <span>
              معامله: <Bidi>{toFaDigits(counters.traded)}</Bidi>
            </span>
          </div>
          <div className="sa-term-controls">
            <input
              className="sa-control sa-term-search"
              placeholder="جستجوی cycle / run id"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <select
              className="sa-control"
              value={filter}
              onChange={(e) => setFilter(e.target.value as typeof filter)}
            >
              <option value="all">همه</option>
              <option value="rejected">ردشده</option>
              <option value="valid">معتبر</option>
              <option value="selected">انتخاب‌شده</option>
              <option value="traded">معامله‌شده</option>
            </select>
            <button
              type="button"
              className="sa-btn sa-btn-ghost"
              onClick={() => setPaused((p) => !p)}
            >
              {paused ? "ادامه" : "توقف نمایش"}
            </button>
            <button
              type="button"
              className={`sa-btn sa-btn-ghost${follow ? " is-active" : ""}`}
              onClick={() => setFollow((f) => !f)}
            >
              دنبال آخرین
            </button>
            <button
              type="button"
              className="sa-btn sa-btn-ghost"
              disabled={!nextCursor}
              onClick={() => void load({ cursor: nextCursor, append: true })}
            >
              بایگانی قدیمی‌تر
            </button>
          </div>
        </div>

        {error ? (
          <div className="sa-callout sa-callout-danger" role="alert">
            {error}
          </div>
        ) : null}
        {loading && !rows.length ? <p className="sa-sub">در حال خواندن…</p> : null}

        <div
          className="sa-term"
          ref={viewportRef}
          onScroll={(e) => {
            setScrollTop(e.currentTarget.scrollTop);
            if (e.currentTarget.scrollTop > 40) setFollow(false);
          }}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
        >
          <div style={{ height: padTop }} />
          {slice.map((r) => {
            const open = expanded.has(r.id);
            return (
              <div key={r.id} className={`sa-term-row ${toneClass(r)}`}>
                <button
                  type="button"
                  className="sa-term-line"
                  onClick={() => toggle(r.id)}
                  aria-expanded={open}
                >
                  <span className="sa-term-ts">
                    <Bidi>{formatTehran(r.occurredAt)}</Bidi>
                  </span>
                  <span className="sa-term-id" title={r.id}>
                    {r.id.slice(0, 8)}
                  </span>
                  <span className="sa-term-meta">
                    cand=<Bidi>{toFaDigits(r.candidatesEvaluated)}</Bidi> rej=
                    <Bidi>{toFaDigits(r.rejectedCount)}</Bidi> valid=
                    <Bidi>{toFaDigits(r.validCount)}</Bidi> fill=
                    <Bidi>{toFaDigits(r.filledCount)}</Bidi>
                  </span>
                  <span className="sa-term-out">
                    {r.filledCount > 0 ? (
                      <span className="sa-term-check">✓ معامله شد</span>
                    ) : (
                      r.outcome
                    )}
                  </span>
                </button>
                {open ? (
                  <div className="sa-term-expand">
                    {!r.traceComplete || r.source === "cycle_summary_only" ? (
                      <p className="sa-term-missing">
                        جزئیات این چرخه ثبت نشده است — فقط خلاصهٔ چرخه موجود است. ردپای کامل
                        کاندید از فعال‌سازی SHADOW_DECISION_TRACE به‌بعد ثبت می‌شود.
                      </p>
                    ) : null}
                    <p className="sa-term-expand-head">
                      cycleId={r.id} · runId={r.runId ?? "—"} · routes=
                      {r.routesEvaluated} · sizes={r.sizesEvaluated} · venues=
                      {r.venuesAvailable}
                    </p>
                    <p className="sa-sub">{r.outcomeReasonFa}</p>
                    {r.candidates.length ? (
                      <table className="sa-term-table">
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>مسیر</th>
                            <th>حجم</th>
                            <th>وضعیت</th>
                            <th>خالص اقتصادی</th>
                            <th>دلیل</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.candidates.map((c) => (
                            <tr key={`${r.id}-${c.rank}-${c.lifecycleId}`}>
                              <td>
                                <Bidi>{toFaDigits(c.rank)}</Bidi>
                              </td>
                              <td>
                                {c.buySourceId}→{c.sellSourceId}
                              </td>
                              <td>
                                <Bidi>{toFaDigits(c.sizeUsdt.toFixed(2))}</Bidi>
                              </td>
                              <td>
                                {c.status === "traded" ? (
                                  <span className="sa-term-check">✓ معامله شد</span>
                                ) : (
                                  c.statusFa
                                )}
                              </td>
                              <td>
                                {c.economicNetPnlToman !== null ? (
                                  <Bidi>
                                    {toFaDigits(
                                      Math.round(c.economicNetPnlToman).toLocaleString("en-US")
                                    )}
                                  </Bidi>
                                ) : (
                                  "ثبت نشده"
                                )}
                              </td>
                              <td className="sa-term-reason">{c.reasonFa ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
          <div style={{ height: padBottom }} />
          {!filtered.length && !loading ? (
            <p className="sa-term-empty">چرخه‌ای برای نمایش نیست.</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
