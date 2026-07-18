# Docker production deployment (Price Alerts persistence)

## Architecture

| Environment | Storage | Notes |
|-------------|---------|--------|
| Docker production | `PRICE_ALERTS_STORAGE=file` | Named volume `iman-otc-alerts-data` → `/app/data/price-alerts` |
| Vercel | Upstash if configured, else `none` | **Never** writes local files |
| Local dev | file under `.data/` by default | Gitignored |

**Do not horizontally scale multiple app replicas** against the same JSON file. One active writer only. For multi-replica, set `PRICE_ALERTS_STORAGE=upstash` and configure Upstash REST credentials.

## Tracked files in this repository

- `Dockerfile` — multi-stage Alpine build (Node **20** LTS via Public ECR mirror by default)
- `Dockerfile.prebuilt` — runtime-only image (build Next on the host; no pnpm in Docker)
- `scripts/docker-build-prebuilt.sh` — host build + thin image (best against Hub rate limits)
- `docker-entrypoint.sh` — mkdir/chown/writable check, then drop to `nextjs`
- `docker-compose.yml` — service `iman-otc-desk`, volume, env, `NODE_IMAGE` build arg
- `docker-compose.production.yml` — minimal override for external compose parents
- `scripts/deploy-production.sh` — safe pull + rebuild (never deletes volumes)

## Docker base image & rate limits

Default base image is **not** pulled from Docker Hub:

```text
public.ecr.aws/docker/library/node:20-alpine
```

That is the official Node Alpine image mirrored on AWS Public ECR (same bits as `node:20-alpine`, fewer anonymous Hub 403s).

| Goal | Command |
|------|---------|
| Normal compose build | `docker compose up -d --build --force-recreate iman-otc-desk` |
| Force Docker Hub Node | `NODE_IMAGE=node:20-alpine docker compose build iman-otc-desk` |
| Google mirror | `NODE_IMAGE=mirror.gcr.io/library/node:20-alpine docker compose build …` |
| **Minimal Hub + no npm in Docker** | `./scripts/docker-build-prebuilt.sh` then `docker compose up -d --force-recreate iman-otc-desk` (image already tagged) |

`Dockerfile` changes vs the heavy v2.1.5/2.1.6 draft:

- Node **20-alpine** LTS (not 22) — more often already cached on servers
- **One** build stage + one runtime stage (no repeated `apk` / `corepack prepare pnpm@latest`)
- **Pinned** `pnpm@9.15.9` (no floating `latest`)
- No `# syntax=docker/dockerfile:1` frontend pull from Hub
- Optional **prebuilt** path: compile on the host, Docker only copies standalone + `su-exec`

## Normal deploy (after one-time alignment)

```bash
cd /path/to/iman-otc-desk   # or your compose project root
git pull                    # fast-forward only preferred
docker context use desktop-linux   # if required on the host
docker compose up -d --build --force-recreate iman-otc-desk
```

Or:

```bash
./scripts/deploy-production.sh
```

**Never** run `docker compose down -v` during normal deploy — it deletes `iman-otc-alerts-data`.

## One-time server alignment

If production currently uses an **external** compose file only (e.g. `/home/server/docker-projects/docker-compose.yml`) that is **not** updated by `git pull`:

1. Ensure the app image is built from this repository (build context = repo root with the new Dockerfile).
2. Add to the `iman-otc-desk` service (or include the override):

```yaml
services:
  iman-otc-desk:
    environment:
      PRICE_ALERTS_STORAGE: file
      PRICE_ALERTS_DATA_DIR: /app/data/price-alerts
      PRICE_ALERTS_DATA_FILE: /app/data/price-alerts/price-alerts.json
    volumes:
      - iman-otc-alerts-data:/app/data/price-alerts

volumes:
  iman-otc-alerts-data:
    name: iman-otc-alerts-data
```

3. Prefer switching the deploy directory to this repo (or a git clone) so future pulls apply compose changes automatically.

4. Preserve existing secrets (`.env` / host env). Do not commit passwords or Upstash tokens.

### Example external compose include

```yaml
# /home/server/docker-projects/docker-compose.yml (sketch)
services:
  iman-otc-desk:
    build: /home/server/docker-projects/iman-otc-desk
    # ... ports, secrets env_file ...
    extends:
      file: /home/server/docker-projects/iman-otc-desk/docker-compose.production.yml
      service: iman-otc-desk
```

(If `extends` is unavailable in your Compose version, copy the `environment` + `volumes` + top-level `volumes` block once.)

## Environment variables

| Variable | Docker production | Description |
|----------|-------------------|-------------|
| `PRICE_ALERTS_STORAGE` | `file` | `file` \| `upstash` \| `none` |
| `PRICE_ALERTS_DATA_DIR` | `/app/data/price-alerts` | Writable directory |
| `PRICE_ALERTS_DATA_FILE` | `/app/data/price-alerts/price-alerts.json` | JSON store path |
| `UPSTASH_REDIS_REST_URL` | not required | Optional / Vercel |
| `UPSTASH_REDIS_REST_TOKEN` | not required | Optional / Vercel |

Auth and other secrets stay in host `.env` (not committed).

## Diagnostics

Authenticated `GET /api/alerts` includes:

```json
{
  "diagnostics": {
    "storageType": "file",
    "storageConfigured": true,
    "persistent": true,
    "readable": true,
    "writable": true
  }
}
```

No absolute host paths, alert contents, or secrets are exposed.

## Legacy migration

On first start with an empty volume file, the app may copy a valid legacy store from:

- `.data/price-alerts.json`
- `/app/.data/price-alerts.json`

Never overwrites non-empty new data. Does not log alert contents.

## Health / verification checklist

1. `PRICE_ALERTS_STORAGE=file` inside container  
2. Volume mounted at `/app/data/price-alerts`  
3. Create alert → appears in `GET /api/alerts`  
4. `docker restart iman-otc-desk` → alert remains  
5. `docker compose up -d --force-recreate iman-otc-desk` → alert remains  
6. Rebuild image → alert remains  
7. No UI banner «ذخیره‌سازی هشدارها در این محیط پیکربندی نشده است.»  
8. No `ENOENT` on `/var/task/.data`  
