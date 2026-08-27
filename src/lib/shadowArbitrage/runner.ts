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
import {
  clampPollInterval,
  SHADOW_EVENT_DECISION_MIN_MS
} from "@/lib/shadowArbitrage/config";
import { startPublicPaperWebSockets } from "@/lib/shadowArbitrage/streaming/publicWsDriver";
import {
  subscribePaperMarketDecisions,
  subscribePaperRestRecoveryRequests
} from "@/lib/shadowArbitrage/streaming/runtime";

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
  /**
   * Keep retrying while another holder owns the lease (default). Set false only
   * for one-shot callers that genuinely want to give up.
   */
  waitForLease?: boolean;
  /** Backoff bounds while waiting for a lease to expire. */
  leaseRetryMinMs?: number;
  leaseRetryMaxMs?: number;
};

/**
 * Acquire the collector lease, waiting through another holder's lease instead of
 * exiting.
 *
 * A container restart lands inside the previous container's still-valid lease.
 * Exiting there leaves nothing running once that lease expires, which is exactly
 * how production went silent after a recreate: the old lease expired at
 * 13:22:01 and no process was left to claim it.
 */
export async function acquireLeaseWithRetry(input: {
  workerId: string;
  pollIntervalMs: number;
  shouldStop: () => boolean;
  log?: (message: string, extra?: unknown) => void;
  minDelayMs?: number;
  maxDelayMs?: number;
  maxWaitMs?: number;
}): Promise<{ acquired: boolean; heldBy: string | null; waitedMs: number }> {
  const log = input.log ?? (() => undefined);
  const min = input.minDelayMs ?? 2_000;
  const max = input.maxDelayMs ?? 30_000;
  const started = Date.now();
  let delay = min;
  let announced = false;

  for (;;) {
    if (input.shouldStop()) return { acquired: false, heldBy: null, waitedMs: Date.now() - started };

    try {
      const lease = await claimWorkerLease({
        workerId: input.workerId,
        pollIntervalMs: input.pollIntervalMs
      });
      if (lease.acquired) {
        if (announced) log(`lease acquired after waiting ${Math.round((Date.now() - started) / 1000)}s`);
        return { acquired: true, heldBy: lease.heldBy, waitedMs: Date.now() - started };
      }
      if (!announced) {
        announced = true;
        log(`lease held by ${lease.heldBy} until ${lease.expiresAt} — waiting for it to expire`);
      }
    } catch (e) {
      // Database not ready yet: keep retrying rather than dying.
      if (!announced) {
        announced = true;
        log("lease check failed — retrying", e instanceof Error ? e.message : e);
      }
    }

    if (input.maxWaitMs && Date.now() - started > input.maxWaitMs) {
      return { acquired: false, heldBy: null, waitedMs: Date.now() - started };
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(max, Math.round(delay * 1.5));
  }
}

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

  let stopping = false;

  if (options.waitForLease === false) {
    const once = await claimWorkerLease({ workerId, pollIntervalMs: pollMs });
    if (!once.acquired) {
      log(`another collector holds the lease (${once.heldBy}, expires ${once.expiresAt}) — not starting`);
      return {
        stop: async () => undefined,
        done: Promise.resolve(),
        workerId,
        leaseAcquired: false,
        heldBy: once.heldBy
      };
    }
  } else {
    const lease = await acquireLeaseWithRetry({
      workerId,
      pollIntervalMs: pollMs,
      shouldStop: () => stopping,
      log,
      minDelayMs: options.leaseRetryMinMs,
      maxDelayMs: options.leaseRetryMaxMs
    });
    if (!lease.acquired) {
      return {
        stop: async () => undefined,
        done: Promise.resolve(),
        workerId,
        leaseAcquired: false,
        heldBy: lease.heldBy
      };
    }
  }
  let wake: (() => void) | null = null;
  let regularBootstrapComplete = false;
  let eventPending = false;
  let recoveryPending = false;
  let lastEventDecisionAt = 0;
  let nextRegularCycleAt = 0;

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

  const unsubscribeEvents = subscribePaperMarketDecisions(() => {
    if (!regularBootstrapComplete || stopping) return;
    eventPending = true;
    if (Date.now() - lastEventDecisionAt >= SHADOW_EVENT_DECISION_MIN_MS) {
      wake?.();
    }
  });
  const unsubscribeRecovery = subscribePaperRestRecoveryRequests(
    (sourceId, reason) => {
      if (!regularBootstrapComplete || stopping) return;
      recoveryPending = true;
      log(`public WS ${sourceId} requested REST recovery`, reason);
      wake?.();
    }
  );
  const streamDriver = startPublicPaperWebSockets({
    onError: (sourceId, error) =>
      log(`public WS ${sourceId} degraded — REST recovery remains active`, error)
  });
  if (streamDriver.started) {
    log("public order-book WebSockets started for Paper market data");
  } else {
    log("WebSocket runtime unavailable — explicit REST fallback active");
  }

  async function cycle(
    index: number,
    eventDriven: boolean,
    recoveryDriven = false
  ): Promise<void> {
    const result = await runCollectionCycle({
      workerId,
      pollIntervalMs: pollMs,
      runRetention: !eventDriven && index % retentionEvery === 1,
      ownsHeartbeat: true,
      // REST recovery must bypass the regular interval idempotency bucket;
      // otherwise a coherence failure just after a regular cycle is a duplicate
      // and never performs the requested bootstrap.
      force: eventDriven || recoveryDriven,
      eventDriven
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
      const recoveryDriven =
        regularBootstrapComplete &&
        Date.now() < nextRegularCycleAt &&
        recoveryPending;
      const eventDriven =
        regularBootstrapComplete &&
        Date.now() < nextRegularCycleAt &&
        !recoveryDriven &&
        eventPending &&
        Date.now() - lastEventDecisionAt >= SHADOW_EVENT_DECISION_MIN_MS;
      if (recoveryDriven) {
        recoveryPending = false;
      }
      if (eventDriven) {
        eventPending = false;
        lastEventDecisionAt = Date.now();
      }
      try {
        await cycle(index, eventDriven, recoveryDriven);
      } catch (e) {
        log("cycle exception", e instanceof Error ? (e.stack ?? e.message) : e);
      }
      if (!eventDriven) {
        regularBootstrapComplete = true;
        nextRegularCycleAt = Date.now() + pollMs;
      }
      if (maxCycles && index >= maxCycles) {
        log(`reached max cycles (${maxCycles})`);
        break;
      }
      if (stopping) break;
      const untilRegular = Math.max(1, nextRegularCycleAt - Date.now());
      const untilEvent = eventPending
        ? Math.max(
            1,
            SHADOW_EVENT_DECISION_MIN_MS -
              (Date.now() - lastEventDecisionAt)
          )
        : Number.POSITIVE_INFINITY;
      const untilRecovery = recoveryPending ? 1 : Number.POSITIVE_INFINITY;
      await sleep(Math.min(untilRegular, untilEvent, untilRecovery));
    }

    unsubscribeEvents();
    unsubscribeRecovery();
    streamDriver.stop();
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
