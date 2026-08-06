"use client";

/**
 * Minimal live decision terminal — full-page black console.
 * One line per candidate + one summary per cycle. GET-only polling.
 */
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { toFaDigits } from "@/components/shadowArbitrage/labels";
import type { DecisionTraceRow } from "@/db/repositories/shadowDecisionTraces";
import {
  cyclesToTerminalLines,
  type TerminalLineModel
} from "@/lib/shadowArbitrage/paper/decisionMonitorLabels";
import "./DecisionMonitor.css";

const POLL_MS = 3_000;
/** Keep at most this many cycle rows in memory (newest). */
const MAX_CYCLES = 40;
/** Virtual row height (px) — matches CSS. */
const ROW_H = 30;
const OVERSCAN = 24;

type FeedResponse = {
  session: { id: string; name: string; status: string; totalCapitalToman: number } | null;
  rows: DecisionTraceRow[];
  nextCursor: string | null;
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

/** Render primary line; paint only the rejection status fragment red. */
function TermText({ tone, text }: { tone: TerminalLineModel["tone"]; text: string }) {
  if (tone === "reject") {
    const marker = "رد شد:";
    const i = text.indexOf(marker);
    if (i >= 0) {
      return (
        <span className="sa-term-text">
          {text.slice(0, i)}
          <span className="sa-term-status-reject">{text.slice(i)}</span>
        </span>
      );
    }
  }
  if (tone === "trade" && text.startsWith("✓")) {
    return (
      <span className="sa-term-text">
        <span className="sa-term-status-trade">{text}</span>
      </span>
    );
  }
  return <span className="sa-term-text">{text}</span>;
}

export function DecisionMonitorPage() {
  const [cycles, setCycles] = useState<DecisionTraceRow[]>([]);
  const [session, setSession] = useState<FeedResponse["session"]>(null);
  const [live, setLive] = useState<LiveState>("loading");
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(false);
  const [pendingCycles, setPendingCycles] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchAt, setLastFetchAt] = useState(Date.now());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);

  const seen = useRef(new Set<string>());
  const followRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    followRef.current = follow;
  }, [follow]);

  const mergeCycles = useCallback((incoming: DecisionTraceRow[]) => {
    setCycles((prev) => {
      const fresh: DecisionTraceRow[] = [];
      for (const r of incoming) {
        if (seen.current.has(r.id)) continue;
        seen.current.add(r.id);
        fresh.push(r);
      }
      if (!prev.length) {
        for (const r of incoming) seen.current.add(r.id);
        // Keep chronological buffer of the newest page (API is desc).
        return [...incoming]
          .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
          .slice(-MAX_CYCLES);
      }
      if (!fresh.length) return prev;
      if (!followRef.current) {
        setPendingCycles((n) => n + fresh.length);
      }
      const merged = [...prev, ...fresh]
        .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
        .slice(-MAX_CYCLES);
      // Drop ids that fell out of the window so re-fetch of old pages can re-add if needed.
      const keep = new Set(merged.map((c) => c.id));
      for (const id of [...seen.current]) {
        if (!keep.has(id)) seen.current.delete(id);
      }
      return merged;
    });
  }, []);

  const loadHead = useCallback(async () => {
    try {
      const res = await fetch("/api/shadow-arbitrage/decision-monitor?limit=12", {
        cache: "no-store",
        credentials: "same-origin"
      });
      if (!res.ok) throw new Error("خواندن ترمینال ناموفق بود");
      const data = (await res.json()) as FeedResponse;
      setSession(data.session);
      mergeCycles(data.rows);
      setLastFetchAt(Date.now());
      setLive("live");
      setError(null);
    } catch (e) {
      setLive("error");
      setError(e instanceof Error ? e.message : "خطا");
    }
  }, [mergeCycles]);

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
      if (Date.now() - lastFetchAt > POLL_MS * 4 && live === "live") setLive("stale");
    }, 2000);
    return () => clearInterval(t);
  }, [lastFetchAt, live]);

  const lines = useMemo(() => cyclesToTerminalLines(cycles), [cycles]);

  // Measure viewport height for virtualization.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewH(el.clientHeight);
    });
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Auto-follow: stick to bottom when follow is on.
  useLayoutEffect(() => {
    if (!follow || paused) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines.length, follow, paused, lines[lines.length - 1]?.id]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom > 80) {
      if (followRef.current) setFollow(false);
    } else if (distFromBottom < 16 && !followRef.current && pendingCycles === 0) {
      // Near bottom with no pending — do not auto-re-enable; user uses resume.
    }
  };

  const goLatest = () => {
    setFollow(true);
    setPendingCycles(0);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    void loadHead();
  };

  const liveLabel =
    live === "live"
      ? "زنده"
      : live === "stale"
        ? "کهنه"
        : live === "error"
          ? "قطع"
          : "…";

  // Virtual window
  const totalH = lines.length * ROW_H;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const visibleCount = Math.ceil(viewH / ROW_H) + OVERSCAN * 2;
  const end = Math.min(lines.length, start + visibleCount);
  const slice = lines.slice(start, end);
  const padTop = start * ROW_H;
  const padBottom = Math.max(0, totalH - end * ROW_H);

  return (
    <div className="sa-term-page" dir="rtl">
      <header className="sa-term-bar">
        <div className="sa-term-bar-left">
          <Link href="/shadow-arbitrage?tab=activity" className="sa-term-back">
            ← فعالیت
          </Link>
          <span
            className={`sa-term-live sa-term-live--${live === "live" ? "on" : live === "stale" ? "stale" : "off"}`}
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

      <div
        className="sa-term-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="ترمینال زندهٔ تصمیم‌گیری"
      >
        {error ? <div className="sa-term-line sa-term-line--warn">{error}</div> : null}
        {!lines.length && live === "loading" ? (
          <div className="sa-term-line sa-term-line--normal">در حال اتصال به موتور…</div>
        ) : null}
        {!lines.length && live === "live" ? (
          <div className="sa-term-line sa-term-line--normal">
            منتظر چرخهٔ بعدی… خروجی خط‌به‌خط اینجا ظاهر می‌شود.
          </div>
        ) : null}

        <div style={{ height: padTop }} aria-hidden />
        {slice.map((line) => {
          const open = openId === line.id;
          return (
            <div key={line.id} className="sa-term-row" style={{ minHeight: ROW_H }}>
              <button
                type="button"
                className={`sa-term-line ${toneClass(line.tone)}${line.kind === "summary" ? " sa-term-line--summary" : ""}`}
                onClick={() => setOpenId(open ? null : line.id)}
              >
                <TermText tone={line.tone} text={line.text} />
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
        <div ref={endRef} className="sa-term-end" />
      </div>
    </div>
  );
}
