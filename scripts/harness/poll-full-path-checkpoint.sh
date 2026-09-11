#!/usr/bin/env bash
# Checkpoint soft-stop: stop worker to flush PGlite, scan durable DB, resume if needed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_DIR="${1:?run-dir}"
DB_DIR="${2:?db-dir}"
ART_DIR="${3:?art-dir}"
BURST_SEC="${4:-900}"
MAX_WAIT_SEC="${5:-21600}"
POLL_MS="${SHADOW_POLL_MS:-15000}"
mkdir -p "$ART_DIR/audit" "$ART_DIR/logs" "$RUN_DIR/logs"
START=$(date -u +%s)
LOG="$ART_DIR/logs/full-path-checkpoint.log"
echo "checkpoint_poll_start $(date -u +%Y-%m-%dT%H:%M:%SZ) burst=$BURST_SEC max=$MAX_WAIT_SEC" | tee -a "$LOG"

launch_worker() {
  local remain="$1"
  local CMD="cd $ROOT && DATABASE_URL=pglite:$DB_DIR LIVE=false SHADOW_PAPER_ENSURE=1 SHADOW_DECISION_TRACE=true SHADOW_RELEASE_BOOTSTRAP=false SHADOW_POLL_MS=$POLL_MS SHADOW_ALLOW_SHARED_PGLITE=1 npx --yes tsx scripts/shadow-worker.mts"
  rm -f "$RUN_DIR/logs/stop-reason.txt" "$RUN_DIR/logs/planned-operator-stop.txt" \
        "$RUN_DIR/logs/STOPPED" "$RUN_DIR/logs/stopped-at.txt" \
        "$RUN_DIR/evidence/unexpected-process-death.json" 2>/dev/null || true
  "$ROOT/scripts/harness/launch-shadow-worker.sh" \
    --run-dir "$RUN_DIR" \
    --duration-sec "$remain" \
    --cmd "$CMD" | tee -a "$RUN_DIR/harness/launch.out"
  local mp=""
  if [[ -f "$RUN_DIR/logs/monitor.pid" ]]; then
    mp=$(tr -d '[:space:]' <"$RUN_DIR/logs/monitor.pid" || true)
  fi
  if [[ -z "$mp" ]] || ! kill -0 "$mp" 2>/dev/null; then
    setsid bash -c "$ROOT/scripts/harness/monitor-shadow-worker.sh --run-dir '$RUN_DIR' --poll-sec 10 >>'$RUN_DIR/logs/monitor.log' 2>&1" </dev/null &
    echo $! > "$RUN_DIR/logs/monitor.pid"
  fi
}

scan_after_stop() {
  cd "$ROOT"
  DATABASE_URL="pglite:$DB_DIR" SHADOW_ALLOW_SHARED_PGLITE=1 VAL_ART_DIR="$ART_DIR" \
    npx --yes tsx scripts/scan-real-market-full-path.mts
}

while true; do
  now=$(date -u +%s)
  elapsed=$((now - START))
  remain_total=$((MAX_WAIT_SEC - elapsed))
  if (( remain_total <= 60 )); then
    echo "poll_timeout elapsed=${elapsed}s" | tee -a "$LOG"
    echo "MARKET_QUIET_OR_TIMEOUT=YES" | tee -a "$LOG"
    "$ROOT/scripts/harness/stop-shadow-worker.sh" "$RUN_DIR" >>"$ART_DIR/logs/final-stop.out" 2>&1 || true
    sleep 2
    scan_after_stop | tee "$ART_DIR/audit/final-scan.json" | tee -a "$LOG" || true
    exit 2
  fi
  burst=$BURST_SEC
  if (( burst > remain_total )); then burst=$remain_total; fi

  WPID=""
  if [[ -f "$RUN_DIR/logs/worker.pid" ]]; then
    WPID=$(tr -d '[:space:]' <"$RUN_DIR/logs/worker.pid" || true)
  fi
  if [[ -z "$WPID" ]] || ! kill -0 "$WPID" 2>/dev/null; then
    echo "relaunch remain=$remain_total" | tee -a "$LOG"
    launch_worker "$remain_total"
  fi

  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) sleeping_burst=${burst}s elapsed=$elapsed" | tee -a "$LOG"
  sleep "$burst"

  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) checkpoint_stop" | tee -a "$LOG"
  "$ROOT/scripts/harness/stop-shadow-worker.sh" "$RUN_DIR" | tee -a "$ART_DIR/logs/checkpoint-stop.out"
  sleep 2
  OUT=$(scan_after_stop 2>"$ART_DIR/logs/checkpoint-scan.err" || true)
  echo "$OUT" | tee "$ART_DIR/audit/checkpoint-scan-latest.json" | tee -a "$LOG"
  FP=$(python3 -c "import json,sys
try:
 d=json.loads(sys.argv[1]); print(d.get('REAL_MARKET_FULL_PATH_VALIDATED','NO'), d.get('REAL_MARKET_RESIDUAL_LOGIC_EXERCISED','NO'), d.get('fullPathCount',0), d.get('netPassedCount',0), d.get('traces',0))
except Exception:
 print('NO','NO',0,0,0)
" "$OUT")
  read -r FP_OK RES_OK FPC NPC TR <<<"$FP"
  echo "checkpoint_result FP=$FP_OK RES=$RES_OK full=$FPC net=$NPC traces=$TR" | tee -a "$LOG"
  if [[ "$FP_OK" == "YES" && "$RES_OK" == "YES" ]]; then
    echo "CRITERIA_MET" | tee -a "$LOG"
    exit 0
  fi
  now=$(date -u +%s)
  elapsed=$((now - START))
  remain_total=$((MAX_WAIT_SEC - elapsed))
  if (( remain_total <= 60 )); then
    echo "MARKET_QUIET_OR_TIMEOUT=YES after checkpoint" | tee -a "$LOG"
    exit 2
  fi
  launch_worker "$remain_total"
done
