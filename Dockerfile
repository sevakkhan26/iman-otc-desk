# Production image for iman-otc-desk (Next.js standalone).
# PostgreSQL: schema migrations run automatically on container start (DATABASE_URL).
# Legacy JSON volume at /app/data/price-alerts kept as cold backup for one-shot import.
#
# Rate-limit notes:
# - Default base image is the AWS Public ECR mirror of official Node (not Docker Hub).
# - Override if needed:  --build-arg NODE_IMAGE=node:20-alpine
#
# Do NOT use "# syntax=docker/dockerfile:1" — that pulls an extra image from Docker Hub.

ARG NODE_IMAGE=public.ecr.aws/docker/library/node:20-alpine
FROM ${NODE_IMAGE} AS builder

WORKDIR /app

RUN apk add --no-cache libc6-compat

COPY package.json pnpm-lock.yaml ./
RUN corepack enable \
  && corepack prepare pnpm@9.15.9 --activate \
  && pnpm install --frozen-lockfile

COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN pnpm build

# Materialize postgres package for the migrator (pnpm store uses symlinks).
RUN mkdir -p /app/docker-migrate-deps \
  && cp -aL node_modules/postgres /app/docker-migrate-deps/postgres

# --- runtime ---
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:20-alpine
FROM ${NODE_IMAGE} AS runner

WORKDIR /app

RUN apk add --no-cache su-exec \
  && addgroup -S -g 1001 nodejs \
  && adduser -S -u 1001 -G nodejs nextjs

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV PRICE_ALERTS_DATA_DIR=/app/data/price-alerts
ENV PRICE_ALERTS_DATA_FILE=/app/data/price-alerts/price-alerts.json
# Set on the server (never in Git): DATABASE_URL=postgres://…
# First cutover only: AUTO_IMPORT_LEGACY=1 then remove after success.

RUN mkdir -p /app/data/price-alerts /app/scripts /app/drizzle /app/node_modules \
  && chown -R nextjs:nodejs /app/data

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Auto-migrate: SQL + plain Node runner + postgres driver
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=nextjs:nodejs /app/scripts/run-migrations.mjs ./scripts/run-migrations.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/run-legacy-import.mjs ./scripts/run-legacy-import.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/run-legacy-import-data.mjs ./scripts/run-legacy-import-data.mjs
COPY --from=builder --chown=nextjs:nodejs /app/docker-migrate-deps/postgres ./node_modules/postgres

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh \
  && chown -R nextjs:nodejs /app/scripts /app/drizzle

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
