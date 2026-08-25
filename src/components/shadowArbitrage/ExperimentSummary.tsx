"use client";

/**
 * Persistent Paper experiment/session strip + compact history.
 * Numbers come from GET paper (session / experiment / accounting / stats).
 * Missing values render N/A — never fabricated zeros.
 */
import { TomanAmount } from "@/components/TomanAmount";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { formatDurationFa, toFaDigits } from "@/components/shadowArbitrage/labels";
import type { AccountsAccounting } from "@/components/shadowArbitrage/AccountsSection";
import {
  LIFECYCLE_STATUS_FA,
  dayIndexOf,
  durationDaysFromRange,
  finiteOrNull,
  formatTehranExact,
  operatorLifecycleStatus,
  remainingDaysFromMs,
  type ExperimentHistoryRow,
  type OperatorLifecycleStatus
} from "@/components/shadowArbitrage/sessionLifecycle";

export type ExperimentSummarySession = {
  id: string;
  name: string;
  status: string;
  totalCapitalToman: number;
  startedAt?: string | null;
  lastCycleAt?: string | null;
  tradesExecuted?: number;
  candidatesSkipped?: number;
  note?: string | null;
};

export type ExperimentSummaryExperiment = {
  id: string;
  runKey: string;
  status: string;
  startedAt: string;
  endsAt: string;
  startedAtTehran?: string;
  endsAtTehran?: string;
  elapsedMs: number;
  remainingMs: number;
  initialCapitalToman: number;
  sessionId: string | null;
  configuredDurationDays?: number | null;
  filled?: number | null;
  skipped?: number | null;
  lastFillAt?: string | null;
  lastCycleAt?: string | null;
};

export type ExperimentSummaryStats = {
  filled?: number;
  skipped?: number;
  economicNetPnlToman?: number;
  riskAdjustedPnlToman?: number;
  cashPnlIrtToman?: number;
  feeTomanTotal?: number;
  lastFillAt?: string | null;
} | null;

const DASH = <span className="sa-unknown">—</span>;

function chipTone(status: OperatorLifecycleStatus): "good" | "warn" | "danger" | "muted" {
  if (status === "running") return "good";
  if (status === "paused") return "warn";
  if (status === "stopped") return "danger";
  return "muted";
}

function Money({ value }: { value: number | null | undefined }) {
  const n = finiteOrNull(value);
  if (n === null) return DASH;
  return (
    <span className={n > 0 ? "sa-pos" : n < 0 ? "sa-neg" : undefined}>
      <TomanAmount value={n} />
    </span>
  );
}

function Count({ value }: { value: number | null | undefined }) {
  const n = finiteOrNull(value);
  if (n === null) return DASH;
  return <Bidi>{toFaDigits(n)}</Bidi>;
}

export function ExperimentHistoryTable({
  rows,
  loading
}: {
  rows: ExperimentHistoryRow[];
  loading?: boolean;
}) {
  return (
    <section className="panel sa-panel sa-hist-panel" aria-label="تاریخچهٔ آزمایش‌ها">
      <div className="panel-header sa-panel-header">
        <h3 className="panel-title">تاریخچهٔ نشست‌ها</h3>
        <div className="sa-panel-note">نشست‌های قبلی پس از شروع نشست جدید باقی می‌مانند</div>
      </div>
      <div className="panel-body">
        {!rows.length ? (
          <p className="sa-sub">
            {loading ? "در حال خواندن…" : "تاریخچه‌ای در این محیط ثبت نشده است."}
          </p>
        ) : (
          <div className="sa-table-wrap sa-term-wrap sa-hist-wrap">
            <table className="sa-table sa-term-table sa-hist-table">
              <thead>
                <tr>
                  <th>شروع</th>
                  <th>پایان</th>
                  <th className="num">مدت (روز)</th>
                  <th className="num">سرمایه</th>
                  <th className="num">معاملات</th>
                  <th className="num">سود اقتصادی</th>
                  <th className="num">کارمزد</th>
                  <th>وضعیت</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="sa-row">
                    <td className="sa-sub">{formatTehranExact(r.startedAt) ?? "—"}</td>
                    <td className="sa-sub">
                      {formatTehranExact(r.endedAt ?? r.configuredEndsAt) ?? "—"}
                    </td>
                    <td className="num">
                      <Count value={r.configuredDurationDays} />
                    </td>
                    <td className="num">
                      <Money value={r.capitalToman} />
                    </td>
                    <td className="num">
                      <Count value={r.tradesExecuted} />
                    </td>
                    <td className="num">
                      <Money value={r.realizedEconomicPnlToman} />
                    </td>
                    <td className="num">
                      <Money value={r.feesToman} />
                    </td>
                    <td>
                      <span className={`sa-chip sa-chip-sm sa-chip-${chipTone(r.operatorStatus)}`}>
                        {LIFECYCLE_STATUS_FA[r.operatorStatus]}
                      </span>
                      {r.name ? <div className="sa-sub">{r.name}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

type Props = {
  experiment?: ExperimentSummaryExperiment | null;
  session?: ExperimentSummarySession | null;
  accounting?: AccountsAccounting | null;
  stats?: ExperimentSummaryStats;
  serverNow?: string | null;
};

export function ExperimentSummary({
  experiment,
  session,
  accounting,
  stats = null,
  serverNow = null
}: Props) {
  const status = operatorLifecycleStatus({
    sessionStatus: session?.status ?? null,
    experimentStatus: experiment?.status ?? null
  });
  const startedAt = session?.startedAt ?? experiment?.startedAt ?? null;
  const endsAt = experiment?.endsAt ?? null;
  const durationDays =
    finiteOrNull(experiment?.configuredDurationDays) ??
    durationDaysFromRange(startedAt, endsAt);
  const elapsedMs =
    experiment?.elapsedMs != null && Number.isFinite(experiment.elapsedMs)
      ? experiment.elapsedMs
      : startedAt
        ? Math.max(0, Date.parse(serverNow ?? new Date().toISOString()) - Date.parse(startedAt))
        : null;
  const remainingMs = finiteOrNull(experiment?.remainingMs);
  const day = dayIndexOf(elapsedMs, durationDays);
  const remainDays = remainingDaysFromMs(
    status === "running" || status === "paused" ? remainingMs : null
  );
  const name = session?.name ?? experiment?.runKey ?? experiment?.id ?? null;
  const initialCapital =
    finiteOrNull(experiment?.initialCapitalToman) ??
    finiteOrNull(session?.totalCapitalToman) ??
    finiteOrNull(accounting?.initialCapitalToman);
  const equity = finiteOrNull(accounting?.equityToman);
  const filled =
    finiteOrNull(stats?.filled) ??
    finiteOrNull(experiment?.filled) ??
    finiteOrNull(session?.tradesExecuted);
  const skipped =
    finiteOrNull(stats?.skipped) ??
    finiteOrNull(experiment?.skipped) ??
    finiteOrNull(session?.candidatesSkipped);
  const realized =
    finiteOrNull(accounting?.realizedEconomicPnlToman) ??
    finiteOrNull(stats?.economicNetPnlToman);
  const economic = finiteOrNull(accounting?.realizedEconomicPnlToman);
  const ra = finiteOrNull(accounting?.realizedRiskAdjustedPnlToman);
  const fees = finiteOrNull(accounting?.fees.totalFeeTomanEquivalent);
  const lastTrade = stats?.lastFillAt ?? experiment?.lastFillAt ?? null;
  const lastEngine = session?.lastCycleAt ?? experiment?.lastCycleAt ?? null;

  if (!experiment && !session) {
    return (
      <section className="sa-exp-strip" aria-label="آزمایش کاغذی">
        <span className="sa-chip sa-chip-sm sa-chip-muted">ناموجود</span>
        <span className="sa-sub">آزمایش / نشست کاغذی فعال در این محیط نیست.</span>
      </section>
    );
  }

  return (
    <section className="sa-exp-strip" aria-label="خلاصه آزمایش فعال">
      <div className="sa-exp-strip-head">
        <span className={`sa-chip sa-chip-sm sa-chip-${chipTone(status)}`}>
          {LIFECYCLE_STATUS_FA[status]}
        </span>
        {durationDays != null ? (
          <span className="sa-chip sa-chip-sm sa-chip-muted">
            {toFaDigits(durationDays)} روز
          </span>
        ) : null}
        <strong className="sa-exp-strip-name">{name ?? "—"}</strong>
        <span className="sa-sub sa-exp-strip-id" title={experiment?.id ?? session?.id}>
          {experiment?.id ? `exp ${experiment.id.slice(0, 8)}` : session?.id ? `ses ${session.id.slice(0, 8)}` : null}
        </span>
        {day.day != null && day.of != null ? (
          <span className="sa-exp-strip-day">
            روز <Bidi>{toFaDigits(day.day)}</Bidi> از <Bidi>{toFaDigits(day.of)}</Bidi>
          </span>
        ) : null}
        {remainDays != null ? (
          <span className="sa-exp-strip-remain">
            مانده {formatDurationFa(remainingMs)}
          </span>
        ) : elapsedMs != null ? (
          <span className="sa-exp-strip-remain">سپری‌شده {formatDurationFa(elapsedMs)}</span>
        ) : null}
      </div>
      <dl className="sa-exp-strip-grid">
        <div>
          <dt>شروع (تهران)</dt>
          <dd>{formatTehranExact(startedAt) ?? DASH}</dd>
        </div>
        <div>
          <dt>پایان (تهران)</dt>
          <dd>{formatTehranExact(endsAt) ?? DASH}</dd>
        </div>
        <div>
          <dt>سرمایهٔ اولیه</dt>
          <dd>
            <Money value={initialCapital} />
          </dd>
        </div>
        <div>
          <dt>ارزش فعلی</dt>
          <dd>
            <Money value={equity} />
          </dd>
        </div>
        <div>
          <dt>معاملات تکمیل‌شده</dt>
          <dd>
            <Count value={filled} />
          </dd>
        </div>
        <div>
          <dt>اجرا / رد</dt>
          <dd>
            {filled == null && skipped == null ? (
              DASH
            ) : (
              <Bidi>
                {toFaDigits(filled ?? "—")} / {toFaDigits(skipped ?? "—")}
              </Bidi>
            )}
          </dd>
        </div>
        <div>
          <dt>سود تحقق‌یافته</dt>
          <dd>
            <Money value={realized} />
          </dd>
        </div>
        <div>
          <dt>اقتصادی / تعدیل‌ریسک</dt>
          <dd className="sa-exp-strip-dual">
            <Money value={economic} />
            <span className="sa-sub"> / </span>
            <Money value={ra} />
          </dd>
        </div>
        <div>
          <dt>کارمزد نشست</dt>
          <dd>
            <Money value={fees} />
          </dd>
        </div>
        <div>
          <dt>آخرین معامله</dt>
          <dd>{formatTehranExact(lastTrade) ?? DASH}</dd>
        </div>
        <div>
          <dt>آخرین فعالیت موتور</dt>
          <dd>{formatTehranExact(lastEngine) ?? DASH}</dd>
        </div>
      </dl>
    </section>
  );
}
