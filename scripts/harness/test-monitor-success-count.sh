#!/usr/bin/env bash
# Regression: grep -c exit 1 on zero matches must not produce "0\n0".
set -euo pipefail
TMP=$(mktemp -d)
LOG="$TMP/worker.log"
: >"$LOG"
count_success_cycles() {
  if [[ -f "$LOG" ]]; then
    grep -cE 'cycle [0-9]+ success' "$LOG" 2>/dev/null || true
  else
    echo 0
  fi
}
c=$(count_success_cycles | tr -d '[:space:]')
python3 -c "import sys; n=int(sys.argv[1]); assert n==0" "$c"
echo "cycle 1 success — sources 9 healthy" >>"$LOG"
c=$(count_success_cycles | tr -d '[:space:]')
python3 -c "import sys; n=int(sys.argv[1]); assert n==1" "$c"
# Prove the OLD buggy pattern fails
buggy=$(bash -c 'grep -cE "cycle [0-9]+ success" "'"$LOG"'.empty" 2>/dev/null || echo 0' || true)
: >"$LOG.empty"
buggy=$( (grep -cE 'cycle [0-9]+ success' "$LOG.empty" 2>/dev/null || echo 0) | od -An -tx1 )
# old pattern produces two lines:
old=$( (grep -cE 'cycle [0-9]+ success' "$LOG.empty" 2>/dev/null || echo 0) )
lines=$(printf '%s' "$old" | wc -l)
# when file empty of matches, old pattern has 2 lines
old_lines=$( (grep -cE 'cycle [0-9]+ success' "$LOG.empty" 2>/dev/null || echo 0; true) | wc -l )
# Better explicit check:
printf '' >"$LOG.empty"
old_out=$(grep -cE 'cycle [0-9]+ success' "$LOG.empty" 2>/dev/null || echo 0)
old_nlines=$(printf '%s\n' "$old_out" | wc -l)
new_out=$(grep -cE 'cycle [0-9]+ success' "$LOG.empty" 2>/dev/null || true)
new_nlines=$(printf '%s\n' "$new_out" | wc -l)
python3 - <<PY
old_nlines=int("$old_nlines")
new_nlines=int("$new_nlines")
assert old_nlines==2, old_nlines  # buggy pattern
assert new_nlines==1, new_nlines
print("PASS test-monitor-success-count")
PY
rm -rf "$TMP"
