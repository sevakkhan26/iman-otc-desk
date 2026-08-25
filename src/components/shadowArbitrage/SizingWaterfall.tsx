"use client";

/**
 * A→F sizing waterfall from persisted RouteSizingView audit fields.
 * Presentation only — never recomputes caps or invents missing stages.
 */
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { toFaDigits } from "@/components/shadowArbitrage/labels";
import type { RouteSizingView } from "@/components/shadowArbitrage/CommandCenter";

const NA_FA = "ناموجود";

function usdtFromMicros(micros: number | null | undefined): string | null {
  if (micros === null || micros === undefined || !Number.isFinite(micros)) return null;
  return (micros / 1_000_000).toFixed(4);
}

function minDefined(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
  if (!nums.length) return null;
  return Math.min(...nums);
}

type Stage = {
  id: "A" | "B" | "C" | "D" | "E" | "F";
  titleFa: string;
  hintFa: string;
  usdt: string | null;
  detailFa: string | null;
  binding: boolean;
};

export function SizingWaterfall({
  route,
  compact = false
}: {
  route: RouteSizingView | null;
  compact?: boolean;
}) {
  if (!route) {
    return (
      <section className="sa-wf" aria-label="آبشار حجم A تا F">
        <header className="sa-wf-head">
          <h3 className="sa-wf-title">آبشار حجم A→F</h3>
          <p className="sa-sub">از دادهٔ ممیزی همین چرخه — نه برچسب ساختگی</p>
        </header>
        <p className="sa-unknown">ممیزی حجم برای این مسیر در این چرخه ارسال نشده است.</p>
      </section>
    );
  }

  const cap = route.sizing.capacity;
  const constraints = route.sizing.constraints ?? [];
  const byKey = new Map(constraints.map((c) => [c.key, c]));
  const binding = route.sizing.bindingConstraint;

  const totalBuy = cap?.buyDepth.totalDepthMicros ?? null;
  const totalSell = cap?.sellDepth.totalDepthMicros ?? null;
  const hardBuy = cap?.buyDepth.depthMicros ?? null;
  const hardSell = cap?.sellDepth.depthMicros ?? null;
  const slipBps = cap?.buyDepth.maxSlippageBps ?? cap?.sellDepth.maxSlippageBps ?? null;

  const dKeys = ["capital_cap", "buy_irt_balance", "sell_usdt_balance", "venue_allocation"] as const;
  const dCaps = dKeys.map((k) => byKey.get(k)?.capUsdtMicros ?? null);
  const dMin = minDefined(dCaps);
  const dParts = dKeys
    .map((k) => {
      const c = byKey.get(k);
      if (!c) return null;
      const v = usdtFromMicros(c.capUsdtMicros);
      return `${c.labelFa}: ${v ?? NA_FA}`;
    })
    .filter(Boolean)
    .join(" · ");

  const e = byKey.get("dynamic_risk_cap");
  const selectedMicros =
    route.sizing.selection?.selectedSizeUsdtMicros ??
    (route.sizing.sizeUsdt !== null && Number.isFinite(route.sizing.sizeUsdt)
      ? Math.round(route.sizing.sizeUsdt * 1_000_000)
      : null);

  const stages: Stage[] = [
    {
      id: "A",
      titleFa: "عمق خام قابل‌مشاهده",
      hintFa: "Σ تمام سطوح معتبر دفتر — نه ظرفیت اجرا",
      usdt: usdtFromMicros(minDefined([totalBuy, totalSell])),
      detailFa:
        totalBuy == null && totalSell == null
          ? null
          : `خرید ${usdtFromMicros(totalBuy) ?? NA_FA} · فروش ${usdtFromMicros(totalSell) ?? NA_FA} تتر`,
      binding: binding === "depth_evidence"
    },
    {
      id: "B",
      titleFa: "عمق پذیرفته‌شده HARD",
      hintFa:
        slipBps != null
          ? `سطوح داخل سقف لغزش ${toFaDigits(slipBps)} bps`
          : "عمق پس از سقف لغزش سیاست",
      usdt: usdtFromMicros(minDefined([hardBuy, hardSell])),
      detailFa:
        hardBuy == null && hardSell == null
          ? null
          : `خرید ${usdtFromMicros(hardBuy) ?? NA_FA} · فروش ${usdtFromMicros(hardSell) ?? NA_FA} تتر`,
      binding: binding === "depth_cap"
    },
    {
      id: "C",
      titleFa: "ظرفیت اجراپذیر دو پا",
      hintFa: cap
        ? `سمت محدودکننده: ${cap.limitingSide === "buy" ? "خرید" : "فروش"} (${cap.limitingSourceId})`
        : "کمینهٔ دو پا پس از کارمزد",
      usdt: usdtFromMicros(cap?.limitingUsableMicros ?? null),
      detailFa: cap ? `سقف سرمایه ${usdtFromMicros(cap.capitalCapMicros) ?? NA_FA} تتر` : null,
      binding: binding === "capital_cap"
    },
    {
      id: "D",
      titleFa: "فضای موجودی / تخصیص",
      hintFa: "موجودی، سهم طرح سرمایه، سقف سرمایه",
      usdt: usdtFromMicros(dMin),
      detailFa: dParts || null,
      binding:
        binding === "buy_irt_balance" ||
        binding === "sell_usdt_balance" ||
        binding === "venue_allocation"
    },
    {
      id: "E",
      titleFa: "سقف پویای ریسک",
      hintFa: e?.detailFa ?? "dynamic_risk_cap",
      usdt: usdtFromMicros(e?.capUsdtMicros ?? null),
      detailFa: e?.labelFa ?? null,
      binding: binding === "dynamic_risk_cap"
    },
    {
      id: "F",
      titleFa: "حجم انتخاب‌شده q*",
      hintFa: route.sizing.selection?.reasonFa ?? route.sizing.policy,
      usdt: usdtFromMicros(selectedMicros),
      detailFa:
        route.sizing.status === "SIZED"
          ? "بهینه‌ساز MAX_RA_PNL — اقتصاد کانونی"
          : route.sizing.blockers[0]?.detailFa ?? "حجمی انتخاب نشد",
      binding: false
    }
  ];

  const next = route.sizing.selection?.nextLarger ?? null;
  const bindingLabel =
    constraints.find((c) => c.key === binding)?.labelFa ?? binding ?? null;

  return (
    <section className={`sa-wf${compact ? " sa-wf-compact" : ""}`} aria-label="آبشار حجم A تا F">
      <header className="sa-wf-head">
        <h3 className="sa-wf-title">آبشار حجم A→F</h3>
        <p className="sa-sub">
          {route.buySourceId} ← {route.sellSourceId}
          {bindingLabel ? ` · محدودکننده: ${bindingLabel}` : ""}
        </p>
      </header>
      <ol className="sa-wf-rail">
        {stages.map((s) => (
          <li key={s.id} className={`sa-wf-stage${s.binding ? " is-binding" : ""}`}>
            <span className="sa-wf-letter">{s.id}</span>
            <span className="sa-wf-stage-title">{s.titleFa}</span>
            <span className="sa-wf-stage-value">
              {s.usdt ? (
                <>
                  <Bidi>{toFaDigits(s.usdt)}</Bidi> تتر
                </>
              ) : (
                <span className="sa-unknown" title={s.hintFa}>
                  {NA_FA}
                </span>
              )}
            </span>
            <span className="sa-wf-stage-hint">{s.hintFa}</span>
            {s.detailFa ? <span className="sa-wf-stage-detail sa-sub">{s.detailFa}</span> : null}
            {s.binding ? <span className="sa-chip sa-chip-sm sa-chip-warn">محدودکننده</span> : null}
          </li>
        ))}
      </ol>
      <p className="sa-wf-next sa-sub">
        <span className="sa-strong">چرا بزرگ‌تر نه؟ </span>
        {next ? (
          <>
            نامزد بعدی <Bidi>{toFaDigits(usdtFromMicros(next.sizeUsdtMicros) ?? "")}</Bidi> تتر —{" "}
            <span className="sa-chip sa-chip-sm sa-chip-warn">{next.code}</span> {next.detailFa}
          </>
        ) : route.sizing.status === "SIZED" ? (
          "هیچ نامزد بزرگ‌تری در ممیزی نیست؛ q* خودِ سقف محدودکننده است یا بهترین سود تعدیل‌شده."
        ) : (
          "حجم انتخاب نشده؛ رد بزرگ‌تر موضوعیت ندارد."
        )}
      </p>
    </section>
  );
}
