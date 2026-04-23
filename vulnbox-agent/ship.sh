#!/bin/sh
# Ship Suricata eve.json and rotating pcaps from the vulnbox to a remote
# analysis box running the Iris stack.
#
# Environment:
#   VULNBOX_SSH_DEST     Required. rsync destination, e.g. user@iris:/srv/iris/traffic
#   SURICATA_LOG_DIR     Local directory that contains eve.json (default /suricata/log).
#   TRAFFIC_DIR          Local directory that contains *.pcap (default /traffic).
#   SHIP_INTERVAL        Seconds between pushes (default 30).
#   SSH_KEY              Path to the SSH key inside the container (default /keys/id_ed25519).
#   SSH_EXTRA_OPTS       Extra options passed to ssh (default: StrictHostKeyChecking=accept-new).
#
# Behaviour:
#   * Uses rsync --append-verify for eve.json (append-only log, safe to resume).
#   * Uses rsync --ignore-existing for pcaps (they are named by timestamp, rotated).
#   * Fails loudly on auth errors; keeps retrying on transient network errors.
set -eu

: "${VULNBOX_SSH_DEST:?VULNBOX_SSH_DEST must be set, e.g. user@host:/path}"
SURICATA_LOG_DIR="${SURICATA_LOG_DIR:-/suricata/log}"
TRAFFIC_DIR="${TRAFFIC_DIR:-/traffic}"
SHIP_INTERVAL="${SHIP_INTERVAL:-30}"
SSH_KEY="${SSH_KEY:-/keys/id_ed25519}"
SSH_EXTRA_OPTS="${SSH_EXTRA_OPTS:--o StrictHostKeyChecking=accept-new -o ConnectTimeout=10}"

ssh_cmd="ssh -i $SSH_KEY $SSH_EXTRA_OPTS"

ship_once() {
  if [ -f "$SURICATA_LOG_DIR/eve.json" ]; then
    rsync -az --append-verify -e "$ssh_cmd" \
      "$SURICATA_LOG_DIR/eve.json" "$VULNBOX_SSH_DEST/eve.json" \
      || echo "[shipper] eve.json rsync failed (will retry)"
  fi
  if [ -d "$TRAFFIC_DIR" ] && [ -n "$(ls -A "$TRAFFIC_DIR" 2>/dev/null)" ]; then
    rsync -az --ignore-existing -e "$ssh_cmd" \
      "$TRAFFIC_DIR"/ "$VULNBOX_SSH_DEST/" \
      || echo "[shipper] pcap rsync failed (will retry)"
  fi
}

echo "[shipper] shipping every ${SHIP_INTERVAL}s to ${VULNBOX_SSH_DEST}"
while true; do
  ship_once
  sleep "$SHIP_INTERVAL"
done
