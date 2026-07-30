"use client";

import { formatTehran } from "@/components/format";
import {
  COLLECTOR_STATE_FA,
  collectorTone,
  deriveCollectorState,
  formatAgoFa,
  formatCountFa,
  formatDurationFa,
  formatPercentFa,
  toFaDigits
} from "@/components/shadowArbitrage/labels";
import type { Observation, RunStats, WorkerState } from "@/components/shadowArbitrage/types";

type Props = {
  observation: Observation | null;
  worker: WorkerState | null;
  runStats: RunStats | null;
  dataCoveragePercent: number | null;
  serverNow: string | null;
  loading: boolean;
  onPause: () => void;
  onResume: () => void;
};

function Field({
  label,
  value,
  hint
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="sa-field">
      <div className="sa-field-label">{label}</div>
      <div className="sa-field-value">{value}</div>
      {hint ? <div className="sa-field-hint">{hint}</div> : null}
    </div>
  );
}

/** Section A — what the system is doing right now, in plain Persian. */
export function ObservationHeader({
  observation,
  worker,
  runStats,
  dataCoveragePercent,
  serverNow,
  loading,
  onPause,
  onResume
}: Props) {
  const nowMs = serverNow ? Date.parse(serverNow) : Date.now();
  const lastSuccessAgeMs = observation?.lastSuccessAt
    ? Math.max(0, nowMs - Date.parse(observation.lastSuccessAt))
    : null;

  const state = deriveCollectorState({
    observationStatus: observation?.status,
    workerStale: worker?.stale,
    workerRunning: Boolean(worker && worker.leaseHeld && !worker.stale),
    lastSuccessAgeMs,
    pollIntervalMs: worker?.pollIntervalMs ?? observation?.pollIntervalMs
  });

  const progress = Math.min(100, Math.max(0, observation?.progressPercent ?? 0));
  const targetDays = Math.round((observation?.targetDurationMs ?? 0) / 86_400_000);

  if (loading && !observation) {
    return (
      <section className="panel sa-panel">
        <div className="panel-body sa-skeleton-grid">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="sa-skeleton-block" />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="panel sa-panel sa-observation">
      <div className="panel-header sa-panel-header">
        <div className="sa-status-line">
          <span className={`sa-chip sa-chip-${collectorTone(state)}`}>
            <span className="sa-dot" aria-hidden="true" />
            {COLLECTOR_STATE_FA[state]}
          </span>
          <h3 className="panel-title sa-panel-title">وضعیت پایش</h3>
        </div>
        <div className="sa-actions">
          {state === "offline" ? (
            <span className="sa-panel-note">جمع‌آورنده آفلاین است</span>
          ) : observation?.status === "RUNNING" || observation?.status === "DEGRADED" ? (
            <button type="button" className="sa-btn" onClick={onPause}>
              توقف موقت
            </button>
          ) : observation?.status === "NOT_STARTED" || !observation ? (
            <button type="button" className="sa-btn sa-btn-primary" onClick={onResume}>
              شروع پایش
            </button>
          ) : observation.status === "COMPLETED" ? null : (
            <button type="button" className="sa-btn sa-btn-primary" onClick={onResume}>
              ادامه پایش
            </button>
          )}
        </div>
      </div>

      <div className="panel-body">
        <div className="sa-progress-row">
          <div className="sa-progress-meta">
            <span>
              پیشرفت زمانی دورهٔ {toFaDigits(targetDays || 14)} روزه
            </span>
            <strong>{formatPercentFa(progress, 2)}</strong>
          </div>
          <div
            className="sa-progress"
            role="progressbar"
            aria-valuenow={Math.round(progress)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="sa-progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <div className="sa-progress-foot">
            <span>
              سپری‌شده: <strong>{formatDurationFa(observation?.elapsedMs)}</strong>
            </span>
            <span>
              باقی‌مانده: <strong>{formatDurationFa(observation?.remainingMs)}</strong>
            </span>
          </div>
        </div>

        <div className="sa-field-grid">
          <Field
            label="شروع پایش"
            value={observation?.startedAt ? formatTehran(observation.startedAt) : "—"}
            hint="به وقت تهران"
          />
          <Field
            label="آخرین جمع‌آوری موفق"
            value={observation?.lastSuccessAt ? formatTehran(observation.lastSuccessAt) : "—"}
            hint={formatAgoFa(observation?.lastSuccessAt, nowMs)}
          />
          <Field
            label="جمع‌آوری بعدی"
            value={worker?.nextExpectedCycleAt ? formatTehran(worker.nextExpectedCycleAt) : "—"}
            hint={`هر ${toFaDigits(Math.round((worker?.pollIntervalMs ?? 30_000) / 1000))} ثانیه`}
          />
          <Field
            label="ضربان جمع‌آورنده"
            value={worker?.lastHeartbeatAt ? formatAgoFa(worker.lastHeartbeatAt, nowMs) : "—"}
            hint={worker?.stale ? "ضربان قدیمی است" : "فعال"}
          />
          <Field
            label="چرخه‌های انجام‌شده"
            value={formatCountFa(observation?.completedCycles ?? 0)}
            hint={
              observation
                ? `موفق ${formatCountFa(observation.successfulCycles)} · جزئی ${formatCountFa(
                    observation.partialCycles
                  )} · ناموفق ${formatCountFa(observation.failedCycles)}`
                : undefined
            }
          />
          <Field
            label="پوشش چرخه‌های موفق"
            value={formatPercentFa(observation?.successCoveragePercent ?? null, 1)}
            hint={
              observation
                ? `${formatCountFa(observation.successfulCycles)} موفق از ${formatCountFa(
                    observation.expectedCycles
                  )} مورد انتظار`
                : undefined
            }
          />
          <Field
            label="زمان بدون جمع‌آوری"
            value={formatDurationFa(observation?.downtimeMs)}
            hint="این مدت پوشش را کاهش می‌دهد"
          />
          <Field
            label="پاسخ‌دهی منابع در چرخه اخیر"
            value={formatPercentFa(dataCoveragePercent, 1)}
            hint="سهم منابعی که پاسخ سالم دادند"
          />
          <Field
            label="چرخه‌های تکراری"
            value={formatCountFa(runStats?.duplicateIdempotencyKeys ?? 0)}
            hint="باید صفر بماند"
          />
        </div>
      </div>
    </section>
  );
}
