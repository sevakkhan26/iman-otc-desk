/**
 * Presentation-only Paper experiment/session lifecycle helpers.
 * Does not re-derive accounting, size trades, or invent missing fields.
 */
export type OperatorLifecycleStatus =
  | "running"
  | "paused"
  | "completed"
  | "stopped"
  | "unknown";

export const LIFECYCLE_STATUS_FA: Record<OperatorLifecycleStatus, string> = {
  running: "در حال اجرا",
  paused: "متوقف موقت",
  completed: "تکمیل‌شده",
  stopped: "متوقف",
  unknown: "ناموجود"
};

export type ExperimentHistoryRow = {
  id: string;
  name: string | null;
  status: string;
  operatorStatus: OperatorLifecycleStatus;
  startedAt: string | null;
  endedAt: string | null;
  configuredEndsAt: string | null;
  configuredDurationDays: number | null;
  capitalToman: number | null;
  tradesExecuted: number | null;
  skipped: number | null;
  realizedEconomicPnlToman: number | null;
  riskAdjustedPnlToman: number | null;
  cashPnlIrtToman: number | null;
  feesToman: number | null;
  experimentId: string | null;
  experimentStatus: string | null;
};

const DAY_MS = 86_400_000;

export function operatorLifecycleStatus(input: {
  sessionStatus?: string | null;
  experimentStatus?: string | null;
}): OperatorLifecycleStatus {
  const s = (input.sessionStatus ?? "").toUpperCase();
  if (s === "RUNNING") return "running";
  if (s === "PAUSED") return "paused";
  if (s === "STOPPED") {
    const e = (input.experimentStatus ?? "").toUpperCase();
    if (e === "COMPLETED") return "completed";
    return "stopped";
  }
  const e = (input.experimentStatus ?? "").toUpperCase();
  if (e === "ACTIVE") return "running";
  if (e === "COMPLETED") return "completed";
  if (e === "SUPERSEDED") return "stopped";
  if (e === "PENDING") return "paused";
  if (s === "NOT_STARTED" || s === "CREATED") return "stopped";
  return "unknown";
}

export function durationDaysFromRange(
  startedAt: string | null | undefined,
  endsAt: string | null | undefined
): number | null {
  if (!startedAt || !endsAt) return null;
  const a = Date.parse(startedAt);
  const b = Date.parse(endsAt);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  const days = Math.round((b - a) / DAY_MS);
  return days > 0 ? days : null;
}

/** Day X of N. Nulls stay null — never invent a 14-day window. */
export function dayIndexOf(
  elapsedMs: number | null | undefined,
  durationDays: number | null | undefined
): { day: number | null; of: number | null } {
  const of =
    durationDays != null && Number.isFinite(durationDays) && durationDays > 0
      ? Math.round(durationDays)
      : null;
  if (of == null) return { day: null, of: null };
  if (elapsedMs == null || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return { day: null, of };
  }
  const day = Math.min(of, Math.max(1, Math.floor(elapsedMs / DAY_MS) + 1));
  return { day, of };
}

export function remainingDaysFromMs(remainingMs: number | null | undefined): number | null {
  if (remainingMs == null || !Number.isFinite(remainingMs) || remainingMs < 0) return null;
  return Math.max(0, remainingMs / DAY_MS);
}

/** Exact Tehran wall-clock with seconds. Null if the ISO is missing/invalid. */
export function formatTehranExact(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(d);
}

export function finiteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}
