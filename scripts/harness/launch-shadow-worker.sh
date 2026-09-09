#!/usr/bin/env bash
# Durable setsid launch for shadow-worker / paper acceptance sessions.
# Requirements (supervisor correction addendum):
#   - first launch is setsid-detached from t=0
#   - pidfile written atomically after spawn
#   - ONE authoritative plannedEnd written at durable start
#   - NEVER relaunches; death handling belongs to the monitor
set -euo pipefail

usage() {
  cat <<USAGE
Usage: $0 --run-dir DIR --cmd 'command...' [--duration-sec N] [--planned-end ISO8601]
Env:
  HARNESS_RUN_DIR   same as --run-dir
  HARNESS_CMD       same as --cmd
  HARNESS_DURATION_SEC  duration from durable start (default 120)
USAGE
  exit 2
}

RUN_DIR="${HARNESS_RUN_DIR:-}"
CMD="${HARNESS_CMD:-}"
DURATION_SEC="${HARNESS_DURATION_SEC:-120}"
PLANNED_END_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-dir) RUN_DIR="$2"; shift 2 ;;
    --cmd) CMD="$2"; shift 2 ;;
    --duration-sec) DURATION_SEC="$2"; shift 2 ;;
    --planned-end) PLANNED_END_ARG="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

[[ -n "$RUN_DIR" && -n "$CMD" ]] || usage
mkdir -p "$RUN_DIR/logs" "$RUN_DIR/evidence" "$RUN_DIR/harness"

PIDFILE="$RUN_DIR/logs/worker.pid"
STARTFILE="$RUN_DIR/logs/actual-worker-start.txt"
PLANNEDFILE="$RUN_DIR/logs/planned-end.txt"
META="$RUN_DIR/harness/launch-meta.json"
LOG="$RUN_DIR/logs/worker.log"

if [[ -f "$PIDFILE" ]]; then
  old=$(cat "$PIDFILE" 2>/dev/null || true)
  if [[ -n "${old:-}" ]] && kill -0 "$old" 2>/dev/null; then
    echo "REFUSE: worker already running pid=$old (pidfile=$PIDFILE)" >&2
    exit 1
  fi
fi

# Remove stale end-target files that historically conflicted with plannedEnd.
rm -f "$RUN_DIR/logs/actual-worker-end-target.txt" \
      "$RUN_DIR/logs/run-until.txt" 2>/dev/null || true

# setsid from t=0 — independent of Shell-tool session retention
setsid bash -c "$CMD" >>"$LOG" 2>&1 < /dev/null &
WPID=$!
# Give the child a moment; if it is a wrapper, prefer the leaf later via monitor.
sleep 0.2
if ! kill -0 "$WPID" 2>/dev/null; then
  echo "FAIL: process exited immediately after setsid launch" >&2
  exit 1
fi

START_UTC=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
if [[ -n "$PLANNED_END_ARG" ]]; then
  PLANNED_END="$PLANNED_END_ARG"
else
  PLANNED_END=$(date -u -d "@$(( $(date -u +%s) + DURATION_SEC ))" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
    || python3 -c "import datetime; print((datetime.datetime.utcnow()+datetime.timedelta(seconds=int('$DURATION_SEC'))).strftime('%Y-%m-%dT%H:%M:%SZ'))")
fi

printf '%s\n' "$WPID" >"$PIDFILE"
printf '%s\n' "$START_UTC" >"$STARTFILE"
printf '%s\n' "$PLANNED_END" >"$PLANNEDFILE"
# Single authoritative planned end only — no conflicting end-target copies.
python3 - <<PY
import json, os
meta={
  "launchedAtUtc": "$START_UTC",
  "plannedEndUtc": "$PLANNED_END",
  "durationSec": int("$DURATION_SEC"),
  "workerPid": int("$WPID"),
  "pidfile": "$PIDFILE",
  "log": "$LOG",
  "cmd": """$CMD""",
  "setsid": True,
  "autoRelaunch": False,
  "authoritativePlannedEndFile": "$PLANNEDFILE",
}
open("$META","w").write(json.dumps(meta, indent=2)+"\n")
print(json.dumps(meta))
PY
echo "LAUNCH_OK pid=$WPID start=$START_UTC plannedEnd=$PLANNED_END"
