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
  getStorageDiagnostics,
  listAlerts,
  listNotifications,
  newId,
  PriceAlertStorageError,
  probeFileStorageHealth,
  resolveStorageBackend,
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
  PriceAlertsPageResponse,
  PriceAlertsStorageDiagnostics
} from "@/lib/types";

export async function loadLivePriceBundle(): Promise<LivePriceBundle> {
  const settings = await getSettings();
  // Isolate each source family — one failure must not 500 the alerts page.
  const [domesticR, goldR, fxR, globalR] = await Promise.allSettled([
    getDomesticQuotes(settings),
    getGoldMarketPrices(settings),
    getFxStreetPrices(settings),
    getGlobalPrices(settings.globalMarketRefreshMinutes)
  ]);

  return {
    domestic: domesticR.status === "fulfilled" ? domesticR.value : [],
    gold: goldR.status === "fulfilled" ? goldR.value.quotes : [],
    fx: fxR.status === "fulfilled" ? fxR.value.quotes : [],
    global: globalR.status === "fulfilled" ? globalR.value : []
  };
}

async function buildDiagnostics(
  role: string | null,
  alertOk: boolean,
  notifOk: boolean
): Promise<PriceAlertsStorageDiagnostics> {
  const base = getStorageDiagnostics();
  let readable = base.readable;
  let writable = base.writable;
  if (base.storageType === "postgres") {
    const health = await probeFileStorageHealth();
    readable = health.readable;
    writable = health.writable;
  } else if (alertOk) {
    readable = true;
    writable = true;
  }
  return {
    ...base,
    persistent: base.storageType === "postgres",
    readable,
    writable,
    isVercel: base.vercel,
    alertQuerySucceeded: alertOk,
    notificationQuerySucceeded: notifOk,
    authenticatedRole: role
  };
}

function jsonSafePage(page: PriceAlertsPageResponse): PriceAlertsPageResponse {
  // Ensure JSON-serializable plain data (no NaN/Infinity).
  const sanitizeNum = (n: number | null | undefined): number | null =>
    n == null || !Number.isFinite(n) ? null : n;

  return {
    summary: {
      active: page.summary.active,
      triggered: page.summary.triggered,
      unread: page.summary.unread
    },
    instruments: page.instruments.map((inst) => ({
      ...inst,
      price: sanitizeNum(inst.price),
      providers: inst.providers.map((p) => ({
        ...p,
        buy: sanitizeNum(p.buy),
        sell: sanitizeNum(p.sell),
        mid: sanitizeNum(p.mid)
      }))
    })),
    alerts: page.alerts.map((a) => ({
      ...a,
      targetPrice: Number.isFinite(a.targetPrice) ? a.targetPrice : 0,
      previousObservedPrice: sanitizeNum(a.previousObservedPrice),
      lastEvaluatedPrice: sanitizeNum(a.lastEvaluatedPrice)
    })),
    notifications: page.notifications.map((n) => ({
      ...n,
      targetPrice: Number.isFinite(n.targetPrice) ? n.targetPrice : 0,
      actualPrice: Number.isFinite(n.actualPrice) ? n.actualPrice : 0
    })),
    lastEvaluatedAt: page.lastEvaluatedAt,
    diagnostics: page.diagnostics
  };
}

export async function getPriceAlertsPage(role: string | null = null): Promise<PriceAlertsPageResponse> {
  const backend = resolveStorageBackend();
  const live = await loadLivePriceBundle();

  let alertOk = true;
  let notifOk = true;
  let alerts: PriceAlertRule[] = [];
  let notifications: Awaited<ReturnType<typeof listNotifications>> = [];
  let unread = 0;
  let lastEvaluatedAt: string | null = null;

  // postgres is the only backend; probe once so missing DATABASE_URL surfaces in diagnostics
  void backend;

  try {
    const evaluation = await evaluatePriceAlerts(live);
    lastEvaluatedAt = evaluation.lastEvaluatedAt;
  } catch {
    // evaluation is best-effort; page still loads rules
    lastEvaluatedAt = null;
  }

  try {
    alerts = await listAlerts();
  } catch {
    alertOk = false;
    alerts = [];
  }

  try {
    notifications = await listNotifications();
    unread = await unreadCount();
  } catch {
    notifOk = false;
    notifications = [];
    unread = 0;
  }

  const summary = {
    active: alerts.filter((a) => a.enabled && a.status === "active").length,
    triggered: alerts.filter((a) => a.status === "triggered" || a.triggerCount > 0).length,
    unread
  };

  return jsonSafePage({
    summary,
    instruments: buildInstrumentSnapshots(live),
    alerts,
    notifications,
    lastEvaluatedAt,
    diagnostics: await buildDiagnostics(role, alertOk, notifOk)
  });
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
  void resolveStorageBackend(); // postgres only; write fails closed without DATABASE_URL
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
