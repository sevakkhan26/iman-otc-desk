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
