# Production image for iman-otc-desk (Next.js standalone).
# Price Alerts: named volume at /app/data/price-alerts (see docker-compose.yml).
#
# Rate-limit notes:
# - Default base image is the AWS Public ECR mirror of official Node (not Docker Hub).
# - Override if needed:  --build-arg NODE_IMAGE=node:20-alpine
# - Prefer Dockerfile.prebuilt + scripts/docker-build-prebuilt.sh when Hub/npm in Docker is painful.
#
# Do NOT use "# syntax=docker/dockerfile:1" — that pulls an extra image from Docker Hub.

ARG NODE_IMAGE=public.ecr.aws/docker/library/node:20-alpine
FROM ${NODE_IMAGE} AS builder

WORKDIR /app

# One apk layer for build (libc for some native Next deps on Alpine)
RUN apk add --no-cache libc6-compat

# Install deps only when lockfiles change (layer cache)
COPY package.json pnpm-lock.yaml ./
# Pin pnpm — avoid "pnpm@latest" (extra registry traffic every build)
RUN corepack enable \
  && corepack prepare pnpm@9.15.9 --activate \
  && pnpm install --frozen-lockfile

COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN pnpm build

# --- runtime (single official/mirrored Node Alpine pull + tiny apk) ---
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:20-alpine
FROM ${NODE_IMAGE} AS runner

WORKDIR /app

# su-exec: drop root after volume chown (small; no gosu)
RUN apk add --no-cache su-exec \
  && addgroup -S -g 1001 nodejs \
  && adduser -S -u 1001 -G nodejs nextjs

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV PRICE_ALERTS_STORAGE=file
ENV PRICE_ALERTS_DATA_DIR=/app/data/price-alerts
ENV PRICE_ALERTS_DATA_FILE=/app/data/price-alerts/price-alerts.json

RUN mkdir -p /app/data/price-alerts \
  && chown -R nextjs:nodejs /app/data

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

# Entrypoint starts as root to chown the volume, then su-exec nextjs.
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]