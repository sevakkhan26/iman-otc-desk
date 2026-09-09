#!/usr/bin/env bash
# Graceful stop at planned end (SIGTERM then SIGKILL). Does not relaunch.
#
# launch-shadow-worker.sh records the setsid session-leader bash PID in
# worker.pid. Signaling only that PID can leave the leaf `tsx`/`node`
# shadow-worker alive (orphan), which keeps the PGlite lock and — if later
# hard-killed — corrupts the durable DB (invalid checkpoint / Aborted()).
# Always terminate the whole process group first, then sweep any leftover
# descendants that still match this run's worker.log / pidfile tree.
set -euo pipefail
RUN_DIR="${1:-}"
[[ -n "$RUN_DIR" ]] || { echo "Usage: $0 RUN_DIR" >&2; exit 2; }
PIDFILE="$RUN_DIR/logs/worker.pid"
LOG="$RUN_DIR/logs/worker.log"
[[ -f "$PIDFILE" ]] || { echo "no pidfile"; exit 0; }
PID=$(tr -d '[:space:]' <"$PIDFILE")
[[ -n "$PID" && "$PID" =~ ^[0-9]+$ ]] || { echo "bad pidfile"; exit 0; }

list_tree() {
  local root="$1"
  # Prefer process-group members when root is still the session leader.
  local pg
  pg=$(ps -o pgid= -p "$root" 2>/dev/null | tr -d '[:space:]' || true)
  if [[ -n "$pg" && "$pg" =~ ^[0-9]+$ ]]; then
    ps -eo pid=,pgid= 2>/dev/null | awk -v g="$pg" '$2==g {print $1}'
  fi
  # Descendants via pstree /ps --forest fallback
  ps -eo pid=,ppid= 2>/dev/null | awk -v r="$root" '
    { p[$1]=$2 }
    END {
      changed=1
      keep[r]=1
      while (changed) {
        changed=0
        for (pid in p) {
          if (!(pid in keep) && (p[pid] in keep)) { keep[pid]=1; changed=1 }
        }
      }
      for (pid in keep) print pid
    }'
}

signal_tree() {
  local sig="$1"
  local root="$2"
  local pids
  pids=$(list_tree "$root" | sort -u | tr '\n' ' ')
  # Process-group signal (negative PGID) reaches every member, including leaf.
  kill -s "$sig" -- "-$root" 2>/dev/null || true
  if [[ -n "${pids// /}" ]]; then
    # shellcheck disable=SC2086
    kill -s "$sig" $pids 2>/dev/null || true
  fi
}

tree_alive() {
  local root="$1"
  local p
  for p in $(list_tree "$root" | sort -u); do
    if kill -0 "$p" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

if kill -0 "$PID" 2>/dev/null || tree_alive "$PID"; then
  signal_tree TERM "$PID"
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    tree_alive "$PID" || break
    sleep 0.5
  done
  if tree_alive "$PID"; then
    signal_tree KILL "$PID"
    sleep 0.2
  fi
fi

# Final sweep: any process still holding this run's worker.log open
if [[ -f "$LOG" ]] && command -v lsof >/dev/null 2>&1; then
  leftover=$(lsof -nP -t "$LOG" 2>/dev/null || true)
  if [[ -n "${leftover:-}" ]]; then
    # shellcheck disable=SC2086
    kill -TERM $leftover 2>/dev/null || true
    sleep 1
    # shellcheck disable=SC2086
    kill -KILL $leftover 2>/dev/null || true
  fi
fi

date -u +"%Y-%m-%dT%H:%M:%SZ" > "$RUN_DIR/logs/stopped-at.txt"
if tree_alive "$PID" 2>/dev/null; then
  echo "STOP_INCOMPLETE tree_still_alive root=$PID" >&2
  exit 1
fi
echo "STOPPED"
