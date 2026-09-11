#!/usr/bin/env bash
# Verify a corrected Local evidence pack: every MANIFEST.sha256 entry exists
# at the exact relative path under PACK_ROOT and hashes match.
set -euo pipefail
PACK="${1:-}"
[[ -n "$PACK" && -d "$PACK" ]] || { echo "Usage: $0 PACK_ROOT" >&2; exit 2; }
cd "$PACK"
[[ -f MANIFEST.sha256 ]] || { echo "FAIL: no MANIFEST.sha256"; exit 1; }
MISSING=0
while read -r _hash rel; do
  [[ -z "${rel:-}" ]] && continue
  if [[ ! -f "$rel" ]]; then
    echo "MISSING: $rel"
    MISSING=$((MISSING+1))
  fi
done < MANIFEST.sha256
set +e
sha256sum -c MANIFEST.sha256
EXIT=$?
set -e
# Count mismatches from verify output is harder; re-check:
MISMATCH=0
while read -r expect rel; do
  [[ -z "${rel:-}" || ! -f "$rel" ]] && continue
  actual=$(sha256sum "$rel" | awk '{print $1}')
  if [[ "$actual" != "$expect" ]]; then
    echo "HASH_MISMATCH: $rel"
    MISMATCH=$((MISMATCH+1))
  fi
done < MANIFEST.sha256
ENTRIES=$(grep -c . MANIFEST.sha256 || true)
echo "MANIFEST_VERIFY_EXIT_CODE=$EXIT"
echo "MANIFEST_MISSING_FILES=$MISSING"
echo "MANIFEST_HASH_MISMATCHES=$MISMATCH"
echo "MANIFEST_ENTRY_COUNT=$ENTRIES"
if [[ "$EXIT" -eq 0 && "$MISSING" -eq 0 && "$MISMATCH" -eq 0 ]]; then
  echo "LOCAL_EVIDENCE_PACK_VERIFIED=YES"
  exit 0
fi
echo "LOCAL_EVIDENCE_PACK_VERIFIED=NO"
exit 1
