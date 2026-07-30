/**
 * Phase 7A — the live-execution capability flag.
 *
 * This file deliberately contains no environment read, no configuration lookup
 * and no branch. `LIVE_EXECUTION_IMPLEMENTED` is a compile-time literal
 * `false`: there is no environment variable, feature flag, database row, header
 * or request parameter anywhere in this codebase that can change it. Turning it
 * on requires editing source and shipping a build — which is the point.
 *
 * A structural test asserts that this file never grows an environment read.
 *
 * Nothing in Phase 7A can send, amend or retract a real order. There is no
 * authenticated exchange client, no credential storage and no funds-movement
 * path.
 */

/** Compile-time capability. Always false in this build. */
export const LIVE_EXECUTION_IMPLEMENTED = false as const;

/** The English banner the UI must always show while the above is false. */
export const LIVE_NOT_IMPLEMENTED_BANNER_EN =
  "LIVE EXECUTION IS NOT IMPLEMENTED — NO REAL ORDERS";

export const LIVE_NOT_IMPLEMENTED_BANNER_FA =
  "اجرای واقعی پیاده‌سازی نشده است — هیچ سفارش واقعی ثبت نمی‌شود";

/**
 * Why live execution is unavailable, regardless of how many readiness gates
 * pass. This reason is structural, not a policy decision.
 */
export const LIVE_UNAVAILABLE_REASON_FA =
  "اجرای واقعی در این نسخه اصلاً پیاده‌سازی نشده است؛ هیچ متغیر محیطی یا تنظیمی نمی‌تواند آن را فعال کند.";

/**
 * The only execution surface that exists. `PAPER` is the paper broker;
 * `FAKE` exists solely for tests. There is deliberately no `LIVE` member — a
 * live broker is not a value this type can hold.
 */
export type ExecutionSurface = "PAPER" | "FAKE";
