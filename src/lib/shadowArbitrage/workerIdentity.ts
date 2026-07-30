/**
 * Collector worker identity.
 *
 * The id encodes host and pid so a lease left behind by a process that no
 * longer exists can be reclaimed immediately. Without this, restarting the app
 * leaves collection idle until the lease expires — Next.js exits on SIGTERM
 * before an async lease release can finish.
 *
 * Format: `shadow-<kind>-<host>-<pid>-<random>`
 */
import { hostname } from "node:os";

export type WorkerKind = "web" | "inproc" | "worker" | "manual" | "test";

function safeHost(): string {
  return (hostname() || "unknown").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24) || "unknown";
}

export function makeWorkerId(kind: WorkerKind, pid = process.pid): string {
  return `shadow-${kind}-${safeHost()}-${pid}-${Date.now().toString(36)}`;
}

export type ParsedWorkerId = { kind: string; host: string; pid: number } | null;

export function parseWorkerId(id: string | null | undefined): ParsedWorkerId {
  if (!id) return null;
  const m = /^shadow-([a-z]+)-([a-zA-Z0-9]+)-(\d+)-[a-z0-9]+$/.exec(id);
  if (!m) return null;
  return { kind: m[1]!, host: m[2]!, pid: Number(m[3]) };
}

/**
 * True when the id belongs to this host and that process is gone, i.e. the
 * lease is stale and safe to take over. Unknown formats and other hosts are
 * always treated as "still alive" so a real holder is never displaced.
 */
export function isDeadLocalWorker(id: string | null | undefined): boolean {
  const parsed = parseWorkerId(id);
  if (!parsed) return false;
  if (parsed.host !== safeHost()) return false;
  if (!Number.isFinite(parsed.pid) || parsed.pid <= 0) return false;
  if (parsed.pid === process.pid) return false;
  try {
    // Signal 0 only checks for existence.
    process.kill(parsed.pid, 0);
    return false;
  } catch (error) {
    // EPERM means the process exists but is owned by someone else.
    const code = (error as { code?: string }).code;
    return code !== "EPERM";
  }
}
