#!/usr/bin/env bash
# Build Next.js on the host, then create a thin runtime image (no pnpm in Docker).
# Resistant to Docker Hub rate limits and slow in-container installs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

NODE_IMAGE="${NODE_IMAGE:-public.ecr.aws/docker/library/node:20-alpine}"
IMAGE_TAG="${IMAGE_TAG:-iman-otc-desk:latest}"
EXPORT_DIR="${ROOT}/.docker-export"

log() { echo "[docker-prebuilt] $*"; }
fail() { echo "[docker-prebuilt] ERROR: $*" >&2; exit 1; }

command -v node >/dev/null || fail "node not found on host"
command -v docker >/dev/null || fail "docker not found"

# Prefer pnpm if lockfile exists
if command -v pnpm >/dev/null 2>&1; then
  PKG=pnpm
elif command -v npm >/dev/null 2>&1; then
  PKG=npm
else
  fail "need pnpm or npm on host"
fi

log "host install + build (${PKG})"
if [ "${PKG}" = "pnpm" ]; then
  pnpm install --frozen-lockfile
  pnpm build
else
  npm ci
  npm run build
fi

[ -f "${ROOT}/.next/standalone/server.js" ] || fail "missing .next/standalone/server.js (is next.config output:standalone?)"

log "staging ${EXPORT_DIR}"
rm -rf "${EXPORT_DIR}"
mkdir -p "${EXPORT_DIR}/.next/static" "${EXPORT_DIR}/public"
# standalone includes server.js + traced node_modules
cp -a "${ROOT}/.next/standalone/." "${EXPORT_DIR}/"
cp -a "${ROOT}/.next/static/." "${EXPORT_DIR}/.next/static/"
if [ -d "${ROOT}/public" ]; then
  cp -a "${ROOT}/public/." "${EXPORT_DIR}/public/"
fi
cp -a "${ROOT}/docker-entrypoint.sh" "${EXPORT_DIR}/docker-entrypoint.sh"
chmod +x "${EXPORT_DIR}/docker-entrypoint.sh"

log "docker build (NODE_IMAGE=${NODE_IMAGE})"
docker build \
  -f "${ROOT}/Dockerfile.prebuilt" \
  --build-arg "NODE_IMAGE=${NODE_IMAGE}" \
  -t "${IMAGE_TAG}" \
  "${EXPORT_DIR}"

log "done → ${IMAGE_TAG}"
log "run with compose (image already tagged) or: docker run --rm -p 3000:3000 ${IMAGE_TAG}"
