/**
 * Gold price history — durable store: PostgreSQL app_settings key `gold_history`.
 */
import { pgGetKv, pgSetKv } from "@/db/repositories/kv";
import type {
  GoldHistoryRange,
  GoldHistoryResponse,
  GoldHistorySeries,
  GoldInstrumentType,
  GoldMarketQuote,
  GoldPricesApiSource,
  GoldPriceUnit
} from "@/lib/types";

const KV_KEY = "gold_history";

type Sample = {
  t: number;
  source: GoldPricesApiSource;
  instrument: GoldInstrumentType;
  unit: GoldPriceUnit;
  v: number;
};

const SOURCE_NAMES: Record<GoldPricesApiSource, string> = {
  navasan: "نوسان",
  bonbast: "بن‌بست",
  talavest: "Talavest"
};

const MAX_AGE_MS = 8 * 24 * 60 * 60_000;
const MIN_INTERVAL_MS = 60_000;

function quoteValue(quote: GoldMarketQuote): number | null {
  if (quote.midPrice !== null && Number.isFinite(quote.midPrice)) return quote.midPrice;
  if (quote.buyPrice !== null && quote.sellPrice !== null) return (quote.buyPrice + quote.sellPrice) / 2;
  return quote.buyPrice ?? quote.sellPrice ?? null;
}

async function readSamples(): Promise<Sample[]> {
  try {
    const stored = await pgGetKv<{ samples?: unknown }>(KV_KEY);
    if (!stored || !Array.isArray(stored.samples)) return [];
    return stored.samples.filter(
      (sample): sample is Sample =>
        Boolean(sample) &&
        typeof (sample as Sample).t === "number" &&
        typeof (sample as Sample).source === "string" &&
        typeof (sample as Sample).instrument === "string" &&
        typeof (sample as Sample).unit === "string" &&
        typeof (sample as Sample).v === "number" &&
        Number.isFinite((sample as Sample).v)
    );
  } catch {
    return [];
  }
}

export async function recordGoldHistory(quotes: GoldMarketQuote[]): Promise<void> {
  const entries = quotes
    .map((quote) => {
      const value = quoteValue(quote);
      if (value === null) return null;
      return {
        t: Date.now(),
        source: quote.sourceId,
        instrument: quote.instrument,
        unit: quote.unit,
        v: value
      } satisfies Sample;
    })
    .filter((entry): entry is Sample => entry !== null);

  if (!entries.length) return;

  try {
    const samples = await readSamples();
    const now = Date.now();
    for (const entry of entries) {
      const last = [...samples]
        .reverse()
        .find((sample) => sample.source === entry.source && sample.instrument === entry.instrument);
      if (last && now - last.t < MIN_INTERVAL_MS) continue;
      // Same price: only heartbeat every 30m so outage restarts do not paint flat walls.
      if (
        last &&
        Math.abs(last.v - entry.v) <= Math.max(Math.abs(last.v) * 1e-9, 1e-6) &&
        now - last.t < 30 * 60_000
      ) {
        continue;
      }
      samples.push(entry);
    }
    const pruned = samples.filter((sample) => now - sample.t <= MAX_AGE_MS);
    await pgSetKv(KV_KEY, { samples: pruned }, "gold-history");
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

/** Raw gold price samples for a single instrument (reaction measurement, read-only). */
export async function getGoldPriceSamples(
  instrument: GoldInstrumentType
): Promise<Array<{ t: number; v: number; unit: GoldPriceUnit }>> {
  const samples = await readSamples();
  return samples
    .filter((sample) => sample.instrument === instrument)
    .map((sample) => ({ t: sample.t, v: sample.v, unit: sample.unit }))
    .sort((a, b) => a.t - b.t);
}

export async function getGoldHistory(range: GoldHistoryRange, instrument: GoldInstrumentType): Promise<GoldHistoryResponse> {
  const samples = await readSamples();
  const now = Date.now();
  const windowMs = range === "7d" ? 7 * 24 * 60 * 60_000 : 24 * 60 * 60_000;
  const maxPoints = range === "7d" ? 84 : 96;
  const inWindow = samples
    .filter((sample) => sample.instrument === instrument && now - sample.t <= windowMs)
    .sort((a, b) => a.t - b.t);

  const series: GoldHistorySeries[] = (["navasan", "bonbast", "talavest"] as const)
    .map((source) => {
      const sourceSamples = downsample(
        inWindow.filter((sample) => sample.source === source),
        maxPoints
      );
      if (!sourceSamples.length) return null;
      return {
        source,
        sourceName: SOURCE_NAMES[source],
        unit: sourceSamples[0].unit,
        points: sourceSamples.map((sample) => ({ t: new Date(sample.t).toISOString(), v: sample.v }))
      };
    })
    .filter((entry): entry is GoldHistorySeries => entry !== null);

  return { range, instrument, series };
}
