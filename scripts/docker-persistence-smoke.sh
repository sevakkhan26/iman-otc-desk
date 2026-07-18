#!/usr/bin/env bash
# Integration smoke: volume survives restart / force-recreate / rebuild.
# Requires Docker. Does not print secrets or alert payloads.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

SERVICE="${SERVICE_NAME:-iman-otc-desk}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
MARKER_ID="persist-smoke-$(date +%s)"

command -v docker >/dev/null || { echo "docker not installed; skip"; exit 0; }

log() { echo "[docker-smoke] $*"; }

cleanup() {
  # Keep volume — only stop container if we created a throwaway project
  true
}
trap cleanup EXIT

log "build + up"
docker compose -f "${COMPOSE_FILE}" up -d --build --force-recreate "${SERVICE}"

# Wait for running
for i in $(seq 1 40); do
  st="$(docker inspect --format='{{.State.Status}}' "${SERVICE}" 2>/dev/null || echo missing)"
  [ "${st}" = "running" ] && break
  sleep 2
done

log "verify env + mount"
docker exec "${SERVICE}" sh -c 'echo storage=$PRICE_ALERTS_STORAGE dir=$PRICE_ALERTS_DATA_DIR'
docker exec "${SERVICE}" sh -c 'test -w "$PRICE_ALERTS_DATA_DIR" && echo writable=yes'

# Write a marker via node inside container (bypasses auth HTTP)
log "write marker alert id=${MARKER_ID}"
docker exec "${SERVICE}" node -e "
const fs=require('fs');
const p=process.env.PRICE_ALERTS_DATA_FILE||'/app/data/price-alerts/price-alerts.json';
let d={alerts:[],notifications:[],updatedAt:null};
try{d=JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){}
d.alerts=d.alerts||[];
d.alerts.unshift({id:process.env.MARKER,instrument:'usdt_irt',targetPrice:1,condition:'gte',priceType:'mid',providerMode:'any',providerId:null,enabled:true,repeatMode:'once',cooldownSeconds:300,expiresAt:null,note:'docker-smoke',previousObservedPrice:null,lastEvaluatedPrice:null,lastEvaluatedAt:null,lastTriggeredAt:null,triggerCount:0,lastProviderId:null,lastProviderName:null,status:'active',createdBy:'smoke',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
d.updatedAt=new Date().toISOString();
fs.writeFileSync(p,JSON.stringify(d));
console.log('wrote',process.env.MARKER);
" -e "" 2>/dev/null || \
docker exec -e MARKER="${MARKER_ID}" "${SERVICE}" node <<'NODE'
const fs = require("fs");
const p = process.env.PRICE_ALERTS_DATA_FILE || "/app/data/price-alerts/price-alerts.json";
const id = process.env.MARKER;
let d = { alerts: [], notifications: [], updatedAt: null };
try {
  d = JSON.parse(fs.readFileSync(p, "utf8"));
} catch (_) {}
d.alerts = d.alerts || [];
d.alerts.unshift({
  id,
  instrument: "usdt_irt",
  targetPrice: 1,
  condition: "gte",
  priceType: "mid",
  providerMode: "any",
  providerId: null,
  enabled: true,
  repeatMode: "once",
  cooldownSeconds: 300,
  expiresAt: null,
  note: "docker-smoke",
  previousObservedPrice: null,
  lastEvaluatedPrice: null,
  lastEvaluatedAt: null,
  lastTriggeredAt: null,
  triggerCount: 0,
  lastProviderId: null,
  lastProviderName: null,
  status: "active",
  createdBy: "smoke",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});
d.updatedAt = new Date().toISOString();
fs.mkdirSync(require("path").dirname(p), { recursive: true });
fs.writeFileSync(p, JSON.stringify(d));
console.log("wrote", id);
NODE

assert_marker() {
  local phase="$1"
  docker exec -e MARKER="${MARKER_ID}" "${SERVICE}" node -e '
const fs=require("fs");
const p=process.env.PRICE_ALERTS_DATA_FILE||"/app/data/price-alerts/price-alerts.json";
const d=JSON.parse(fs.readFileSync(p,"utf8"));
const ok=(d.alerts||[]).some(a=>a.id===process.env.MARKER);
if(!ok){console.error("MISSING marker after "+process.env.PHASE); process.exit(1);}
console.log("ok marker after", process.env.PHASE);
' -e "" 2>/dev/null || \
  docker exec -e MARKER="${MARKER_ID}" -e PHASE="${phase}" "${SERVICE}" node -e 'const fs=require("fs");const p=process.env.PRICE_ALERTS_DATA_FILE||"/app/data/price-alerts/price-alerts.json";const d=JSON.parse(fs.readFileSync(p,"utf8"));if(!(d.alerts||[]).some(a=>a.id===process.env.MARKER)){console.error("MISSING",process.env.PHASE);process.exit(1)};console.log("ok",process.env.PHASE);'
}

assert_marker "initial-write"

log "restart"
docker restart "${SERVICE}"
sleep 5
assert_marker "restart"

log "force-recreate"
docker compose -f "${COMPOSE_FILE}" up -d --force-recreate "${SERVICE}"
sleep 8
assert_marker "force-recreate"

log "rebuild"
docker compose -f "${COMPOSE_FILE}" up -d --build --force-recreate "${SERVICE}"
sleep 12
assert_marker "rebuild"

log "volume still present"
docker volume inspect iman-otc-alerts-data >/dev/null
log "PASS persistence smoke"
