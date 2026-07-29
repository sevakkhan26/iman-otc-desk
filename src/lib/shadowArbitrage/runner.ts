/**
 * Shared collector loop for Shadow Arbitrage.
 *
 * Used by two hosts:
 *  - `scripts/shadow-worker.mts` — standalone process (the production path,
 *    and the right choice whenever DATABASE_URL points at real PostgreSQL).
 *  - `instrumentation.ts` — in-process inside the local Next server, which is
 *    mandatory on PGlite because a PGlite data directory has exactly one safe
 *    writer: two processes on the same directory silently lose writes.
 *
 * Read-only with respect to exchanges either way: public market data in,
 * database rows out. No credentials, orders, or transfers.
 */
import { runCollectionCycle } from "@/lib/shadowArbitrage/collector";
import { claimWorkerLease, releaseWorkerLease, touchHeartbeat } from "@/db/repositories/shadowArbitrage";
import { clampPollInterval } from "@/lib/shadowArbitrage/config";

export type CollectorHandle = {
  /** Resolves once the loop has stopped and the lease is released. */
  stop: () => Promise<void>;
  /** Resolves when the loop finishes on its own (max cycles reached). */
  done: Promise<void>;
  workerId: string;
};

export type CollectorOptions = {
  workerId: string;
  pollIntervalMs?: number;
  /** Stop after this many cycles (0 = run forever). */
  maxCycles?: number;
  /** Sweep retention every N cycles. */
  retentionEveryCycles?: number;
  log?: (message: string, extra?: unknown) => void;
  /** Exit instead of collecting when another holder owns the lease. */
  requireLease?: boolean;
};

function defaultLog(message: string, extra?: unknown) {
  const line = `[shadow-worker ${new Date().toISOString()}] ${message}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}

/**
 * Start collecting. Returns immediately with a handle; the loop runs in the
 * background until `stop()` or `maxCycles`.
 */
export async function startShadowCollector(
  options: CollectorOptions
): Promise<CollectorHandle & { leaseAcquired: boolean; heldBy: string | null }> {
  const log = options.log ?? defaultLog;
  const pollMs = clampPollInterval(options.pollIntervalMs);
  const workerId = options.workerId;
  const maxCycles = Math.max(0, options.maxCycles ?? 0);
  const retentionEvery = Math.max(1, options.retentionEveryCycles ?? 20);

  const lease = await claimWorkerLease({ workerId, pollIntervalMs: pollMs });
  if (!lease.acquired && options.requireLease !== false) {
    log(`another collector holds the lease (${lease.heldBy}, expires ${lease.expiresAt}) — not starting`);
    return {
      stop: async () => undefined,
      done: Promise.resolve(),
      workerId,
      leaseAcquired: false,
      heldBy: lease.heldBy
    };
  }

  let stopping = false;
  let wake: (() => void) | null = null;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      // Do not hold the event loop open on shutdown.
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  async function cycle(index: number): Promise<void> {
    const result = await runCollectionCycle({
      workerId,
      pollIntervalMs: pollMs,
      runRetention: index % retentionEvery === 1
    });

    if (!result.acquired) {
      log(`skip — ${result.skipped === "rate_limited" ? "rate limited" : "lock held elsewhere"}`);
      return;
    }
    if (result.skipped === "paused") {
      log("skip — observation session is PAUSED");
      return;
    }
    if (result.duplicate) {
      log("skip — this interval bucket was already recorded");
      return;
    }
    if (result.error) {
      log("cycle error", result.error);
      return;
    }
    const m = result.matrix;
    const healthy = m?.sources.filter((s) => s.health === "healthy").length ?? 0;
    const degraded = m?.sources.filter((s) => s.health === "degraded").length ?? 0;
    const down = m?.sources.filter((s) => s.health === "unavailable").length ?? 0;
    log(
      `cycle ${index} ${result.status} — sources ${healthy} healthy / ${degraded} degraded / ${down} down, ` +
        `active opportunities ${m?.opportunities.length ?? 0}, cycles recorded ${result.observation?.completedCycles ?? "?"}`
    );
  }

  const done = (async () => {
    let index = 0;
    while (!stopping) {
      index += 1;
      const t0 = Date.now();
      try {
        await cycle(index);
      } catch (e) {
        log("cycle exception", e instanceof Error ? (e.stack ?? e.message) : e);
      }
      if (maxCycles && index >= maxCycles) {
        log(`reached max cycles (${maxCycles})`);
        break;
      }
      if (stopping) break;
      await sleep(Math.max(1_000, pollMs - (Date.now() - t0)));
    }

    await touchHeartbeat({ workerId, status: "stopped", pollIntervalMs: pollMs }).catch(
      () => undefined
    );
    await releaseWorkerLease(workerId);
    log("collector stopped");
  })();

  return {
    workerId,
    leaseAcquired: true,
    heldBy: workerId,
    done,
    stop: async () => {
      if (stopping) return done;
      stopping = true;
      wake?.();
      return done;
    }
  };
}
