export const TEHRAN_TZ = "Asia/Tehran";
const TEHRAN_OFFSET = "+03:30";

const HAS_TIMEZONE = /(?:[zZ]|[+-]\d{2}:\d{2})$/;

/** Parse timezone-naive Iranian source datetimes as Asia/Tehran (+03:30). */
export function parseTehranNaiveDateTime(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (HAS_TIMEZONE.test(trimmed)) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const parsed = new Date(`${normalized}${TEHRAN_OFFSET}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Navasan `date` is unix epoch in milliseconds (sometimes seconds). */
export function parseNavasanEpoch(value: number): Date | null {
  if (!Number.isFinite(value)) return null;
  const ms = value > 1e12 ? value : value * 1000;
  const parsed = new Date(ms);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function toUtcIso(date: Date): string {
  return date.toISOString();
}

/** Prevent displayed gold times from exceeding the current instant. */
export function clampToNow(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const now = Date.now();
  if (parsed.getTime() > now) return new Date(now).toISOString();
  return iso;
}

export function parseGoldSourceTimestamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return clampToNow(parsed.toISOString());
}