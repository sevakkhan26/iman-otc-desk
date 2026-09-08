import type { NormalizedSourceSnapshot } from "@/lib/shadowArbitrage/types";
import { DEFAULT_PAPER_LATENCY_MODEL, resolveExecutionDelayMs } from "@/lib/shadowArbitrage/paper/delayedBookRecheck";

/** Public-market observations only. The pure engine never fetches or places orders. */
export async function observeExecution(input: {
  detection: NormalizedSourceSnapshot[];
  decisionTimestampMs: number;
  observe?: (notBeforeMs: number) => Promise<NormalizedSourceSnapshot[]>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}) {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const delay = Math.max(0,...input.detection.map(s => resolveExecutionDelayMs({buy:s,sell:s,model:DEFAULT_PAPER_LATENCY_MODEL})));
  const notBefore = input.decisionTimestampMs+delay;
  const empty = { delayedSources: [] as NormalizedSourceSnapshot[], postFirstLegSources: [] as NormalizedSourceSnapshot[],
    arrivalTimestampMs: Math.max(now(),notBefore), postFirstLegTimestampMs: Math.max(now(),notBefore) };
  if (!input.observe) return empty;
  await sleep(Math.max(0,notBefore-now()));
  let delayedSources: NormalizedSourceSnapshot[];
  try { delayedSources=await input.observe(notBefore); } catch { return empty; }
  const arrivalTimestampMs=now();
  const postNotBefore=arrivalTimestampMs+DEFAULT_PAPER_LATENCY_MODEL.baseArrivalDelayMs;
  await sleep(Math.max(0,postNotBefore-now()));
  let postFirstLegSources: NormalizedSourceSnapshot[];
  try { postFirstLegSources=await input.observe(postNotBefore); }
  catch {
    // Missing second observation is represented explicitly, never as a reused book.
    postFirstLegSources=delayedSources.map(s=>({...s,stale:true,health:"unavailable" as const,bookBids:null,bookAsks:null}));
  }
  const observedIds = new Set(postFirstLegSources.map(s => s.sourceId));
  postFirstLegSources = [...postFirstLegSources, ...delayedSources.filter(s => !observedIds.has(s.sourceId))
    .map(s => ({...s, stale: true, health: "unavailable" as const, bookBids: null, bookAsks: null}))];
  return { delayedSources,postFirstLegSources,arrivalTimestampMs,postFirstLegTimestampMs:now() };
}
