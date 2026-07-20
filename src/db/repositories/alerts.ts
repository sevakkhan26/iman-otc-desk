import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { alertNotifications, priceAlerts } from "@/db/schema";

export async function pgLoadAlertsBundle(): Promise<{
  alerts: unknown[];
  notifications: unknown[];
}> {
  const db = getDb();
  const a = await db.select().from(priceAlerts);
  const n = await db.select().from(alertNotifications);
  return {
    alerts: a.map((r) => r.payload),
    notifications: n.map((r) => r.payload)
  };
}

export async function pgSaveAlertsBundle(bundle: {
  alerts: Array<{ id: string } & Record<string, unknown>>;
  notifications: Array<{ id: string; alertId?: string; triggeredAt?: string } & Record<string, unknown>>;
}): Promise<void> {
  const db = getDb();
  // Replace strategy inside transaction semantics: delete all + insert
  await db.delete(alertNotifications);
  await db.delete(priceAlerts);
  if (bundle.alerts.length) {
    await db.insert(priceAlerts).values(
      bundle.alerts.map((al) => ({
        id: String(al.id),
        payload: al,
        createdAt: typeof al.createdAt === "string" ? al.createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }))
    );
  }
  if (bundle.notifications.length) {
    await db.insert(alertNotifications).values(
      bundle.notifications.map((n) => ({
        id: String(n.id),
        alertId: n.alertId ? String(n.alertId) : null,
        payload: n,
        triggeredAt: typeof n.triggeredAt === "string" ? n.triggeredAt : null,
        createdAt: new Date().toISOString()
      }))
    );
  }
}

export async function pgUpsertAlert(alert: { id: string } & Record<string, unknown>): Promise<void> {
  const db = getDb();
  await db
    .insert(priceAlerts)
    .values({
      id: String(alert.id),
      payload: alert,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
    .onConflictDoUpdate({
      target: priceAlerts.id,
      set: {
        payload: alert,
        updatedAt: new Date().toISOString()
      }
    });
}

export async function pgDeleteAlert(id: string): Promise<void> {
  const db = getDb();
  await db.delete(priceAlerts).where(eq(priceAlerts.id, id));
}
