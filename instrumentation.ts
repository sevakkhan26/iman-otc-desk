/**
 * Next.js server instrumentation.
 *
 * The body must stay tiny and runtime-gated. `middleware.ts` makes Next compile
 * this file for the edge runtime as well, and the collector pulls in node-only
 * modules (node:https, PGlite). Keeping the import inside
 * `if (process.env.NEXT_RUNTIME === "nodejs")` lets Next's inlined constant
 * eliminate the branch — and the import with it — from the edge bundle.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation.node");
  }
}
