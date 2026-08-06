/**
 * Pure Persian labels for the decision-cycle monitor.
 * No I/O. Translates outcome codes and builds readable cycle sentences.
 */
import { toFaDigits } from "@/components/shadowArbitrage/labels";
import { SHADOW_SOURCES } from "@/lib/shadowArbitrage/config";

const VENUE_FA = new Map(SHADOW_SOURCES.map((s) => [s.id, s.nameFa]));

export function venueNameFa(id: string): string {
  return VENUE_FA.get(id as never) ?? id;
}

/** Map engine/API outcome codes to Persian. */
export function outcomeLabelFa(outcome: string | null | undefined): string {
  if (!outcome) return "نامشخص";
  const key = outcome.toLowerCase().trim();
  const map: Record<string, string> = {
    filled: "✓ معامله انجام شد",
    traded: "✓ معامله انجام شد",
    selected: "مسیر انتخاب شد",
    selected_not_filled: "انتخاب شد؛ اجرا تکمیل نشد",
    all_rejected: "همهٔ مسیرها رد شدند",
    no_candidate: "مسیر قابل‌معامله پیدا نشد",
    empty: "مسیر قابل‌معامله پیدا نشد",
    source_unavailable: "دادهٔ منبع در دسترس نبود",
    valid_not_selected: "مسیر معتبر بود ولی انتخاب نشد",
    no_fill: "معامله‌ای انجام نشد",
    evaluating: "در حال بررسی"
  };
  return map[key] ?? outcome;
}

export function candidateStatusLabelFa(status: string | null | undefined): string {
  if (!status) return "نامشخص";
  const map: Record<string, string> = {
    evaluating: "در حال بررسی",
    rejected: "رد شد",
    valid: "معتبر",
    selected: "انتخاب شد",
    traded: "✓ معامله شد",
    failed: "اجرای ناموفق"
  };
  return map[status] ?? status;
}

/**
 * Readable Persian summary of a cycle's counts.
 * Example: «۵۶ مسیر بررسی شد · ۵۶ مسیر رد شد · ۰ مسیر معتبر · معامله‌ای انجام نشد»
 */
export function cycleCountsSentenceFa(input: {
  candidatesEvaluated: number;
  rejectedCount: number;
  validCount: number;
  selectedCount: number;
  filledCount: number;
}): string {
  const n = (x: number) => toFaDigits(x);
  const parts = [
    `${n(input.candidatesEvaluated)} مسیر بررسی شد`,
    `${n(input.rejectedCount)} مسیر رد شد`,
    `${n(input.validCount)} مسیر معتبر`,
    input.selectedCount > 0
      ? `${n(input.selectedCount)} مسیر انتخاب شد`
      : null,
    input.filledCount > 0
      ? `${n(input.filledCount)} معامله انجام شد`
      : "معامله‌ای انجام نشد"
  ].filter(Boolean);
  return parts.join(" · ");
}

/** Dominant rejection reason from candidate list or cycle reason. */
export function dominantRejectionFa(
  candidates: Array<{ status: string; reasonFa: string | null }>,
  fallback: string | null
): string {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    if (c.status !== "rejected" || !c.reasonFa) continue;
    counts.set(c.reasonFa, (counts.get(c.reasonFa) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  if (best) return best;
  if (fallback) return fallback;
  return "دلیل غالب ثبت نشده";
}

/**
 * Short Persian decision path for one cycle (what happened and why).
 */
export function cycleDecisionPathFa(input: {
  outcome: string;
  outcomeReasonFa: string | null;
  candidates: Array<{
    rank: number;
    status: string;
    selected: boolean;
    buySourceId: string;
    sellSourceId: string;
    sizeUsdt: number;
    economicNetPnlToman: number | null;
    reasonFa: string | null;
    bindingConstraint: string | null;
    sizingReason: string | null;
  }>;
  filledCount: number;
}): string {
  const best = [...input.candidates].sort((a, b) => {
    const ae = a.economicNetPnlToman ?? -Infinity;
    const be = b.economicNetPnlToman ?? -Infinity;
    if (be !== ae) return be - ae;
    return a.rank - b.rank;
  })[0];
  const traded = input.candidates.find((c) => c.status === "traded");
  const selected = input.candidates.find((c) => c.selected);

  if (traded) {
    return [
      `بهترین مسیر معامله‌شده: ${venueNameFa(traded.buySourceId)} → ${venueNameFa(traded.sellSourceId)} با حجم ${toFaDigits(traded.sizeUsdt)} تتر.`,
      traded.sizingReason ? `دلیل انتخاب: ${traded.sizingReason}.` : null,
      traded.bindingConstraint ? `محدودکننده: ${traded.bindingConstraint}.` : null,
      "✓ این کاندید به معاملهٔ کاغذی لینک شده است."
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (selected && input.filledCount === 0) {
    return [
      `مسیر انتخاب شد ولی اجرا تکمیل نشد: ${venueNameFa(selected.buySourceId)} → ${venueNameFa(selected.sellSourceId)}.`,
      selected.reasonFa || selected.sizingReason || "دلیل تکمیل‌نشدن در ردپا ثبت نشده."
    ].join(" ");
  }

  if (best && best.status === "rejected") {
    return [
      best.economicNetPnlToman !== null && best.economicNetPnlToman > 0
        ? `بهترین کاندید از نظر سود ثبت‌شده (${venueNameFa(best.buySourceId)} → ${venueNameFa(best.sellSourceId)}) رد شد.`
        : `هیچ مسیر معتبری باقی نماند.`,
      best.reasonFa ? `دلیل غالب: ${best.reasonFa}.` : null,
      best.bindingConstraint ? `محدودکننده: ${best.bindingConstraint}.` : null,
      "به همین دلیل معامله‌ای باز نشد."
    ]
      .filter(Boolean)
      .join(" ");
  }

  if (input.candidates.length === 0) {
    return (
      input.outcomeReasonFa ||
      "جزئیات کامل این چرخه ثبت نشده است — فقط شمارنده‌های خلاصه موجود است."
    );
  }

  return input.outcomeReasonFa || outcomeLabelFa(input.outcome);
}

export function formatAgeFa(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${toFaDigits(s)} ثانیه پیش`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${toFaDigits(m)} دقیقه پیش`;
  const h = Math.floor(m / 60);
  return `${toFaDigits(h)} ساعت پیش`;
}

/**
 * Parse API/Postgres timestamps reliably (incl. Safari).
 * Accepts `2026-08-06 19:03:39.093+03` and ISO forms.
 */
export function parseOccurredAtMs(raw: string | null | undefined): number {
  if (!raw) return 0;
  const s = String(raw).trim();
  let t = Date.parse(s);
  if (Number.isFinite(t)) return t;
  // space → T; +03 → +03:00; drop trailing junk
  let norm = s.replace(" ", "T");
  norm = norm.replace(/([+-]\d{2})(?::?(\d{2}))?$/, (_m, hh: string, mm?: string) =>
    mm ? `${hh}:${mm}` : `${hh}:00`
  );
  t = Date.parse(norm);
  if (Number.isFinite(t)) return t;
  // last resort: strip tz
  t = Date.parse(norm.replace(/[+-]\d{2}:\d{2}$/, "Z"));
  return Number.isFinite(t) ? t : 0;
}

/** HH:mm:ss in Asia/Tehran with Persian digits (for terminal lines). */
export function formatTerminalClockFa(iso: string): string {
  const ms = parseOccurredAtMs(iso);
  if (!ms) return "——:——:——";
  const d = new Date(ms);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tehran",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(d);
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  const s = parts.find((p) => p.type === "second")?.value ?? "00";
  return toFaDigits(`${h}:${m}:${s}`);
}

function fmtAmt(n: number): string {
  return toFaDigits(Math.round(n).toLocaleString("en-US"));
}

export type TerminalLineTone = "normal" | "reject" | "valid" | "trade" | "warn";

/** Columnar terminal row — never a free-form wrapping sentence. */
export type TerminalLineModel = {
  id: string;
  kind: "candidate" | "summary" | "trade" | "missing";
  tone: TerminalLineTone;
  /** Epoch ms for stable append order (not for display). */
  atMs: number;
  clock: string;
  route: string;
  size: string;
  net: string;
  result: string;
  /** Full single-line text for tests / a11y. */
  text: string;
  tech: string | null;
};

/**
 * Compact candidate columns:
 * `زمان | مسیر | حجم | سود خالص | نتیجه`
 * Example: `۱۹:۲۳:۰۹ | رمزینکس ← والکس | ۱۰ USDT | خالص: ثبت نشده | رد شد: کارمزد تأییدنشده`
 */
export function candidateTerminalLine(input: {
  occurredAt: string;
  buySourceId: string;
  sellSourceId: string;
  sizeUsdt: number;
  grossSpreadToman: number | null;
  feeTomanTotal: number | null;
  economicNetPnlToman: number | null;
  status: string;
  reasonFa: string | null;
  ledgerId: string | null;
}): Omit<TerminalLineModel, "id" | "kind" | "atMs" | "tech"> {
  const clock = formatTerminalClockFa(input.occurredAt);
  const buy = venueNameFa(input.buySourceId);
  const sell = venueNameFa(input.sellSourceId);
  const volNum = Number.isInteger(input.sizeUsdt)
    ? String(input.sizeUsdt)
    : input.sizeUsdt.toFixed(2);
  const size = `${toFaDigits(volNum)} USDT`;
  // Compact route — no repeated «خرید از / فروش در»
  const route = `${buy} ← ${sell}`;

  if (input.status === "traded" && input.ledgerId) {
    const net =
      input.economicNetPnlToman != null
        ? `خالص: ${fmtAmt(input.economicNetPnlToman)}`
        : "خالص: ثبت نشده";
    const result = "✓ معامله شد";
    const text = `${clock} | ${route} | ${size} | ${net} | ${result}`;
    return { tone: "trade", clock, route, size, net, result, text };
  }

  if (input.status === "traded" && !input.ledgerId) {
    const net =
      input.economicNetPnlToman != null
        ? `خالص: ${fmtAmt(input.economicNetPnlToman)}`
        : "خالص: ثبت نشده";
    const result = "انتخاب شد؛ اجرا تکمیل نشد";
    return {
      tone: "valid",
      clock,
      route,
      size,
      net,
      result,
      text: `${clock} | ${route} | ${size} | ${net} | ${result}`
    };
  }

  if (input.status === "rejected") {
    const reason = input.reasonFa?.trim() || "دلیل ثبت نشده";
    const net =
      input.economicNetPnlToman != null
        ? input.economicNetPnlToman <= 0
          ? "خالص: منفی"
          : `خالص: ${fmtAmt(input.economicNetPnlToman)}`
        : "خالص: ثبت نشده";
    const result = `رد شد: ${reason}`;
    return {
      tone: "reject",
      clock,
      route,
      size,
      net,
      result,
      text: `${clock} | ${route} | ${size} | ${net} | ${result}`
    };
  }

  let net: string;
  if (input.economicNetPnlToman == null) net = "خالص: ثبت نشده";
  else if (input.economicNetPnlToman > 0) net = `خالص: +${fmtAmt(input.economicNetPnlToman)}`;
  else if (input.economicNetPnlToman < 0) net = `خالص: ${fmtAmt(input.economicNetPnlToman)}`;
  else net = "خالص: ۰";

  const statusFa = candidateStatusLabelFa(input.status);
  const tone: TerminalLineTone =
    input.status === "valid" || input.status === "selected" ? "valid" : "normal";
  return {
    tone,
    clock,
    route,
    size,
    net,
    result: statusFa,
    text: `${clock} | ${route} | ${size} | ${net} | ${statusFa}`
  };
}

/** Final cycle summary — still exactly one grid row. */
export function cycleSummaryTerminalLine(input: {
  cycleId: string;
  candidatesEvaluated: number;
  rejectedCount: number;
  validCount: number;
  selectedCount: number;
  filledCount: number;
  traceComplete: boolean;
  source: string;
  occurredAt?: string;
}): Omit<TerminalLineModel, "id" | "kind" | "atMs" | "tech"> {
  const shortId = input.cycleId.slice(0, 8);
  const clock = input.occurredAt ? formatTerminalClockFa(input.occurredAt) : "——:——:——";
  if (!input.traceComplete || input.source === "cycle_summary_only") {
    const result = "جزئیات کامل ثبت نشده";
    const text = `چرخه ${shortId} | ${toFaDigits(input.candidatesEvaluated)} خلاصه | — | — | ${result}`;
    return {
      tone: "warn",
      clock,
      route: `چرخه ${shortId}`,
      size: `${toFaDigits(input.candidatesEvaluated)} مسیر`,
      net: "—",
      result,
      text
    };
  }
  const tradePart =
    input.filledCount > 0
      ? `${toFaDigits(input.filledCount)} معامله`
      : "بدون معامله";
  const result = tradePart;
  const route = `چرخه ${shortId}`;
  const size = `${toFaDigits(input.candidatesEvaluated)} مسیر`;
  const net = `${toFaDigits(input.rejectedCount)} رد · ${toFaDigits(input.validCount)} معتبر`;
  const text = `${clock} | ${route} | ${size} | ${net} | ${result}`;
  return {
    tone: input.filledCount > 0 ? "trade" : "normal",
    clock,
    route,
    size,
    net,
    result,
    text
  };
}

type CycleLike = {
  id: string;
  occurredAt: string;
  candidatesEvaluated: number;
  rejectedCount: number;
  validCount: number;
  selectedCount: number;
  filledCount: number;
  traceComplete: boolean;
  source: string;
  candidates: Array<{
    rank: number;
    lifecycleId: string;
    buySourceId: string;
    sellSourceId: string;
    sizeUsdt: number;
    grossSpreadToman: number | null;
    feeTomanTotal: number | null;
    economicNetPnlToman: number | null;
    status: string;
    reasonFa: string | null;
    ledgerId: string | null;
    routeKey: string;
    reasonCodes: string[];
    buyVwapToman: number | null;
    sellVwapToman: number | null;
    buyFeeBps: number | null;
    sellFeeBps: number | null;
    capitalCapUsdt: number | null;
    depthCapUsdt: number | null;
    bindingConstraint: string | null;
  }>;
};

/** Expand cycles (any order) into chronological terminal lines — stable ids. */
export function cyclesToTerminalLines(cycles: CycleLike[]): TerminalLineModel[] {
  const ordered = [...cycles].sort(
    (a, b) => parseOccurredAtMs(a.occurredAt) - parseOccurredAtMs(b.occurredAt)
  );
  const out: TerminalLineModel[] = [];
  for (const cyc of ordered) {
    const atMs = parseOccurredAtMs(cyc.occurredAt);
    if (!cyc.traceComplete || cyc.source === "cycle_summary_only" || !cyc.candidates.length) {
      const sum = cycleSummaryTerminalLine({
        cycleId: cyc.id,
        candidatesEvaluated: cyc.candidatesEvaluated,
        rejectedCount: cyc.rejectedCount,
        validCount: cyc.validCount,
        selectedCount: cyc.selectedCount,
        filledCount: cyc.filledCount,
        traceComplete: cyc.traceComplete,
        source: cyc.source,
        occurredAt: cyc.occurredAt
      });
      out.push({
        id: `${cyc.id}:summary`,
        kind: "missing",
        atMs,
        ...sum,
        tech: `cycle=${cyc.id} occurredAt=${cyc.occurredAt} source=${cyc.source}`
      });
      continue;
    }
    const sorted = [...cyc.candidates].sort((a, b) => a.rank - b.rank);
    for (const c of sorted) {
      const line = candidateTerminalLine({
        occurredAt: cyc.occurredAt,
        buySourceId: c.buySourceId,
        sellSourceId: c.sellSourceId,
        sizeUsdt: c.sizeUsdt,
        grossSpreadToman: c.grossSpreadToman,
        feeTomanTotal: c.feeTomanTotal,
        economicNetPnlToman: c.economicNetPnlToman,
        status: c.status,
        reasonFa: c.reasonFa,
        ledgerId: c.ledgerId
      });
      out.push({
        id: `${cyc.id}:c${c.rank}:${c.lifecycleId}`,
        kind: c.status === "traded" && c.ledgerId ? "trade" : "candidate",
        atMs,
        ...line,
        tech: [
          `lifecycle=${c.lifecycleId}`,
          `route=${c.routeKey}`,
          c.reasonCodes?.length ? `codes=${c.reasonCodes.join(",")}` : null,
          c.buyVwapToman != null ? `buyVwap=${c.buyVwapToman}` : null,
          c.sellVwapToman != null ? `sellVwap=${c.sellVwapToman}` : null,
          c.buyFeeBps != null ? `buyFeeBps=${c.buyFeeBps}` : null,
          c.sellFeeBps != null ? `sellFeeBps=${c.sellFeeBps}` : null,
          c.capitalCapUsdt != null ? `capitalCap=${c.capitalCapUsdt}` : null,
          c.depthCapUsdt != null ? `depthCap=${c.depthCapUsdt}` : null,
          c.bindingConstraint ? `binding=${c.bindingConstraint}` : null,
          c.ledgerId ? `ledger=${c.ledgerId}` : null
        ]
          .filter(Boolean)
          .join(" · ")
      });
    }
    const sum = cycleSummaryTerminalLine({
      cycleId: cyc.id,
      candidatesEvaluated: cyc.candidatesEvaluated,
      rejectedCount: cyc.rejectedCount,
      validCount: cyc.validCount,
      selectedCount: cyc.selectedCount,
      filledCount: cyc.filledCount,
      traceComplete: cyc.traceComplete,
      source: cyc.source,
      occurredAt: cyc.occurredAt
    });
    out.push({
      id: `${cyc.id}:summary`,
      kind: "summary",
      atMs,
      ...sum,
      tech: `cycle=${cyc.id} occurredAt=${cyc.occurredAt}`
    });
  }
  return out;
}
