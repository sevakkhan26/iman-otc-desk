#!/bin/bash
# Keep-alive wrapper: runs the OTC Desk production server and restarts it if it exits.
# Launched (detached) by the desktop app when the dashboard is opened.
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="/tmp/otc-desk.log"

echo "[$(date)] keep-alive started" >> "$LOG"
while true; do
  /bin/bash "$DIR/otc-desk-server.sh"
  echo "[$(date)] server exited, restarting in 2s" >> "$LOG"
  sleep 2
done
