/**
 * Median price history — PostgreSQL median_history_samples.
 */
import { desc } from "drizzle-orm";
import { getDatabaseUrl, getDb } from "@/db/client";
import { medianHistorySamples } from "@/db/schema";
import type { MedianHistoryRange, MedianHistoryResponse } from "@/lib/types";

type Sample = { t: number; v: number };

const MAX_AGE_MS = 8 * 24 * 60 * 60_000;
const MIN_INTERVAL_MS = 60_000;

async function readSamples(): Promise<Sample[]> {
  try {
    getDatabaseUrl();
    const db = getDb();
    const rows = await db
      .select()
      .from(medianHistorySamples)
      .orderBy(desc(medianHistorySamples.sampledAtMs));
    const now = Date.now();
    return rows
      .map((r) => ({ t: Number(r.sampledAtMs), v: Number(r.medianValue) }))
      .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.v) && now - s.t <= MAX_AGE_MS)
      .sort((a, b) => a.t - b.t);
  } catch {
    return [];
  }
}

export async function getMedianPriceSamples(): Promise<Array<{ t: number; v: number }>> {
  const samples = await readSamples();
  return samples.map((s) => ({ t: s.t, v: s.v })).sort((a, b) => a.t - b.t);
}

export async function recordMedian(median: number | null): Promise<void> {
  if (median === null || !Number.isFinite(median)) return;
  try {
    getDatabaseUrl();
    const db = getDb();
    const samples = await readSamples();
    const now = Date.now();
    const last = samples[samples.length - 1];
    if (last && now - last.t < MIN_INTERVAL_MS) return;

    const { randomUUID } = await import("node:crypto");
    await db
      .insert(medianHistorySamples)
      .values({
        id: randomUUID(),
        sampledAtMs: now,
        medianValue: String(median)
      })
      .onConflictDoNothing();

    // prune old samples best-effort
    const cutoff = now - MAX_AGE_MS;
    const { lt } = await import("drizzle-orm");
    await db.delete(medianHistorySamples).where(lt(medianHistorySamples.sampledAtMs, cutoff));
  } catch {
    // best-effort
  }
}

function downsample(samples: Sample[], max: number): Sample[] {
  if (samples.length <= max) return samples;
  const step = samples.length / max;
  const out: Sample[] = [];
  for (let i = 0; i < max; i++) {
    out.push(samples[Math.floor(i * step)]);
  }
  const last = samples[samples.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export async function getMedianHistory(range: MedianHistoryRange): Promise<MedianHistoryResponse> {
  const samples = await readSamples();
  const now = Date.now();
  const windowMs = range === "7d" ? 7 * 24 * 60 * 60_000 : 24 * 60 * 60_000;
  const maxPoints = range === "7d" ? 84 : 96;
  const inWindow = samples.filter((s) => now - s.t <= windowMs).sort((a, b) => a.t - b.t);
  const points = downsample(inWindow, maxPoints).map((s) => ({
    t: new Date(s.t).toISOString(),
    v: s.v
  }));
  const values = points.map((p) => p.v);
  const first = values[0] ?? null;
  const last = values[values.length - 1] ?? null;
  return {
    range,
    points,
    first,
    last,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    changePercent:
      first !== null && last !== null && first !== 0 ? ((last - first) / first) * 100 : null
  };
}
