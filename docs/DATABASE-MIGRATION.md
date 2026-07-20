# Data migration runbook (JSON / Redis → PostgreSQL)

## Importer

```bash
export DATABASE_URL=…   # required

pnpm db:migrate
pnpm db:import:dry      # --dry-run: counts only
pnpm db:import          # real import
```

Script: `scripts/import-legacy-to-postgres.mts`

### Properties

- **Never deletes** source `.data/*` files
- **Idempotent** (second run skips existing hashes / ids)
- **`--dry-run`** supported
- Writes machine-readable report to `.data/migration-report-*.json`
- Validates API key hashes are 64-char hex HMAC; **aborts** if incompatible

### Sources imported

| Source | Target |
|--------|--------|
| `.data/settings.json` | `app_settings` |
| `.data/tether-api-keys.json` | `api_keys` + `api_key_scopes` |
| `desk-users.json` | `users` |
| `viewer-auth.json` | `app_settings.viewer_auth_override` |
| `price-alerts.json` | `price_alerts` + `alert_notifications` |
| `market-snapshot.json` | `market_snapshots` (+ quotes/health) |
| `median-history.json` | `median_history_samples` |
| `impact-news-store.json` | `news_items` + meta |

Env bootstrap users (`ADMIN_*` / `VIEWER_*`) continue to work without a file row.

## Cutover checklist

1. Backup production JSON volume + (if any) Redis
2. Deploy schema (`db:migrate`)
3. Dry-run import; review counts
4. Real import; re-run to prove idempotency
5. Verify admin + viewer login against PG
6. Verify API keys still authenticate (same HMAC secret)
7. Restart app with `DATABASE_URL` only
8. Confirm no runtime JSON writes for durable domains
9. Mark obsolete env vars (do not auto-delete)

## Rollback

See [DATABASE-BACKUP.md](./DATABASE-BACKUP.md). App can be pointed back at the previous image/config only if you have not deleted source volumes; runtime no longer reads JSON, so rollback requires redeploying a pre-PostgreSQL build.
