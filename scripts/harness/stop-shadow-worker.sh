#!/usr/bin/env bash
# Graceful stop at planned end (SIGTERM then SIGKILL). Does not relaunch.
set -euo pipefail
RUN_DIR="${1:-}"
[[ -n "$RUN_DIR" ]] || { echo "Usage: $0 RUN_DIR" >&2; exit 2; }
PIDFILE="$RUN_DIR/logs/worker.pid"
[[ -f "$PIDFILE" ]] || { echo "no pidfile"; exit 0; }
PID=$(cat "$PIDFILE")
if kill -0 "$PID" 2>/dev/null; then
  kill -TERM "$PID" 2>/dev/null || true
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$PID" 2>/dev/null; then
    kill -KILL "$PID" 2>/dev/null || true
  fi
fi
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$RUN_DIR/logs/stopped-at.txt"
echo "STOPPED"
