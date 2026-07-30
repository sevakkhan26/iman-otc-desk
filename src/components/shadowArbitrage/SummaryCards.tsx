"use client";

import { TomanAmount } from "@/components/TomanAmount";
import {
  NO_VALID_OPPORTUNITY_FA,
  classifyOpportunity,
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
  const classed = active.map((o) => ({ o, cls: classifyOpportunity(o) }));

  const valid = classed.filter((c) => c.cls === "valid").map((c) => c.o);
  const raw = classed.filter((c) => c.cls === "raw").map((c) => c.o);
  const blocked = classed.filter((c) => c.cls === "blocked").map((c) => c.o);

  const bestNet = valid.reduce<ShadowOpportunity | null>(
    (best, o) => (!best || o.netProfitToman > best.netProfitToman ? o : best),
    null
  );
  const totalNet = valid.reduce((sum, o) => sum + o.netProfitToman, 0);
  const healthy = sources.filter((s) => s.health === "healthy").length;
  const verifiedAccounts = sources.filter((s) => s.accountStatus === "verified").length;
  const needAccounts = sources.filter((s) => s.accountStatus !== "verified").length;

  const cards: Card[] = [
    {
      key: "best-net",
      label: "بهترین فرصت معتبر",
      value: bestNet ? <TomanAmount value={bestNet.netProfitToman} /> : "—",
      hint: bestNet
        ? `خرید از ${bestNet.buySourceName} · فروش در ${bestNet.sellSourceName} · ${toFaDigits(bestNet.sizeUsdt)} تتر`
        : NO_VALID_OPPORTUNITY_FA,
      tone: bestNet ? "good" : "muted"
    },
    {
      key: "valid",
      label: "فرصت معتبر و خالص مثبت",
      value: formatCountFa(valid.length),
      hint: "کارمزد معلوم، عمق کافی، حساب موجود، سود مثبت",
      tone: valid.length ? "good" : "muted"
    },
    {
      key: "checked",
      label: "مسیرهای بررسی‌شده",
      value: formatCountFa(active.length),
      hint: `پتانسیل خام یا مرجع: ${formatCountFa(raw.length)}`
    },
    {
      key: "blocked",
      label: "مسیرهای مسدودشده",
      value: formatCountFa(blocked.length),
      hint: "دلیل مسدودی در جدول و جزئیات",
      tone: blocked.length ? "warn" : "muted"
    },
    {
      key: "total-net",
      label: "سود خالص نظری (فرصت‌های معتبر)",
      value: valid.length ? <TomanAmount value={totalNet} /> : "—",
      hint: valid.length ? `مجموع ${formatCountFa(valid.length)} فرصت معتبر` : NO_VALID_OPPORTUNITY_FA,
      tone: valid.length ? "good" : "muted"
    },
    {
      key: "healthy",
      label: "منابع سالم",
      value: `${toFaDigits(healthy)} از ${toFaDigits(sources.length || 9)}`,
      hint: "در آخرین چرخه پاسخ سالم دادند",
      tone: healthy >= 7 ? "good" : healthy >= 4 ? "warn" : "danger"
    },
    {
      key: "accounts",
      label: "حساب‌های احرازشده",
      value: `${toFaDigits(verifiedAccounts)} از ${toFaDigits(sources.length || 9)}`,
      hint: `نیازمند افتتاح حساب: ${toFaDigits(needAccounts)} صرافی`,
      tone: "muted"
    },
    {
      key: "coverage",
      label: "پاسخ‌دهی منابع در چرخه اخیر",
      value: formatPercentFa(dataCoveragePercent, 1),
      hint: "این عدد پوشش پایش نیست"
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
