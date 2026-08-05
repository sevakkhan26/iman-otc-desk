/**
 * Put the approved Paper policy set into a deployment, once.
 *
 * Git carries files, not rows. `PAPER_BALANCED_10B_V1` is an approved decision
 * that has to exist in the database before the Paper Broker can size anything,
 * and asking an operator to type six numbers into six fields after every
 * deployment is exactly the workflow this phase removes.
 *
 * The guarantees, and how each one is obtained:
 *
 *   ONCE — the marker row's PRIMARY KEY. Two containers starting at the same
 *   moment both try to insert it; one wins and the other's whole transaction
 *   rolls back, policies included. There is no window in which a partial set is
 *   visible and no path that writes a duplicate.
 *
 *   ALL SIX OR NONE — the policy rows and the marker are written inside ONE
 *   transaction, with the marker last. A failure anywhere leaves the database
 *   exactly as it was.
 *
 *   NEVER OVERWRITES AN ADMINISTRATOR — a key that already carries a
 *   configured, unexpired admin value is preserved, not replaced. The bootstrap
 *   fills gaps; it does not overrule decisions.
 *
 *   EXPIRY IS FIXED AT FIRST APPLICATION — validity is thirty days from the
 *   `setAt` written here. Because a later start never writes again, a restart or
 *   a redeploy cannot extend it. The set lapses on schedule and has to be
 *   re-approved, which is the point of having an expiry at all.
 *
 * It configures nothing outside the six Paper keys: every Live Readiness policy,
 * evidence threshold and kill switch is left exactly as it was.
 *
 * No credential, no exchange call, no order, no transfer. It writes numbers.
 */
import { sql } from "drizzle-orm";
import { getDbAsync } from "@/db/client";
import { applyRiskPolicySet, loadRiskPolicyValues } from "@/db/repositories/shadowLive";
import { buildPolicyState } from "@/lib/shadowArbitrage/live/policy";
import {
  PAPER_POLICY_SET,
  PAPER_POLICY_SET_KEY,
  PAPER_POLICY_SET_VALID_DAYS
} from "@/lib/shadowArbitrage/live/paperPolicySet";
import { paperPolicySetFingerprint } from "@/lib/shadowArbitrage/live/paperPolicySetHash";

/** Who the audit trail records for a value nobody typed. */
export const BOOTSTRAP_ACTOR = "release-bootstrap";

export type PaperPolicyBootstrapResult = {
  ran: boolean;
  reason: "applied" | "already-applied" | "disabled" | "error";
  setKey: string;
  fingerprint: string;
  /** Keys this run wrote. Empty on every run after the first. */
  applied: string[];
  /** Keys skipped because an administrator had already decided them. */
  preserved: string[];
  error?: string;
};

const ZERO = {
  ran: false,
  setKey: PAPER_POLICY_SET_KEY,
  fingerprint: "",
  applied: [] as string[],
  preserved: [] as string[]
};

/**
 * Whether to run here.
 *
 * Shares the release bootstrap's switch on purpose: a deployment that wants the
 * approved evidence wants the approved policy set with it, and a harness that
 * turns one off means to turn both off.
 */
export function paperPolicyBootstrapEnabled(): boolean {
  const raw = (process.env.SHADOW_RELEASE_BOOTSTRAP ?? "").trim().toLowerCase();
  if (["false", "0", "no", "off"].includes(raw)) return false;
  if (["true", "1", "yes", "on"].includes(raw)) return true;
  return process.env.NODE_ENV === "production";
}

async function markerExists(): Promise<boolean> {
  const db = await getDbAsync();
  const r = await db.execute(
    sql`SELECT 1 FROM shadow_release_bootstrap WHERE release_key = ${PAPER_POLICY_SET_KEY} LIMIT 1`
  );
  const rows = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? []);
  return rows.length > 0;
}

/**
 * Apply the approved Paper policy set. Safe to call on every start.
 *
 * Returns what it actually wrote, so a caller — or a test — can assert that the
 * second and third runs wrote nothing at all.
 */
export async function runPaperPolicyBootstrap(
  log: (message: string, extra?: unknown) => void = () => undefined
): Promise<PaperPolicyBootstrapResult> {
  const fingerprint = paperPolicySetFingerprint();
  if (!paperPolicyBootstrapEnabled()) {
    return { ...ZERO, fingerprint, reason: "disabled" };
  }

  try {
    if (await markerExists()) {
      return { ...ZERO, fingerprint, reason: "already-applied" };
    }

    /*
     * An administrator who has already set one of these keys outranks this
     * file. Their value is left in place and counted as satisfied, so the set
     * still becomes effective without the bootstrap overruling a decision
     * somebody made deliberately.
     */
    const state = buildPolicyState(await loadRiskPolicyValues(), Date.now());
    const preserveKeys = PAPER_POLICY_SET.filter((entry) => {
      const current = state.find((p) => p.definition.key === entry.key);
      return Boolean(current?.configured) && current?.setBy !== BOOTSTRAP_ACTOR;
    }).map((entry) => entry.key as string);

    const detail = {
      setKey: PAPER_POLICY_SET_KEY,
      fingerprint,
      validForDays: PAPER_POLICY_SET_VALID_DAYS,
      entries: PAPER_POLICY_SET.map((e) => ({ key: e.key, value: e.value })),
      preserved: preserveKeys
    };

    const result = await applyRiskPolicySet({
      setKey: PAPER_POLICY_SET_KEY,
      fingerprint,
      entries: PAPER_POLICY_SET.map((e) => ({ policyKey: e.key, value: e.value })),
      setBy: BOOTSTRAP_ACTOR,
      validForDays: PAPER_POLICY_SET_VALID_DAYS,
      note: `مجموعهٔ تأییدشدهٔ ${PAPER_POLICY_SET_KEY} — اعمال خودکار در راه‌اندازی (${fingerprint})`,
      preserveKeys,
      /*
       * The marker goes in LAST and inside the same transaction. If another
       * container has already written it, this insert violates the primary key,
       * the transaction aborts, and none of the policy rows above survive —
       * which is exactly the behaviour a concurrent start needs.
       */
      afterAll: async (tx) => {
        await tx.execute(
          sql`INSERT INTO shadow_release_bootstrap (release_key, detail)
              VALUES (${PAPER_POLICY_SET_KEY}, ${JSON.stringify(detail)}::jsonb)`
        );
      }
    });

    log(
      `paper policy set applied: ${result.applied.length} written, ${result.preserved.length} preserved`,
      detail
    );
    return {
      ran: true,
      reason: "applied",
      setKey: PAPER_POLICY_SET_KEY,
      fingerprint,
      applied: result.applied,
      preserved: result.preserved
    };
  } catch (e) {
    /*
     * Drizzle (and PGlite) wrap the Postgres error under `.cause`, so the outer
     * message is often just "Failed query: INSERT …". Walk the chain and also
     * look at `code === '23505'` so a lost race is never misreported as a fault.
     */
    const parts: string[] = [];
    let cur: unknown = e;
    for (let i = 0; i < 6 && cur; i += 1) {
      if (cur instanceof Error) {
        parts.push(cur.message);
        if ("code" in cur && cur.code != null) parts.push(String(cur.code));
        cur = cur.cause;
      } else {
        parts.push(String(cur));
        break;
      }
    }
    const error = parts.join(" | ");
    /*
     * A lost race is the normal outcome for the second container, not a fault:
     * the winner has already applied exactly this set. Reported as
     * already-applied so a healthy concurrent start does not look like an error.
     */
    if (
      /duplicate key|unique constraint|shadow_release_bootstrap_pkey|\b23505\b/i.test(
        error
      )
    ) {
      return { ...ZERO, fingerprint, reason: "already-applied" };
    }
    log("paper policy bootstrap failed — startup continues", error);
    return { ...ZERO, fingerprint, reason: "error", error };
  }
}
