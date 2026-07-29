import { closeDb } from "../src/db/client.ts";
import {
  ensureObservationSession,
  beginCollectionRun,
  withShadowLock,
  touchHeartbeat
} from "../src/db/repositories/shadowArbitrage.ts";
import { collectAllShadowSources } from "../src/lib/shadowArbitrage/adapters/index.ts";
import { buildOpportunities } from "../src/lib/shadowArbitrage/calculate.ts";
import { loadActiveOpportunities } from "../src/lib/shadowArbitrage/store.ts";

console.log("1");
const sources = await collectAllShadowSources();
console.log("2 sources", sources.filter(s=>s.health==="healthy").length);
console.log("3 lock");
const r = await withShadowLock(async () => {
  console.log("4 in lock");
  const session = await ensureObservationSession(30000);
  console.log("5 session", session.id);
  await touchHeartbeat({ workerId: "dbg", status: "collecting", pollIntervalMs: 30000, sessionId: session.id });
  console.log("6 heartbeat");
  const { runId, duplicate } = await beginCollectionRun({
    sessionId: session.id,
    idempotencyKey: "dbg-" + Date.now(),
    workerId: "dbg"
  });
  console.log("7 run", runId, duplicate);
  const prev = await loadActiveOpportunities();
  console.log("8 prev", prev.length);
  const opps = buildOpportunities(sources, prev, new Date().toISOString());
  console.log("9 opps", opps.filter(o=>o.isActive).length);
  return { runId, opps: opps.length };
});
console.log("10 done", r);
await closeDb();
