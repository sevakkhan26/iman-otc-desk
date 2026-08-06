"use client";

/**
 * Minimal live decision terminal — append-only, fixed single-line rows.
 *
 * Root causes of prior defects (fixed here):
 * 1) Auto-update: scroll-handler race cancelled follow; full re-sort rebuilt the
 *    list; Safari-friendly no-store fetch lacked a cache buster; polling effect
 *    could tear down on identity churn.
 * 2) Wrapping/jumps: free-form sentences wrapped; virtualization assumed fixed
 *    height while rows multi-line; re-sorting all cycles reordered DOM.
 */
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { toFaDigits } from "@/components/shadowArbitrage/labels";
import type { DecisionTraceRow } from "@/db/repositories/shadowDecisionTraces";
import {
  cyclesToTerminalLines,
  parseOccurredAtMs,
  type TerminalLineModel
} from "@/lib/shadowArbitrage/paper/decisionMonitorLabels";
import "./DecisionMonitor.css";

const POLL_MS = 2_500;
/** Hard cap on retained lines (append-only; trim oldest from front). */
const MAX_LINES = 4_000;
const ROW_H = 32;
const OVERSCAN = 20;

type FeedResponse = {
  session: { id: string; name: string; status: string; totalCapitalToman: number } | null;
  rows: DecisionTraceRow[];
};

type LiveState = "live" | "stale" | "error" | "loading";

function toneClass(tone: TerminalLineModel["tone"]): string {
  switch (tone) {
    case "reject":
      return "sa-term-line--reject";
    case "valid":
      return "sa-term-line--valid";
    case "trade":
      return "sa-term-line--trade";
    case "warn":
      return "sa-term-line--warn";
    default:
      return "sa-term-line--normal";
  }
}

export function DecisionMonitorPage() {
  const [lines, setLines] = useState<TerminalLineModel[]>([]);
  const [session, setSession] = useState<FeedResponse["session"]>(null);
  const [live, setLive] = useState<LiveState>("loading");
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(false);
  const [pendingCycles, setPendingCycles] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lineCount, setLineCount] = useState(0);
  const [cycleCount, setCycleCount] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);

  const seenCycles = useRef(new Set<string>());
  const seenLines = useRef(new Set<string>());
  const followRef = useRef(true);
  const pausedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const ignoreScrollRef = useRef(false);
  const lastFetchOkRef = useRef(Date.now());
  const pollInflight = useRef(false);

  useEffect(() => {
    followRef.current = follow;
  }, [follow]);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  /** Append only brand-new cycles in chronological order — never re-sort history. */
  const appendIncoming = useCallback((incoming: DecisionTraceRow[]) => {
    if (!incoming.length) return { addedCycles: 0, addedLines: 0 };

    const unknown = incoming.filter((r) => !seenCycles.current.has(r.id));
    if (!unknown.length && seenCycles.current.size > 0) {
      return { addedCycles: 0, addedLines: 0 };
    }

    // Chronological append order (oldest → newest among brand-new).
    const brandNew = [...unknown].sort(
      (a, b) => parseOccurredAtMs(a.occurredAt) - parseOccurredAtMs(b.occurredAt)
    );

    // First paint: take full page oldest→newest so bottom is latest.
    const batch =
      seenCycles.current.size === 0
        ? [...incoming].sort(
            (a, b) => parseOccurredAtMs(a.occurredAt) - parseOccurredAtMs(b.occurredAt)
          )
        : brandNew;

    for (const c of batch) seenCycles.current.add(c.id);

    const newLines = cyclesToTerminalLines(batch).filter((l) => {
      if (seenLines.current.has(l.id)) return false;
      seenLines.current.add(l.id);
      return true;
    });

    if (!newLines.length) return { addedCycles: batch.length, addedLines: 0 };

    setLines((prev) => {
      let next = prev.length ? [...prev, ...newLines] : newLines;
      if (next.length > MAX_LINES) {
        const drop = next.length - MAX_LINES;
        const removed = next.slice(0, drop);
        for (const r of removed) {
          seenLines.current.delete(r.id);
          // cycle id is prefix before ':'
          const cid = r.id.split(":")[0]!;
          // only forget cycle if no remaining lines for it
        }
        next = next.slice(drop);
        // rebuild cycle seen from remaining lines
        const still = new Set<string>();
        for (const l of next) still.add(l.id.split(":")[0]!);
        for (const id of [...seenCycles.current]) {
          if (!still.has(id)) seenCycles.current.delete(id);
        }
      }
      setLineCount(next.length);
      return next;
    });
    setCycleCount(seenCycles.current.size);

    // Badge only when user has scrolled away and truly new cycles arrive.
    if (!followRef.current && brandNew.length > 0 && seenCycles.current.size > brandNew.length) {
      setPendingCycles((n) => n + brandNew.length);
    }

    return { addedCycles: brandNew.length || batch.length, addedLines: newLines.length };
  }, []);

  const fetchHead = useCallback(async () => {
    if (pollInflight.current) return;
    pollInflight.current = true;
    try {
      // Cache-buster: Safari can ignore Cache-Control on credentialed GETs.
      const url = `/api/shadow-arbitrage/decision-monitor?limit=15&_ts=${Date.now()}`;
      const res = await fetch(url, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache",
          Pragma: "no-cache"
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as FeedResponse;
      setSession(data.session ?? null);
      const { addedCycles } = appendIncoming(data.rows ?? []);
      lastFetchOkRef.current = Date.now();
      setLive("live");
      setError(null);
      return addedCycles;
    } catch (e) {
      setLive("error");
      setError(e instanceof Error ? e.message : "خطا");
      return 0;
    } finally {
      pollInflight.current = false;
    }
  }, [appendIncoming]);

  // Stable poll loop — does not recreate on render; reads paused via ref.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(run, POLL_MS);
    };

    const run = async () => {
      if (cancelled) return;
      if (!pausedRef.current) {
        await fetchHead();
      }
      // Stale indicator
      if (Date.now() - lastFetchOkRef.current > POLL_MS * 5) {
        setLive((s) => (s === "error" ? s : "stale"));
      }
      schedule();
    };

    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchHead]);

  // Viewport measure for virtualization (fixed row height only).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const stickToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    ignoreScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    // end marker as backup (Safari)
    endRef.current?.scrollIntoView({ block: "end" });
    setScrollTop(el.scrollTop);
    // release ignore on next frame after scroll events settle
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ignoreScrollRef.current = false;
      });
    });
  }, []);

  // Auto-follow newest bottom line.
  useLayoutEffect(() => {
    if (!follow || paused) return;
    stickToBottom();
  }, [lines.length, lines[lines.length - 1]?.id, follow, paused, stickToBottom]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    if (ignoreScrollRef.current) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (dist > 64 && followRef.current) {
      setFollow(false);
    }
  };

  const goLatest = () => {
    setFollow(true);
    setPendingCycles(0);
    stickToBottom();
    void fetchHead();
  };

  const liveLabel =
    live === "live"
      ? "زنده"
      : live === "stale"
        ? "کهنه"
        : live === "error"
          ? "قطع"
          : "…";

  // Virtual window — only with FIXED ROW_H (nowrap grid rows).
  const totalH = lines.length * ROW_H;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const visibleCount = Math.ceil(viewH / ROW_H) + OVERSCAN * 2;
  const end = Math.min(lines.length, start + visibleCount);
  const slice = lines.slice(start, end);
  const padTop = start * ROW_H;
  const padBottom = Math.max(0, totalH - end * ROW_H);

  return (
    <div className="sa-term-page" dir="rtl" data-term-lines={lineCount} data-term-cycles={cycleCount}>
      <header className="sa-term-bar">
        <div className="sa-term-bar-left">
          <Link href="/shadow-arbitrage?tab=activity" className="sa-term-back">
            ← فعالیت
          </Link>
          <span
            className={`sa-term-live sa-term-live--${live === "live" ? "on" : live === "stale" ? "stale" : "off"}`}
            data-live={live}
          >
            <span className="sa-term-dot" aria-hidden />
            {liveLabel}
            {paused ? " · متوقف" : ""}
          </span>
          {session ? (
            <span className="sa-term-session">
              <Bidi>{toFaDigits(session.totalCapitalToman.toLocaleString("en-US"))}</Bidi>{" "}
              تومان · {session.status}
            </span>
          ) : null}
          <span className="sa-term-session" data-testid="term-counts">
            <Bidi>{toFaDigits(lineCount)}</Bidi> خط · <Bidi>{toFaDigits(cycleCount)}</Bidi> چرخه
          </span>
        </div>
        <div className="sa-term-bar-right">
          {!follow && pendingCycles > 0 ? (
            <button type="button" className="sa-term-badge" onClick={goLatest}>
              <Bidi>{toFaDigits(pendingCycles)}</Bidi> چرخه‌های جدید — رفتن به آخرین
            </button>
          ) : null}
          <button
            type="button"
            className="sa-term-btn"
            onClick={() => {
              if (paused) {
                setPaused(false);
                setFollow(true);
                setPendingCycles(0);
              } else {
                setPaused(true);
                setFollow(false);
              }
            }}
          >
            {paused ? "ادامه" : "توقف"}
          </button>
        </div>
      </header>

      <div className="sa-term-cols" aria-hidden>
        <span>زمان</span>
        <span>مسیر</span>
        <span>حجم</span>
        <span>سود خالص</span>
        <span>نتیجه</span>
      </div>

      <div
        className="sa-term-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-live="off"
        aria-label="ترمینال زندهٔ تصمیم‌گیری"
      >
        {error ? <div className="sa-term-line sa-term-line--warn">{error}</div> : null}
        {!lines.length && live === "loading" ? (
          <div className="sa-term-line sa-term-line--normal">
            <span className="sa-term-c-route">در حال اتصال…</span>
          </div>
        ) : null}
        {!lines.length && live === "live" ? (
          <div className="sa-term-line sa-term-line--normal">
            <span className="sa-term-c-route">منتظر چرخهٔ بعدی…</span>
          </div>
        ) : null}

        <div style={{ height: padTop }} aria-hidden />
        {slice.map((line) => {
          const open = openId === line.id;
          return (
            <div
              key={line.id}
              className="sa-term-row"
              style={{ height: open && line.tech ? undefined : ROW_H }}
              data-line-id={line.id}
            >
              <button
                type="button"
                className={`sa-term-line ${toneClass(line.tone)}${
                  line.kind === "summary" || line.kind === "missing" ? " sa-term-line--summary" : ""
                }`}
                style={{ height: ROW_H }}
                onClick={() => setOpenId(open ? null : line.id)}
                title={line.text}
              >
                <span className="sa-term-c-time">
                  <Bidi>{line.clock}</Bidi>
                </span>
                <span className="sa-term-c-route">{line.route}</span>
                <span className="sa-term-c-size">
                  <Bidi>{line.size}</Bidi>
                </span>
                <span className="sa-term-c-net">{line.net}</span>
                <span
                  className={
                    line.tone === "reject"
                      ? "sa-term-c-result sa-term-status-reject"
                      : line.tone === "trade"
                        ? "sa-term-c-result sa-term-status-trade"
                        : line.tone === "valid"
                          ? "sa-term-c-result sa-term-line--valid"
                          : line.tone === "warn"
                            ? "sa-term-c-result sa-term-line--warn"
                            : "sa-term-c-result"
                  }
                >
                  {line.result}
                </span>
              </button>
              {open && line.tech ? (
                <pre className="sa-term-tech" dir="ltr">
                  {line.tech}
                </pre>
              ) : null}
            </div>
          );
        })}
        <div style={{ height: padBottom }} aria-hidden />
        <div ref={endRef} className="sa-term-end" data-testid="term-end" />
      </div>
    </div>
  );
}
