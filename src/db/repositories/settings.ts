import { eq } from "drizzle-orm";
import { asDbError, getDbAsync, withPgliteSerial } from "@/db/client";
import { appSettings } from "@/db/schema";
import type { DeskSettings } from "@/lib/types";

const SETTINGS_KEY = "desk_settings";

export async function pgGetSettingsJson(): Promise<Partial<DeskSettings> | null> {
  try {
    const db = await getDbAsync();
    return await withPgliteSerial(async () => {
      const rows = await db
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, SETTINGS_KEY))
        .limit(1);
      if (!rows[0]) return null;
      return rows[0].value as Partial<DeskSettings>;
    });
  } catch (error) {
    throw asDbError(error, "settings read");
  }
}

export async function pgSaveSettingsJson(
  value: DeskSettings,
  updatedBy: string | null = null
): Promise<void> {
  try {
    const db = await getDbAsync();
    const now = new Date().toISOString();
    await withPgliteSerial(async () => {
      await db
        .insert(appSettings)
        .values({
          key: SETTINGS_KEY,
          value: value as unknown as Record<string, unknown>,
          updatedBy,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: {
            value: value as unknown as Record<string, unknown>,
            updatedBy,
            updatedAt: now
          }
        });
    });
  } catch (error) {
    throw asDbError(error, "settings write");
  }
}
