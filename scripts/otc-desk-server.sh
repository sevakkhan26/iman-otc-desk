#!/bin/bash
# Production server for the OTC Desk dashboard.
# Run in the foreground; launchd (KeepAlive) restarts it if it ever exits.
set -u

PROJECT="/Users/imanhosseini/dealing-desk-otc-dashboard"
LOG="/tmp/otc-desk.log"
PORT=3000
HOST=127.0.0.1

# Locate a usable Node runtime (prefer the stable user install, fall back to others).
find_node() {
  local candidates=(
    "/Users/imanhosseini/.local/node/bin/node"
    "/Users/imanhosseini/Library/pnpm/node"
    "$(command -v node 2>/dev/null)"
    "/opt/homebrew/bin/node"
    "/usr/local/bin/node"
    "/Users/imanhosseini/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
  )
  local c
  for c in "${candidates[@]}"; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

NODE="$(find_node)" || { echo "[$(date)] ERROR: node runtime not found" >> "$LOG"; exit 1; }
export PATH="$(dirname "$NODE"):$PATH"

cd "$PROJECT" || { echo "[$(date)] ERROR: project dir missing" >> "$LOG"; exit 1; }

echo "[$(date)] starting OTC Desk with $NODE ($("$NODE" -v))" >> "$LOG"

# Rebuild when missing, or when source is newer than the last production build.
# Prevents launchd "server" mode from serving a stale .next (e.g. old Arzinja endpoint).
NEED_BUILD=0
if [ ! -f ".next/BUILD_ID" ]; then
  NEED_BUILD=1
  echo "[$(date)] no production build found — building..." >> "$LOG"
else
  # If any app/src file is newer than BUILD_ID, rebuild.
  NEWER="$(find app src package.json next.config.ts -type f -newer .next/BUILD_ID 2>/dev/null | head -1 || true)"
  if [ -n "$NEWER" ]; then
    NEED_BUILD=1
    echo "[$(date)] source newer than .next/BUILD_ID ($NEWER) — rebuilding..." >> "$LOG"
  fi
fi
if [ "$NEED_BUILD" = "1" ]; then
  "$NODE" node_modules/next/dist/bin/next build >> "$LOG" 2>&1 || {
    echo "[$(date)] ERROR: next build failed" >> "$LOG"
    exit 1
  }
fi

exec "$NODE" node_modules/next/dist/bin/next start -H "$HOST" -p "$PORT"
