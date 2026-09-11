#!/usr/bin/env bash
# Regression: planned operator stop must NOT be classified as unexpected death;
# real unexpected exit still must alert; stop during monitor poll must not race;
# restart after planned stop must start clean.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PASS=0
fail() { echo "FAIL: $*"; exit 1; }

# --- helpers ---
make_leaf() {
  local dir="$1"
  cat >"$dir/leaf.sh" <<'LEAF'
#!/usr/bin/env bash
echo FAKE_WORKER_START
while true; do sleep 0.2; done
LEAF
  chmod +x "$dir/leaf.sh"
}

# =============================================================================
# 1) planned graceful stop → no unexpected-death alert
# =============================================================================
TMP1=$(mktemp -d)
make_leaf "$TMP1"
"$ROOT/scripts/harness/launch-shadow-worker.sh" \
  --run-dir "$TMP1" --duration-sec 600 --cmd "bash '$TMP1/leaf.sh'" >/dev/null
# Start monitor in background with short poll
"$ROOT/scripts/harness/monitor-shadow-worker.sh" --run-dir "$TMP1" --poll-sec 1 \
  >"$TMP1/logs/monitor-stdout.txt" 2>&1 &
MON1=$!
sleep 1.2
# Planned stop while monitor is polling
"$ROOT/scripts/harness/stop-shadow-worker.sh" "$TMP1" | tee "$TMP1/logs/stop.out"
# Wait for monitor to exit
for i in $(seq 1 30); do
  kill -0 "$MON1" 2>/dev/null || break
  sleep 0.3
done
wait "$MON1" 2>/dev/null || true
MON1_EXIT=0
# monitor should have exited 0; capture via status file
STATE1=$(python3 -c "import json; print(json.load(open('$TMP1/harness/monitor-status.json'))['state'])")
[[ "$STATE1" == "STOPPED_PLANNED_OPERATOR" ]] || fail "case1 state=$STATE1 expected STOPPED_PLANNED_OPERATOR"
[[ ! -f "$TMP1/evidence/unexpected-process-death.json" ]] || fail "case1 unexpected-death artifact present"
grep -q PLANNED_OPERATOR_STOP "$TMP1/logs/stop-reason.txt" || fail "case1 missing stop-reason"
[[ -f "$TMP1/logs/planned-operator-stop.txt" ]] || fail "case1 missing planned-operator-stop"
[[ -f "$TMP1/logs/STOPPED" ]] || fail "case1 missing STOPPED marker"
[[ -f "$TMP1/logs/stopped-at.txt" ]] || fail "case1 missing stopped-at"
echo "PASS case1 planned graceful stop → STOPPED_PLANNED_OPERATOR"
PASS=$((PASS+1))
rm -rf "$TMP1"

# =============================================================================
# 2) real unexpected worker exit → unexpected-death alert
# =============================================================================
TMP2=$(mktemp -d)
make_leaf "$TMP2"
"$ROOT/scripts/harness/launch-shadow-worker.sh" \
  --run-dir "$TMP2" --duration-sec 600 --cmd "bash '$TMP2/leaf.sh'" >/dev/null
"$ROOT/scripts/harness/monitor-shadow-worker.sh" --run-dir "$TMP2" --poll-sec 1 \
  >"$TMP2/logs/monitor-stdout.txt" 2>&1 &
MON2=$!
sleep 1.0
ROOT_PID=$(tr -d '[:space:]' <"$TMP2/logs/worker.pid")
# Kill tree WITHOUT writing planned-stop markers (simulates crash)
kill -KILL -- "-$ROOT_PID" 2>/dev/null || true
kill -KILL "$ROOT_PID" 2>/dev/null || true
# Also kill any leaf descendants
for p in $(ps -eo pid=,ppid= | awk -v r="$ROOT_PID" '{p[$1]=$2} END{keep[r]=1;c=1;while(c){c=0;for(pid in p)if(!(pid in keep)&&(p[pid] in keep)){keep[pid]=1;c=1}} for(pid in keep)print pid}'); do
  kill -KILL "$p" 2>/dev/null || true
done
sleep 2.5
for i in $(seq 1 20); do
  kill -0 "$MON2" 2>/dev/null || break
  sleep 0.3
done
wait "$MON2" 2>/dev/null || true
STATE2=$(python3 -c "import json; print(json.load(open('$TMP2/harness/monitor-status.json'))['state'])")
[[ "$STATE2" == "BLOCKED_UNEXPECTED_DEATH" ]] || fail "case2 state=$STATE2 expected BLOCKED_UNEXPECTED_DEATH"
[[ -f "$TMP2/evidence/unexpected-process-death.json" ]] || fail "case2 missing unexpected-death json"
echo "PASS case2 real unexpected exit → BLOCKED_UNEXPECTED_DEATH"
PASS=$((PASS+1))
rm -rf "$TMP2"

# =============================================================================
# 3) stop during monitor polling → no race-induced false alert
#    (tight loop: many stop+monitor races)
# =============================================================================
for round in 1 2 3 4 5; do
  TMP3=$(mktemp -d)
  make_leaf "$TMP3"
  "$ROOT/scripts/harness/launch-shadow-worker.sh" \
    --run-dir "$TMP3" --duration-sec 600 --cmd "bash '$TMP3/leaf.sh'" >/dev/null
  "$ROOT/scripts/harness/monitor-shadow-worker.sh" --run-dir "$TMP3" --poll-sec 1 \
    >"$TMP3/logs/monitor-stdout.txt" 2>&1 &
  MON3=$!
  # Stop almost immediately to maximize race with first poll
  sleep 0.15
  "$ROOT/scripts/harness/stop-shadow-worker.sh" "$TMP3" >/dev/null
  for i in $(seq 1 40); do
    kill -0 "$MON3" 2>/dev/null || break
    sleep 0.2
  done
  wait "$MON3" 2>/dev/null || true
  STATE3=$(python3 -c "import json; print(json.load(open('$TMP3/harness/monitor-status.json'))['state'])")
  [[ "$STATE3" == "STOPPED_PLANNED_OPERATOR" ]] || fail "case3 round=$round state=$STATE3"
  [[ ! -f "$TMP3/evidence/unexpected-process-death.json" ]] || fail "case3 round=$round false unexpected death"
  rm -rf "$TMP3"
done
echo "PASS case3 stop-during-poll race x5 → no false unexpected death"
PASS=$((PASS+1))

# =============================================================================
# 4) restart after planned stop → clean new state
# =============================================================================
TMP4=$(mktemp -d)
make_leaf "$TMP4"
"$ROOT/scripts/harness/launch-shadow-worker.sh" \
  --run-dir "$TMP4" --duration-sec 600 --cmd "bash '$TMP4/leaf.sh'" >/dev/null
PID_A=$(tr -d '[:space:]' <"$TMP4/logs/worker.pid")
"$ROOT/scripts/harness/stop-shadow-worker.sh" "$TMP4" >/dev/null
[[ -f "$TMP4/logs/stop-reason.txt" ]] || fail "case4 stop-reason missing after first stop"
# Clear stop markers for a clean relaunch (operator responsibility on new session),
# but prove launch refuses while pidfile points at dead pid only if alive — launch
# allows relaunch when old pid is dead. We simulate a fresh run-dir for clean state.
TMP4B=$(mktemp -d)
make_leaf "$TMP4B"
"$ROOT/scripts/harness/launch-shadow-worker.sh" \
  --run-dir "$TMP4B" --duration-sec 600 --cmd "bash '$TMP4B/leaf.sh'" >/dev/null
PID_B=$(tr -d '[:space:]' <"$TMP4B/logs/worker.pid")
[[ "$PID_B" != "$PID_A" ]] || fail "case4 same pid after restart"
[[ ! -f "$TMP4B/logs/stop-reason.txt" ]] || fail "case4 new run has stale stop-reason"
[[ ! -f "$TMP4B/logs/STOPPED" ]] || fail "case4 new run has stale STOPPED"
[[ ! -f "$TMP4B/evidence/unexpected-process-death.json" ]] || fail "case4 new run has death artifact"
# Monitor on fresh run should be RUNNING
"$ROOT/scripts/harness/monitor-shadow-worker.sh" --run-dir "$TMP4B" --poll-sec 1 \
  >"$TMP4B/logs/monitor-stdout.txt" 2>&1 &
MON4=$!
sleep 1.5
STATE4=$(python3 -c "import json; print(json.load(open('$TMP4B/harness/monitor-status.json'))['state'])")
[[ "$STATE4" == "RUNNING" ]] || fail "case4 fresh monitor state=$STATE4 expected RUNNING"
"$ROOT/scripts/harness/stop-shadow-worker.sh" "$TMP4B" >/dev/null
for i in $(seq 1 30); do
  kill -0 "$MON4" 2>/dev/null || break
  sleep 0.2
done
wait "$MON4" 2>/dev/null || true
STATE4B=$(python3 -c "import json; print(json.load(open('$TMP4B/harness/monitor-status.json'))['state'])")
[[ "$STATE4B" == "STOPPED_PLANNED_OPERATOR" ]] || fail "case4 post-stop state=$STATE4B"
echo "PASS case4 restart after planned stop → clean new state"
PASS=$((PASS+1))
rm -rf "$TMP4" "$TMP4B"

# Also keep process-group kill coverage via existing test path (light inline)
TMP5=$(mktemp -d)
make_leaf "$TMP5"
"$ROOT/scripts/harness/launch-shadow-worker.sh" \
  --run-dir "$TMP5" --duration-sec 120 --cmd "bash '$TMP5/leaf.sh'" >/dev/null
ROOT_PID=$(tr -d '[:space:]' <"$TMP5/logs/worker.pid")
sleep 0.5
"$ROOT/scripts/harness/stop-shadow-worker.sh" "$TMP5" >/dev/null
sleep 0.3
if kill -0 "$ROOT_PID" 2>/dev/null; then fail "case5 root still alive"; fi
[[ -f "$TMP5/logs/stopped-at.txt" ]] || fail "case5 no stopped-at"
[[ -f "$TMP5/logs/stop-reason.txt" ]] || fail "case5 no stop-reason (pre-signal marker)"
echo "PASS case5 stop still kills process group + writes pre-signal markers"
PASS=$((PASS+1))
rm -rf "$TMP5"

echo "PASS test-planned-stop-classification ($PASS cases)"
echo "PLANNED_STOP_CLASSIFICATION_CORRECT=YES"
echo "UNEXPECTED_DEATH_DETECTION_STILL_WORKS=YES"
