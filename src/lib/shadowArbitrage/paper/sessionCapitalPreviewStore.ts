/**
 * Durable previewToken bindings for Paper session-capital apply.
 *
 * Preview freezes allocations + capital/cap/duration inputs under the token.
 * Apply loads that binding — it must not re-hash against a drifted live book.
 * LIVE=false forever; Paper only.
 */
import { pgGetKv, pgSetKv } from "@/db/repositories/kv";
import type {
  SessionCapitalLimitsSnapshot,
  SessionOrderCapChoice,
  SessionSetupPreviewBinding
} from "@/lib/shadowArbitrage/paper/sessionCapital";
import { hashSessionSetupPreviewToken } from "@/lib/shadowArbitrage/paper/sessionCapital";

/** Preview bindings expire after 15 minutes (clock drift / abandoned UI). */
export const PREVIEW_TOKEN_TTL_MS = 15 * 60_000;

const KV_PREFIX = "paper_session_capital_preview_v1:";

export type PersistedSessionCapitalPreview = {
  version: 1;
  previewToken: string;
  createdAt: string;
  expiresAt: string;
  binding: SessionSetupPreviewBinding;
  /** ISO provisional start from preview clock (informational). */
  startedAt: string | null;
  endsAt: string | null;
  orderCapChoice: SessionOrderCapChoice;
  paperPolicyMinUsdt: number;
  smartSizeCeilingUsdt: number;
  usableCapitalToman: number;
  reserveCapitalToman: number;
  limits: SessionCapitalLimitsSnapshot;
};

function keyFor(token: string): string {
  return `${KV_PREFIX}${token}`;
}

export async function persistSessionCapitalPreview(
  record: PersistedSessionCapitalPreview
): Promise<void> {
  // Defensive: refuse to store a record whose token does not match binding.
  const expected = hashSessionSetupPreviewToken(record.binding);
  if (expected !== record.previewToken) {
    throw new Error("previewToken does not match binding");
  }
  await pgSetKv(keyFor(record.previewToken), record, "paper-session-capital");
}

export async function loadSessionCapitalPreview(
  previewToken: string,
  nowMs: number = Date.now()
): Promise<PersistedSessionCapitalPreview | null> {
  if (!previewToken || previewToken.length < 32) return null;
  const record = await pgGetKv<PersistedSessionCapitalPreview>(keyFor(previewToken));
  if (!record || record.version !== 1) return null;
  if (record.previewToken !== previewToken) return null;
  const exp = Date.parse(record.expiresAt);
  if (!Number.isFinite(exp) || exp < nowMs) return null;
  const expected = hashSessionSetupPreviewToken(record.binding);
  if (expected !== previewToken) return null;
  return record;
}

/** Request fields that must match the frozen binding on apply. */
export function requestMatchesPreviewBinding(input: {
  binding: SessionSetupPreviewBinding;
  totalCapitalToman: number;
  valuationPriceToman: number;
  durationDays: number;
  orderCapChoice: SessionOrderCapChoice;
  manualOrderCapUsdt: number | null;
  activeSessionId: string | null;
}): boolean {
  const b = input.binding;
  if (Math.round(b.totalCapitalToman) !== Math.round(input.totalCapitalToman)) return false;
  if (Math.round(b.valuationPriceToman) !== Math.round(input.valuationPriceToman)) return false;
  if ((b.durationDays ?? null) !== input.durationDays) return false;
  if ((b.orderCapChoice ?? "AUTO_CAPITAL_DERIVED") !== input.orderCapChoice) return false;
  if ((b.activeSessionId ?? null) !== (input.activeSessionId ?? null)) return false;
  if (input.orderCapChoice === "MANUAL") {
    if (b.manualOrderCapUsdt == null || b.manualOrderCapUsdt !== input.manualOrderCapUsdt) {
      return false;
    }
  }
  return true;
}

export function allocationsFingerprint(
  allocations: Array<{ sourceId: string; irtToman: number; usdtUnits: number }>
): string {
  return [...allocations]
    .map((a) => `${a.sourceId}:${Math.round(a.irtToman)}:${a.usdtUnits}`)
    .sort()
    .join("|");
}

