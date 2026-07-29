"use client";

import { TomanAmount } from "@/components/TomanAmount";
import {
  formatCountFa,
  formatPercentFa,
  toFaDigits
} from "@/components/shadowArbitrage/labels";
import type { NormalizedSourceSnapshot, ShadowOpportunity } from "@/components/shadowArbitrage/types";

type Props = {
  opportunities: ShadowOpportunity[];
  sources: NormalizedSourceSnapshot[];
  dataCoveragePercent: number | null;
  loading: boolean;
};

type Card = {
  key: string;
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "good" | "warn" | "muted" | "danger";
};

/**
 * Section B — eight facts an admin can read in three seconds.
 * Raw spread and net profit are never mixed: net figures only ever come from
 * opportunities whose fees are known on both legs.
 */
export function SummaryCards({ opportunities, sources, dataCoveragePercent, loading }: Props) {
  const active = opportunities.filter((o) => o.isActive);

  // Net-eligible = fees known on both legs and not blocked.
  const netEligible = active.filter(
    (o) => !o.feeUnknown && o.eligibility !== "BLOCKED" && o.netProfitToman > 0
  );
  const bestNet = netEligible.reduce<ShadowOpportunity | null>(
    (best, o) => (!best || o.netProfitToman > best.netProfitToman ? o : best),
    null
  );

  const bestRaw = active.reduce<ShadowOpportunity | null>(
    (best, o) => (!best || o.rawSpreadPercent > best.rawSpreadPercent ? o : best),
    null
  );

  const totalNet = netEligible.reduce((sum, o) => sum + o.netProfitToman, 0);
  const usableNow = active.filter((o) => o.eligibility === "EXECUTABLE_NOW").length;
  const needAccount = active.filter((o) => o.eligibility === "ACCOUNT_REQUIRED").length;
  const healthy = sources.filter((s) => s.health === "healthy").length;

  const cards: Card[] = [
    {
      key: "best-net",
      label: "بهترین فرصت معتبر",
      value: bestNet ? <TomanAmount value={bestNet.netProfitToman} /> : "—",
      hint: bestNet
        ? `${bestNet.buySourceName} → ${bestNet.sellSourceName} · ${toFaDigits(bestNet.sizeUsdt)} تتر`
        : "فرصتی با کارمزد معلوم و سود مثبت وجود ندارد",
      tone: bestNet ? "good" : "muted"
    },
    {
      key: "active",
      label: "فرصت‌های فعال",
      value: formatCountFa(active.length),
      hint: "مسیرهایی که همین حالا اسپرد مثبت دارند"
    },
    {
      key: "best-raw",
      label: "بهترین اسپرد خام",
      value: bestRaw ? formatPercentFa(bestRaw.rawSpreadPercent, 3) : "—",
      hint: bestRaw
        ? `${bestRaw.buySourceName} → ${bestRaw.sellSourceName} — پیش از کارمزد`
        : "بدون داده",
      tone: "muted"
    },
    {
      key: "total-net",
      label: "سود خالص نظری",
      value: netEligible.length ? <TomanAmount value={totalNet} /> : "—",
      hint: netEligible.length
        ? `مجموع ${formatCountFa(netEligible.length)} فرصت با کارمزد معلوم`
        : "کارمزد لازم برای محاسبه تأیید نشده است",
      tone: netEligible.length ? "good" : "muted"
    },
    {
      key: "healthy",
      label: "منابع سالم",
      value: `${toFaDigits(healthy)} از ${toFaDigits(sources.length || 9)}`,
      hint: "منابعی که در آخرین چرخه پاسخ سالم دادند",
      tone: healthy >= 7 ? "good" : healthy >= 4 ? "warn" : "danger"
    },
    {
      key: "coverage",
      label: "پوشش پایش",
      value: formatPercentFa(dataCoveragePercent, 1),
      hint: "سهم درخواست‌های موفق در بازهٔ پایش"
    },
    {
      key: "usable",
      label: "قابل استفاده با حساب فعلی",
      value: formatCountFa(usableNow),
      hint: "نوبیتکس، والکس و تبدیل",
      tone: usableNow ? "good" : "muted"
    },
    {
      key: "need-account",
      label: "نیازمند افتتاح حساب",
      value: formatCountFa(needAccount),
      hint: "فرصت‌هایی که با حساب جدید آزاد می‌شوند",
      tone: needAccount ? "warn" : "muted"
    }
  ];

  if (loading && !opportunities.length) {
    return (
      <div className="sa-cards">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="sa-card sa-card-skeleton">
            <div className="sa-skeleton-line short" />
            <div className="sa-skeleton-line" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="sa-cards">
      {cards.map((c) => (
        <div key={c.key} className={`sa-card${c.tone ? ` sa-card-${c.tone}` : ""}`}>
          <div className="sa-card-label">{c.label}</div>
          <div className="sa-card-value">{c.value}</div>
          {c.hint ? <div className="sa-card-hint">{c.hint}</div> : null}
        </div>
      ))}
    </div>
  );
}
