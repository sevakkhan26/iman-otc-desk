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

/** HH:mm:ss in Asia/Tehran with Persian digits (for terminal lines). */
export function formatTerminalClockFa(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "——:——:——";
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

export type TerminalLineModel = {
  id: string;
  kind: "candidate" | "summary" | "trade" | "missing";
  tone: TerminalLineTone;
  /** Primary compact line text (Persian, no cryptic eng counters). */
  text: string;
  /** Collapsed technical dump when the line is opened. */
  tech: string | null;
};

/**
 * One compact terminal line for a candidate evaluation.
 * Example:
 * `۱۸:۴۲:۱۱ | خرید از ارزینجا → فروش در تبدیل | ۷۰٫۸۳ USDT | ناخالص ۵۳,۱۲۷ | کارمزد ۳۶,۹۸۱ | خالص +۱۶,۱۴۶ تومان | معتبر`
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
}): { text: string; tone: TerminalLineTone } {
  const clock = formatTerminalClockFa(input.occurredAt);
  const buy = venueNameFa(input.buySourceId);
  const sell = venueNameFa(input.sellSourceId);
  const vol = toFaDigits(
    Number.isInteger(input.sizeUsdt)
      ? String(input.sizeUsdt)
      : input.sizeUsdt.toFixed(2)
  );
  const route = `خرید از ${buy} → فروش در ${sell}`;

  // Bright checkmark only for linked completed Paper trades.
  if (input.status === "traded" && input.ledgerId) {
    const net =
      input.economicNetPnlToman != null
        ? `سود خالص ${fmtAmt(input.economicNetPnlToman)} تومان`
        : "سود خالص ثبت نشده";
    return {
      tone: "trade",
      text: `✓ معامله شد | ${route} | حجم ${vol} USDT | ${net}`
    };
  }

  if (input.status === "traded" && !input.ledgerId) {
    return {
      tone: "valid",
      text: `${clock} | ${route} | ${vol} USDT | انتخاب شد؛ اجرا تکمیل نشد`
    };
  }

  if (input.status === "rejected") {
    const reason = input.reasonFa?.trim() || "دلیل ثبت نشده";
    const netPart =
      input.economicNetPnlToman != null && input.economicNetPnlToman <= 0
        ? "خالص منفی"
        : input.economicNetPnlToman != null
          ? `خالص ${fmtAmt(input.economicNetPnlToman)}`
          : input.grossSpreadToman != null
            ? `ناخالص ${fmtAmt(input.grossSpreadToman)}`
            : "خالص ثبت نشده";
    return {
      tone: "reject",
      text: `${clock} | ${route} | ${vol} USDT | ${netPart} | رد شد: ${reason}`
    };
  }

  const gross =
    input.grossSpreadToman != null ? `ناخالص ${fmtAmt(input.grossSpreadToman)}` : "ناخالص —";
  const fee =
    input.feeTomanTotal != null ? `کارمزد ${fmtAmt(input.feeTomanTotal)}` : "کارمزد —";
  let net: string;
  if (input.economicNetPnlToman == null) net = "خالص —";
  else if (input.economicNetPnlToman > 0)
    net = `خالص +${fmtAmt(input.economicNetPnlToman)} تومان`;
  else if (input.economicNetPnlToman < 0)
    net = `خالص ${fmtAmt(input.economicNetPnlToman)} تومان`;
  else net = "خالص ۰ تومان";

  const statusFa = candidateStatusLabelFa(input.status);
  const tone: TerminalLineTone =
    input.status === "valid" || input.status === "selected" ? "valid" : "normal";

  return {
    tone,
    text: `${clock} | ${route} | ${vol} USDT | ${gross} | ${fee} | ${net} | ${statusFa}`
  };
}

/** Final cycle summary line for the terminal. */
export function cycleSummaryTerminalLine(input: {
  cycleId: string;
  candidatesEvaluated: number;
  rejectedCount: number;
  validCount: number;
  selectedCount: number;
  filledCount: number;
  traceComplete: boolean;
  source: string;
}): { text: string; tone: TerminalLineTone } {
  const shortId = input.cycleId.slice(0, 8);
  if (!input.traceComplete || input.source === "cycle_summary_only") {
    return {
      tone: "warn",
      text: `چرخه ${shortId} تمام شد | جزئیات کامل این چرخه ثبت نشده است | ${toFaDigits(input.candidatesEvaluated)} شمارندهٔ خلاصه`
    };
  }
  const tradePart =
    input.filledCount > 0
      ? `${toFaDigits(input.filledCount)} معامله انجام شد`
      : "معامله‌ای انجام نشد";
  const selectedPart =
    input.selectedCount > 0
      ? ` | ${toFaDigits(input.selectedCount)} انتخاب‌شده`
      : "";
  return {
    tone: input.filledCount > 0 ? "trade" : "normal",
    text: `چرخه ${shortId} تمام شد | ${toFaDigits(input.candidatesEvaluated)} مسیر بررسی شد | ${toFaDigits(input.rejectedCount)} رد شد | ${toFaDigits(input.validCount)} معتبر${selectedPart} | ${tradePart}`
  };
}

/** Expand API cycle rows (newest-first) into chronological terminal lines. */
export function cyclesToTerminalLines(
  cycles: Array<{
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
  }>
): TerminalLineModel[] {
  // Chronological: oldest first so newest is at the bottom of the terminal.
  const ordered = [...cycles].sort(
    (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt)
  );
  const out: TerminalLineModel[] = [];
  for (const cyc of ordered) {
    if (!cyc.traceComplete || cyc.source === "cycle_summary_only" || !cyc.candidates.length) {
      const sum = cycleSummaryTerminalLine({
        cycleId: cyc.id,
        candidatesEvaluated: cyc.candidatesEvaluated,
        rejectedCount: cyc.rejectedCount,
        validCount: cyc.validCount,
        selectedCount: cyc.selectedCount,
        filledCount: cyc.filledCount,
        traceComplete: cyc.traceComplete,
        source: cyc.source
      });
      out.push({
        id: `${cyc.id}:summary`,
        kind: "missing",
        tone: sum.tone,
        text: sum.text,
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
        tone: line.tone,
        text: line.text,
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
      source: cyc.source
    });
    out.push({
      id: `${cyc.id}:summary`,
      kind: "summary",
      tone: sum.tone,
      text: sum.text,
      tech: `cycle=${cyc.id} occurredAt=${cyc.occurredAt}`
    });
  }
  return out;
}
