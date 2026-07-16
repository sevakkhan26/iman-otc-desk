import type { PriceAlertCondition, PriceAlertRule, PriceAlertStatus } from "@/lib/types";
import {
  type LivePriceBundle,
  type ObservedQuote,
  resolveObservedQuotes
} from "@/lib/priceAlerts/instruments";
import {
  appendNotification,
  listAlerts,
  newId,
  updateAlert
} from "@/lib/priceAlerts/store";

export function evaluateCondition(
  condition: PriceAlertCondition,
  price: number,
  target: number,
  previous: number | null
): boolean {
  if (!Number.isFinite(price) || !Number.isFinite(target)) return false;
  if (condition === "gte") return price >= target;
  if (condition === "lte") return price <= target;
  if (condition === "cross_up") {
    if (previous === null || !Number.isFinite(previous)) return false;
    return previous < target && price >= target;
  }
  if (condition === "cross_down") {
    if (previous === null || !Number.isFinite(previous)) return false;
    return previous > target && price <= target;
  }
  return false;
}

function computeStatus(
  rule: PriceAlertRule,
  quotes: ObservedQuote[]
): PriceAlertStatus {
  // One-time completed alerts stay «فعال‌شده» even when disabled after fire.
  if (rule.repeatMode === "once" && rule.triggerCount > 0) return "triggered";
  if (!rule.enabled) return "disabled";
  if (rule.providerMode === "specific") {
    if (!quotes.length) return "disconnected";
    if (quotes.every((q) => q.stale || q.status === "unavailable")) return "disconnected";
    if (quotes.some((q) => q.stale || q.status === "degraded")) return "degraded";
  } else {
    if (!quotes.length) return "disconnected";
    if (quotes.every((q) => q.stale)) return "disconnected";
  }
  return "active";
}

export type EvaluationResult = {
  evaluated: number;
  triggered: number;
  notificationIds: string[];
  lastEvaluatedAt: string;
};

/**
 * Evaluate all enabled price alerts against a live price snapshot.
 * Uses only the provided bundle (no extra provider fetches).
 */
export async function evaluatePriceAlerts(live: LivePriceBundle): Promise<EvaluationResult> {
  const now = new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const rules = await listAlerts();
  let triggered = 0;
  const notificationIds: string[] = [];

  for (const rule of rules) {
    const quotes = resolveObservedQuotes(
      rule.instrument,
      rule.priceType,
      rule.providerMode,
      rule.providerId,
      live
    );
    const status = computeStatus(rule, quotes);

    const validQuotes = quotes.filter((q) => !q.stale && q.status !== "unavailable");
    const sample = validQuotes[0] ?? quotes[0] ?? null;

    if (status === "disabled" || status === "triggered") {
      if (rule.status !== status) {
        await updateAlert(rule.id, { status });
      }
      continue;
    }

    if (status === "disconnected" || status === "degraded") {
      await updateAlert(rule.id, {
        status,
        lastEvaluatedAt: nowIso,
        lastEvaluatedPrice: sample?.price ?? rule.lastEvaluatedPrice
      });
      // Never trigger on disconnected/stale
      if (status === "disconnected" || !validQuotes.length) continue;
      // degraded specific source: still may have price but user said don't trigger from stale
      if (validQuotes.every((q) => q.stale)) continue;
    }

    // For any-source or healthy specific: try each valid quote
    let didTrigger = false;
    let triggerQuote: ObservedQuote | null = null;

    for (const q of validQuotes) {
      if (q.stale) continue;
      const hit = evaluateCondition(rule.condition, q.price, rule.targetPrice, rule.previousObservedPrice);
      if (hit) {
        // cooldown for repeating
        if (rule.repeatMode === "repeat" && rule.lastTriggeredAt) {
          const last = new Date(rule.lastTriggeredAt).getTime();
          if (Number.isFinite(last) && nowMs - last < Math.max(0, rule.cooldownSeconds) * 1000) {
            continue;
          }
        }
        // one-time already handled via status
        if (rule.repeatMode === "once" && rule.triggerCount > 0) continue;

        didTrigger = true;
        triggerQuote = q;
        break;
      }
    }

    // Update previous observed from first valid quote (for crossing logic)
    const observed = validQuotes[0]?.price ?? null;
    const patch: Partial<PriceAlertRule> = {
      status: didTrigger && rule.repeatMode === "once" ? "triggered" : "active",
      lastEvaluatedAt: nowIso,
      lastEvaluatedPrice: observed ?? rule.lastEvaluatedPrice,
      previousObservedPrice: observed ?? rule.previousObservedPrice,
      enabled: didTrigger && rule.repeatMode === "once" ? false : rule.enabled
    };

    if (didTrigger && triggerQuote) {
      triggered += 1;
      const notificationId = newId("pn");
      notificationIds.push(notificationId);
      await appendNotification({
        id: notificationId,
        alertId: rule.id,
        instrument: rule.instrument,
        providerId: triggerQuote.providerId,
        providerName: triggerQuote.providerName,
        priceType: rule.priceType,
        targetPrice: rule.targetPrice,
        actualPrice: triggerQuote.price,
        condition: rule.condition,
        triggeredAt: nowIso,
        note: rule.note,
        readAt: null
      });
      patch.lastTriggeredAt = nowIso;
      patch.triggerCount = rule.triggerCount + 1;
      patch.lastProviderId = triggerQuote.providerId;
      patch.lastProviderName = triggerQuote.providerName;
      // After cross, set previous to current so re-fire needs new cross
      patch.previousObservedPrice = triggerQuote.price;
      patch.lastEvaluatedPrice = triggerQuote.price;
    }

    await updateAlert(rule.id, patch);
  }

  return {
    evaluated: rules.length,
    triggered,
    notificationIds,
    lastEvaluatedAt: nowIso
  };
}
