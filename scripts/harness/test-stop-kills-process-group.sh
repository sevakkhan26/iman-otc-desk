#!/usr/bin/env bash
# Regression: stop must SIGTERM the leaf, not only the setsid bash wrapper.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d)
cleanup() {
  # Best-effort cleanup if test fails mid-way
  if [[ -f "$TMP/logs/worker.pid" ]]; then
    "$ROOT/scripts/harness/stop-shadow-worker.sh" "$TMP" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

# Write a tiny leaf script to avoid nested-quote issues in launch-meta JSON.
LEAF="$TMP/leaf.sh"
cat >"$LEAF" <<'LEAF'
#!/usr/bin/env bash
echo FAKE_WORKER_START
while true; do sleep 1; done
LEAF
chmod +x "$LEAF"

"$ROOT/scripts/harness/launch-shadow-worker.sh" \
  --run-dir "$TMP" \
  --duration-sec 120 \
  --cmd "bash '$LEAF'"

ROOT_PID=$(tr -d '[:space:]' <"$TMP/logs/worker.pid")
sleep 0.8
mapfile -t LEAVES < <(ps -eo pid=,ppid= | awk -v r="$ROOT_PID" '
  {p[$1]=$2}
  END {
    keep[r]=1; changed=1
    while (changed) {
      changed=0
      for (pid in p) if (!(pid in keep) && (p[pid] in keep)) { keep[pid]=1; changed=1 }
    }
    for (pid in keep) if (pid != r) print pid
  }')
echo "root=$ROOT_PID leaves=${LEAVES[*]:-}"
[[ ${#LEAVES[@]} -gt 0 ]] || { echo "FAIL: no leaf under setsid root"; exit 1; }
for p in "${LEAVES[@]}"; do
  kill -0 "$p" 2>/dev/null || { echo "FAIL: leaf $p not alive before stop"; exit 1; }
done

"$ROOT/scripts/harness/stop-shadow-worker.sh" "$TMP"

sleep 0.5
if kill -0 "$ROOT_PID" 2>/dev/null; then
  echo "FAIL: root $ROOT_PID still alive after stop"; exit 1
fi
for p in "${LEAVES[@]}"; do
  if kill -0 "$p" 2>/dev/null; then
    echo "FAIL: leaf $p still alive after stop"; exit 1
  fi
done
[[ -f "$TMP/logs/stopped-at.txt" ]] || { echo "FAIL: no stopped-at"; exit 1; }
[[ -f "$TMP/logs/stop-reason.txt" ]] || { echo "FAIL: no stop-reason"; exit 1; }
grep -q PLANNED_OPERATOR_STOP "$TMP/logs/stop-reason.txt" || { echo "FAIL: bad stop-reason"; exit 1; }
[[ -f "$TMP/logs/planned-operator-stop.txt" ]] || { echo "FAIL: no planned-operator-stop"; exit 1; }
[[ -f "$TMP/logs/STOPPED" ]] || { echo "FAIL: no STOPPED marker"; exit 1; }
echo "PASS test-stop-kills-process-group"
