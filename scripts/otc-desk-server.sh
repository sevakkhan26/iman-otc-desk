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

# Build once if there is no production build yet.
if [ ! -f ".next/BUILD_ID" ]; then
  echo "[$(date)] no production build found — building..." >> "$LOG"
  "$NODE" node_modules/next/dist/bin/next build >> "$LOG" 2>&1
fi

exec "$NODE" node_modules/next/dist/bin/next start -H "$HOST" -p "$PORT"
