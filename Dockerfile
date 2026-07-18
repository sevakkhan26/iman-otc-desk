# syntax=docker/dockerfile:1
# Production image for iman-otc-desk (Next.js standalone).
# Price Alerts persist on a Docker named volume at /app/data/price-alerts.

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app

# --- dependencies ---
FROM base AS deps
RUN apk add --no-cache libc6-compat
# Prefer pnpm when lockfile present
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
RUN corepack enable && corepack prepare pnpm@latest --activate \
  && pnpm install --frozen-lockfile

# --- build ---
FROM base AS builder
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN pnpm build

# --- runner ---
FROM node:22-alpine AS runner
WORKDIR /app

# su-exec: drop root after volume chown (tiny, no gosu needed)
RUN apk add --no-cache su-exec \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Explicit Price Alerts file backend for Docker production.
# Override only if you intentionally switch to Upstash.
ENV PRICE_ALERTS_STORAGE=file
ENV PRICE_ALERTS_DATA_DIR=/app/data/price-alerts
ENV PRICE_ALERTS_DATA_FILE=/app/data/price-alerts/price-alerts.json

# Placeholder data dir (real volume mounts over this at runtime)
RUN mkdir -p /app/data/price-alerts \
  && chown -R nextjs:nodejs /app/data

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Do NOT set USER nextjs here — entrypoint must start as root to chown the volume,
# then exec su-exec nextjs for the Node process.
EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
