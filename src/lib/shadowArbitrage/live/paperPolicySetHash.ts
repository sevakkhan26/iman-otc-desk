/**
 * The fingerprint of a Paper policy set.
 *
 * Kept apart from `paperPolicySet.ts` because it needs `node:crypto`, and that
 * module has to stay importable from a client component. The UI never computes
 * a fingerprint — it displays the one the server sends, which is the same one
 * the bootstrap and the audit trail recorded.
 *
 * It is a change detector and an idempotency input, not a secret: the same six
 * approved values and the same validity always produce the same digest, and any
 * edit to either produces a different one.
 */
import { createHash } from "node:crypto";
import {
  PAPER_POLICY_SET,
  PAPER_POLICY_SET_VALID_DAYS,
  paperPolicySetCanonical
} from "@/lib/shadowArbitrage/live/paperPolicySet";

/** Short, stable, and long enough that two different sets cannot collide. */
export function paperPolicySetFingerprint(
  entries: Array<{ key: string; value: number }> = PAPER_POLICY_SET,
  validForDays: number = PAPER_POLICY_SET_VALID_DAYS
): string {
  return createHash("sha256")
    .update(paperPolicySetCanonical(entries, validForDays))
    .digest("hex")
    .slice(0, 32);
}
