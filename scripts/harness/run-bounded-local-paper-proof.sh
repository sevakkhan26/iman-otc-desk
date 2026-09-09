#!/usr/bin/env bash
# Bounded Local Paper proof AFTER telemetry instrumentation.
# Fresh DB, short run, SHADOW_PAPER_ENSURE=1, LIVE=false. No push/deploy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ART="${TELEMETRY_ART_DIR:-/workspace/supervisor-tasks/SHADOW-TELEMETRY-FORENSIC-CLOSURE-20260909}"
DURATION_SEC="${DURATION_SEC:-180}"
RUN_ID="telemetry-proof-$(date -u +%Y%m%dT%H%M%SZ)"
DB_DIR="$ROOT/.data/pglite-$RUN_ID"
RUN_DIR="$ART/proof/$RUN_ID"
mkdir -p "$DB_DIR" "$RUN_DIR/logs" "$RUN_DIR/harness" "$ART/logs"

export DATABASE_URL="pglite:$DB_DIR"
export LIVE=false
export SHADOW_PAPER_ENSURE=1
export SHADOW_DECISION_TRACE=true
export SHADOW_RELEASE_BOOTSTRAP=false
export SHADOW_POLL_MS="${SHADOW_POLL_MS:-15000}"
export SHADOW_MAX_CYCLES="${SHADOW_MAX_CYCLES:-0}"
export SHADOW_ALLOW_SHARED_PGLITE=1
export TELEMETRY_ART_DIR="$ART"

echo "RUN_ID=$RUN_ID" | tee "$RUN_DIR/meta.txt"
echo "DB=$DB_DIR" | tee -a "$RUN_DIR/meta.txt"
echo "DURATION_SEC=$DURATION_SEC" | tee -a "$RUN_DIR/meta.txt"

cd "$ROOT"
# Fixture regression first (must pass before live proof)
TELEMETRY_ART_DIR="$ART" npx --yes tsx scripts/test-telemetry-funnel-fixtures.mts \
  | tee "$RUN_DIR/logs/fixture-test.out"

CMD="cd $ROOT && DATABASE_URL=$DATABASE_URL LIVE=false SHADOW_PAPER_ENSURE=1 SHADOW_DECISION_TRACE=true SHADOW_RELEASE_BOOTSTRAP=false SHADOW_POLL_MS=$SHADOW_POLL_MS SHADOW_ALLOW_SHARED_PGLITE=1 npx --yes tsx scripts/shadow-worker.mts"
"$ROOT/scripts/harness/launch-shadow-worker.sh" \
  --run-dir "$RUN_DIR" \
  --duration-sec "$DURATION_SEC" \
  --cmd "$CMD" | tee "$RUN_DIR/harness/launch.out"

"$ROOT/scripts/harness/monitor-shadow-worker.sh" --run-dir "$RUN_DIR" \
  | tee "$RUN_DIR/logs/monitor.out" || true

"$ROOT/scripts/harness/stop-shadow-worker.sh" "$RUN_DIR" \
  | tee "$RUN_DIR/logs/stop.out" || true

# Post-stop queries on the proof DB
DATABASE_URL="$DATABASE_URL" TELEMETRY_ART_DIR="$RUN_DIR" \
  npx --yes tsx scripts/post-observation-telemetry-queries.mts \
  | tee "$RUN_DIR/logs/post-obs.out"

# Completeness check
DATABASE_URL="$DATABASE_URL" npx --yes tsx scripts/proof-telemetry-completeness.mts \
  | tee "$RUN_DIR/logs/completeness.out"


echo "BOUNDED_PROOF_DONE $RUN_ID" | tee -a "$RUN_DIR/meta.txt"
echo "$RUN_DIR"
