import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MedianHistoryRange, MedianHistoryResponse } from "@/lib/types";

const dataDir = path.join(process.cwd(), ".data");
const historyPath = path.join(dataDir, "median-history.json");

type Sample = { t: number; v: number };

const MAX_AGE_MS = 8 * 24 * 60 * 60_000; // retain 8 days of samples
const MIN_INTERVAL_MS = 60_000; // throttle: at most one sample per minute

async function readSamples(): Promise<Sample[]> {
  try {
    const raw = await readFile(historyPath, "utf8");
    const parsed = JSON.parse(raw) as { samples?: unknown };
    if (!Array.isArray(parsed.samples)) return [];
    return parsed.samples.filter(
      (s): s is Sample =>
        Boolean(s) && typeof (s as Sample).t === "number" && typeof (s as Sample).v === "number" && Number.isFinite((s as Sample).v)
    );
  } catch {
    return [];
  }
}

/** Raw median samples for reaction measurement (read-only). */
export async function getMedianPriceSamples(): Promise<Array<{ t: number; v: number }>> {
  const samples = await readSamples();
  return samples.map((s) => ({ t: s.t, v: s.v })).sort((a, b) => a.t - b.t);
}

// Append a Median snapshot. Best-effort: never throws into the request path.
export async function recordMedian(median: number | null): Promise<void> {
  if (median === null || !Number.isFinite(median)) return;
  try {
    const samples = await readSamples();
    const now = Date.now();
    const last = samples[samples.length - 1];
    if (last && now - last.t < MIN_INTERVAL_MS) return; // too soon since last sample
    samples.push({ t: now, v: median });
    const pruned = samples.filter((s) => now - s.t <= MAX_AGE_MS);
    await mkdir(dataDir, { recursive: true });
    await writeFile(historyPath, JSON.stringify({ samples: pruned }), "utf8");
  } catch {
    // disk persistence is best-effort
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
  const points = downsample(inWindow, maxPoints).map((s) => ({ t: new Date(s.t).toISOString(), v: s.v }));
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
    changePercent: first !== null && last !== null && first !== 0 ? ((last - first) / first) * 100 : null
  };
}
