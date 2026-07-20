/**
 * Generic key/value store on app_settings (JSONB).
 * Used for durable blobs that are not first-class relational tables yet:
 * gold history, forex event history, intelligence history, translation cache, etc.
 */
import { eq } from "drizzle-orm";
import { asDbError, getDbAsync, withPgliteSerial } from "@/db/client";
import { appSettings } from "@/db/schema";

export async function pgGetKv<T = unknown>(key: string): Promise<T | null> {
  try {
    const db = await getDbAsync();
    return await withPgliteSerial(async () => {
      const rows = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
      if (!rows[0]) return null;
      return rows[0].value as T;
    });
  } catch (error) {
    throw asDbError(error, `kv read ${key}`);
  }
}

export async function pgSetKv(key: string, value: unknown, updatedBy: string | null = null): Promise<void> {
  try {
    const db = await getDbAsync();
    const now = new Date().toISOString();
    const payload = value as Record<string, unknown>;
    await withPgliteSerial(async () => {
      await db
        .insert(appSettings)
        .values({
          key,
          value: payload,
          updatedBy,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: {
            value: payload,
            updatedBy,
            updatedAt: now
          }
        });
    });
  } catch (error) {
    throw asDbError(error, `kv write ${key}`);
  }
}
