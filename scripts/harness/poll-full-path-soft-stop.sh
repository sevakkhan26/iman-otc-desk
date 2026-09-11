#!/usr/bin/env bash
# Poll validation DB for full-path lifecycle; soft-stop when criteria met.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_DIR="${1:?run-dir}"
DB_DIR="${2:?db-dir}"
ART_DIR="${3:?art-dir}"
INTERVAL_SEC="${4:-60}"
MAX_WAIT_SEC="${5:-21600}"
mkdir -p "$ART_DIR/audit" "$ART_DIR/logs" "$RUN_DIR/logs"
START=$(date -u +%s)
echo "poll_start $(date -u +%Y-%m-%dT%H:%M:%SZ) interval=$INTERVAL_SEC max=$MAX_WAIT_SEC" | tee -a "$ART_DIR/logs/full-path-poll.log"
while true; do
  now=$(date -u +%s)
  elapsed=$((now - START))
  if (( elapsed >= MAX_WAIT_SEC )); then
    echo "poll_timeout elapsed=${elapsed}s" | tee -a "$ART_DIR/logs/full-path-poll.log"
    echo "MARKET_QUIET_OR_TIMEOUT=YES" | tee -a "$ART_DIR/logs/full-path-poll.log"
    exit 2
  fi
  set +e
  OUT=$(cd "$ROOT" && DATABASE_URL="pglite:$DB_DIR" SHADOW_ALLOW_SHARED_PGLITE=1 VAL_ART_DIR="$ART_DIR" \
    npx --yes tsx scripts/scan-real-market-full-path.mts 2>"$ART_DIR/logs/full-path-scan.err")
  RC=$?
  set -e
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) scan_rc=$RC elapsed=${elapsed}s" | tee -a "$ART_DIR/logs/full-path-poll.log"
  echo "$OUT" | tee -a "$ART_DIR/logs/full-path-poll.log" | tail -n 30
  FP=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d.get('REAL_MARKET_FULL_PATH_VALIDATED','NO'), d.get('REAL_MARKET_RESIDUAL_LOGIC_EXERCISED','NO'), d.get('fullPathCount',0), d.get('netPassedCount',0))" "$OUT" 2>/dev/null || echo "NO NO 0 0")
  read -r FP_OK RES_OK FPC NPC <<<"$FP"
  if [[ "$FP_OK" == "YES" && "$RES_OK" == "YES" ]]; then
    echo "CRITERIA_MET soft-stop" | tee -a "$ART_DIR/logs/full-path-poll.log"
    "$ROOT/scripts/harness/stop-shadow-worker.sh" "$RUN_DIR" | tee -a "$ART_DIR/logs/soft-stop.out"
    echo "SOFT_STOPPED" | tee -a "$ART_DIR/logs/full-path-poll.log"
    exit 0
  fi
  sleep "$INTERVAL_SEC"
done
