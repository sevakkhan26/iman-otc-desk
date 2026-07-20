import { closeDb, pingDatabase } from "../src/db/client.ts";
import { pgListApiKeyRecords } from "../src/db/repositories/apiKeys.ts";
import { pgReadLatestTetherSnapshot } from "../src/db/repositories/marketSnapshots.ts";
import { pgLoadAlertsBundle } from "../src/db/repositories/alerts.ts";
import { getSettings } from "../src/lib/settings.ts";

async function main() {
  const ping = await pingDatabase();
  console.log("ping", ping);
  const keys = await pgListApiKeyRecords();
  console.log(
    "api_keys",
    keys.length,
    keys.map((k) => ({ name: k.name, scopes: k.scopes, revoked: Boolean(k.revokedAt) }))
  );
  const snap = await pgReadLatestTetherSnapshot();
  console.log("snapshot median", snap?.tetherMarket?.summary?.median, "generated", snap?.generatedAt);
  const settings = await getSettings();
  console.log("settings priceRefresh", settings.priceRefreshMinutes);
  const alerts = await pgLoadAlertsBundle();
  console.log("alerts", alerts.alerts.length, "notifications", alerts.notifications.length);
  const active = keys.filter((k) => !k.revokedAt);
  console.log(
    "active key hashes",
    active.map((k) => k.keyHash.slice(0, 16))
  );
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
