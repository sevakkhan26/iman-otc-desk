#!/usr/bin/env bash
# Independent monitor for a harness-launched worker.
# On unexpected death after any completed cycle: HARD FAIL, freeze evidence,
# write BLOCKED report — ZERO auto-relaunch.
set -euo pipefail

usage() {
  echo "Usage: $0 --run-dir DIR [--poll-sec N] [--success-pattern REGEX]" >&2
  exit 2
}

RUN_DIR=""
POLL_SEC=5
SUCCESS_PATTERN='cycle [0-9]+ success'

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-dir) RUN_DIR="$2"; shift 2 ;;
    --poll-sec) POLL_SEC="$2"; shift 2 ;;
    --success-pattern) SUCCESS_PATTERN="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[[ -n "$RUN_DIR" ]] || usage

PIDFILE="$RUN_DIR/logs/worker.pid"
PLANNEDFILE="$RUN_DIR/logs/planned-end.txt"
LOG="$RUN_DIR/logs/worker.log"
MONLOG="$RUN_DIR/logs/monitor.log"
EVIDENCE="$RUN_DIR/evidence"
STATUS_JSON="$RUN_DIR/harness/monitor-status.json"
BLOCKED_JSON="$RUN_DIR/evidence/unexpected-process-death.json"

mkdir -p "$EVIDENCE" "$RUN_DIR/harness" "$RUN_DIR/logs"
echo "monitor_start $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$MONLOG"

if [[ ! -f "$PIDFILE" || ! -f "$PLANNEDFILE" ]]; then
  echo "FAIL: missing pidfile or planned-end (launch must write both)" | tee -a "$MONLOG"
  exit 1
fi

PID=$(cat "$PIDFILE")
PLANNED_END=$(cat "$PLANNEDFILE")
PLANNED_EPOCH=$(date -u -d "$PLANNED_END" +%s 2>/dev/null \
  || python3 -c "import datetime; print(int(datetime.datetime.strptime('$PLANNED_END','%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc).timestamp()))")

count_success_cycles() {
  if [[ -f "$LOG" ]]; then
    grep -cE "$SUCCESS_PATTERN" "$LOG" 2>/dev/null || echo 0
  else
    echo 0
  fi
}

write_status() {
  local state="$1" detail="$2"
  python3 - <<PY
import json, time
open("$STATUS_JSON","w").write(json.dumps({
  "atUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
  "state": "$state",
  "detail": """$detail""",
  "pid": int("$PID") if "$PID".isdigit() else None,
  "plannedEndUtc": "$PLANNED_END",
  "successCycles": int("""$(count_success_cycles)""".strip() or 0),
  "autoRelaunch": False,
}, indent=2)+"\n")
PY
}

hard_fail_death() {
  local reason="$1"
  local cycles
  cycles=$(count_success_cycles | tr -d '[:space:]')
  local at
  at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # Freeze evidence: copy last log lines + status
  tail -n 200 "$LOG" > "$EVIDENCE/worker-log-tail.txt" 2>/dev/null || true
  cp -f "$PIDFILE" "$EVIDENCE/worker.pid.frozen" 2>/dev/null || true
  cp -f "$PLANNEDFILE" "$EVIDENCE/planned-end.frozen" 2>/dev/null || true
  python3 - <<PY
import json
doc={
  "atUtc": "$at",
  "event": "UNEXPECTED_PROCESS_DEATH",
  "verdict": "BLOCKED_FOR_SUPERVISOR",
  "hardGate": "unexpected_process_death",
  "reason": """$reason""",
  "priorPid": int("$PID") if "$PID".isdigit() else None,
  "cyclesCompletedBeforeDeath": int("$cycles" or 0),
  "plannedEndUtc": "$PLANNED_END",
  "autoRelaunch": False,
  "action": "STOP_PRESERVE_REPORT",
  "note": "Harness MUST NOT relaunch. Preserve evidence and report BLOCKED."
}
open("$BLOCKED_JSON","w").write(json.dumps(doc, indent=2)+"\n")
print(json.dumps(doc, indent=2))
PY
  write_status "BLOCKED_UNEXPECTED_DEATH" "$reason"
  echo "HARD_FAIL unexpected_process_death cycles=$cycles — NO RELAUNCH" | tee -a "$MONLOG"
  exit 10
}

graceful_done() {
  write_status "COMPLETED_PLANNED_END" "plannedEnd reached; worker still alive or stopped by stop script"
  echo "monitor_end $(date -u +%Y-%m-%dT%H:%M:%SZ) PLANNED_END_REACHED" | tee -a "$MONLOG"
  exit 0
}

while true; do
  now=$(date -u +%s)
  remain=$(( PLANNED_EPOCH - now ))
  cycles=$(count_success_cycles | tr -d '[:space:]')
  if ! kill -0 "$PID" 2>/dev/null; then
    # Process gone. If we already passed planned end, treat as post-stop.
    if (( remain <= 0 )); then
      write_status "STOPPED_AFTER_PLANNED_END" "process gone after plannedEnd"
      echo "monitor_end process_gone_after_planned_end" | tee -a "$MONLOG"
      exit 0
    fi
    hard_fail_death "worker pid=$PID not running before plannedEnd=$PLANNED_END (successCycles=$cycles)"
  fi
  last=$(tail -n 1 "$LOG" 2>/dev/null | tr -d '\r' | head -c 240 || true)
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ok remain_s=$remain success_cycles=$cycles last=[$last]" | tee -a "$MONLOG"
  write_status "RUNNING" "remain_s=$remain"
  if (( remain <= 0 )); then
    graceful_done
  fi
  sleep "$POLL_SEC"
done
