import { evaluatePriceAlerts } from "@/lib/priceAlerts/engine";
import {
  buildInstrumentSnapshots,
  instrumentMeta,
  isValidTargetPrice,
  type LivePriceBundle
} from "@/lib/priceAlerts/instruments";
import {
  createAlert,
  deleteAlert,
  listAlerts,
  listNotifications,
  newId,
  unreadCount,
  updateAlert
} from "@/lib/priceAlerts/store";
import { getDomesticQuotes } from "@/lib/providers/domestic";
import { getGlobalPrices } from "@/lib/providers/globalMarket";
import { getGoldMarketPrices } from "@/lib/providers/goldMarket";
import { getFxStreetPrices } from "@/lib/providers/fxStreet";
import { getSettings } from "@/lib/settings";
import type {
  PriceAlertCondition,
  PriceAlertInstrumentId,
  PriceAlertPriceType,
  PriceAlertProviderMode,
  PriceAlertRepeatMode,
  PriceAlertRule,
  PriceAlertsPageResponse
} from "@/lib/types";

export async function loadLivePriceBundle(): Promise<LivePriceBundle> {
  const settings = await getSettings();
  const [domestic, goldRes, fxRes, global] = await Promise.all([
    getDomesticQuotes(settings),
    getGoldMarketPrices(settings),
    getFxStreetPrices(settings),
    getGlobalPrices(settings.globalMarketRefreshMinutes)
  ]);
  return {
    domestic,
    gold: goldRes.quotes,
    fx: fxRes.quotes,
    global
  };
}

export async function getPriceAlertsPage(): Promise<PriceAlertsPageResponse> {
  const live = await loadLivePriceBundle();
  const evaluation = await evaluatePriceAlerts(live);
  const [alerts, notifications, unread] = await Promise.all([
    listAlerts(),
    listNotifications(),
    unreadCount()
  ]);

  const summary = {
    active: alerts.filter((a) => a.enabled && a.status === "active").length,
    triggered: alerts.filter((a) => a.status === "triggered" || a.triggerCount > 0).length,
    unread
  };

  return {
    summary,
    instruments: buildInstrumentSnapshots(live),
    alerts,
    notifications,
    lastEvaluatedAt: evaluation.lastEvaluatedAt
  };
}

export type CreateAlertInput = {
  instrument: PriceAlertInstrumentId;
  targetPrice: number;
  condition: PriceAlertCondition;
  priceType: PriceAlertPriceType;
  providerMode: PriceAlertProviderMode;
  providerId?: string | null;
  enabled?: boolean;
  repeatMode: PriceAlertRepeatMode;
  cooldownSeconds?: number;
  note?: string | null;
  createdBy: string;
};

export function validateCreateInput(input: CreateAlertInput): string | null {
  if (!instrumentMeta(input.instrument)) return "ابزار نامعتبر است";
  if (!isValidTargetPrice(input.instrument, input.targetPrice)) return "قیمت هدف نامعتبر است";
  if (!["gte", "lte", "cross_up", "cross_down"].includes(input.condition)) return "شرط نامعتبر است";
  if (!["buy", "sell", "mid", "reference"].includes(input.priceType)) return "نوع قیمت نامعتبر است";
  if (input.providerMode === "specific" && !input.providerId) return "منبع مشخص نشده است";
  if (!["once", "repeat"].includes(input.repeatMode)) return "حالت تکرار نامعتبر است";
  return null;
}

export async function createPriceAlert(input: CreateAlertInput): Promise<PriceAlertRule> {
  const err = validateCreateInput(input);
  if (err) throw new Error(err);
  const now = new Date().toISOString();
  const rule: PriceAlertRule = {
    id: newId("pa"),
    instrument: input.instrument,
    targetPrice: input.targetPrice,
    condition: input.condition,
    priceType: input.priceType,
    providerMode: input.providerMode,
    providerId: input.providerMode === "specific" ? input.providerId ?? null : null,
    enabled: input.enabled !== false,
    repeatMode: input.repeatMode,
    cooldownSeconds: Math.max(0, Math.floor(input.cooldownSeconds ?? 300)),
    expiresAt: null,
    note: input.note?.trim() ? input.note.trim().slice(0, 200) : null,
    previousObservedPrice: null,
    lastEvaluatedPrice: null,
    lastEvaluatedAt: null,
    lastTriggeredAt: null,
    triggerCount: 0,
    lastProviderId: null,
    lastProviderName: null,
    status: input.enabled === false ? "disabled" : "active",
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now
  };
  return createAlert(rule);
}

export async function patchPriceAlert(
  id: string,
  patch: Partial<CreateAlertInput> & { enabled?: boolean },
  actor: string
): Promise<PriceAlertRule | null> {
  const existing = (await listAlerts()).find((a) => a.id === id);
  if (!existing) return null;

  const next: CreateAlertInput = {
    instrument: patch.instrument ?? existing.instrument,
    targetPrice: patch.targetPrice ?? existing.targetPrice,
    condition: patch.condition ?? existing.condition,
    priceType: patch.priceType ?? existing.priceType,
    providerMode: patch.providerMode ?? existing.providerMode,
    providerId: patch.providerId !== undefined ? patch.providerId : existing.providerId,
    repeatMode: patch.repeatMode ?? existing.repeatMode,
    cooldownSeconds: patch.cooldownSeconds ?? existing.cooldownSeconds,
    note: patch.note !== undefined ? patch.note : existing.note,
    createdBy: actor
  };
  const err = validateCreateInput(next);
  if (err) throw new Error(err);

  const enabled = patch.enabled !== undefined ? patch.enabled : existing.enabled;
  return updateAlert(id, {
    instrument: next.instrument,
    targetPrice: next.targetPrice,
    condition: next.condition,
    priceType: next.priceType,
    providerMode: next.providerMode,
    providerId: next.providerMode === "specific" ? next.providerId ?? null : null,
    enabled,
    repeatMode: next.repeatMode,
    cooldownSeconds: Math.max(0, Math.floor(next.cooldownSeconds ?? 300)),
    expiresAt: null,
    note: next.note?.trim() ? String(next.note).trim().slice(0, 200) : null,
    status: !enabled
      ? "disabled"
      : existing.status === "triggered" && existing.repeatMode === "once"
        ? "triggered"
        : "active"
  });
}

export async function removePriceAlert(id: string): Promise<boolean> {
  return deleteAlert(id);
}
