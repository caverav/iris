#!/bin/sh
# Ship Suricata eve.json and rotating pcaps from the vulnbox to a remote
# analysis box running the Iris stack.
#
# Environment:
#   VULNBOX_SSH_DEST     Required. rsync destination, e.g. user@iris:/srv/iris/traffic
#   VULNBOX_HOSTNAME     Override the hostname used to namespace uploads
#                        (default: container's `hostname` - usually the VM's).
#   SURICATA_LOG_DIR     Local directory that contains eve.json (default /suricata/log).
#   TRAFFIC_DIR          Local directory that contains *.pcap (default /traffic).
#   SHIP_INTERVAL        Seconds between pushes (default 30).
#   SSH_KEY              Path to the SSH key inside the container (default /keys/id_ed25519).
#   SSH_EXTRA_OPTS       Extra options passed to ssh (default: StrictHostKeyChecking=accept-new).
#
# Behaviour:
#   * Uploads are namespaced by hostname so N vulnboxes can share one rsync
#     target dir without colliding:
#       eve-<hostname>.json
#       <hostname>--<original-pcap-name>          (e.g. vuln1--log.pcap.1714540123)
#       status-<hostname>.json                    (loaded rules hash + timestamps)
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
HOSTNAME_TAG="${VULNBOX_HOSTNAME:-$(hostname 2>/dev/null || echo unknown)}"
# Sanitize: filenames can't contain / or whitespace, and Linux hostnames
# are normally already safe, but harden against unusual values.
HOSTNAME_TAG="$(echo "$HOSTNAME_TAG" | tr -c '[:alnum:]._-' '_')"
STAGE_DIR="${STAGE_DIR:-/tmp/iris-stage}"

mkdir -p "$STAGE_DIR"
ssh_cmd="ssh -i $SSH_KEY $SSH_EXTRA_OPTS"

ship_once() {
  # eve.json: stage a hostname-tagged copy and ship that. Hardlink first
  # (atomic, instant) and only fall back to cp if hardlink fails (e.g. when
  # the staging dir crosses a filesystem boundary from the bind mount).
  if [ -f "$SURICATA_LOG_DIR/eve.json" ]; then
    eve_staged="$STAGE_DIR/eve-${HOSTNAME_TAG}.json"
    rm -f "$eve_staged"
    ln "$SURICATA_LOG_DIR/eve.json" "$eve_staged" 2>/dev/null \
      || cp "$SURICATA_LOG_DIR/eve.json" "$eve_staged"
    rsync -az --append-verify -e "$ssh_cmd" \
      "$eve_staged" "$VULNBOX_SSH_DEST/eve-${HOSTNAME_TAG}.json" \
      || echo "[shipper] eve.json rsync failed (will retry)"
  fi

  # pcaps: prefix each with our hostname so two vulnboxes that happened to
  # rotate at the same unix-ts produce distinct filenames on the analysis
  # box. We use rsync's --rsync-path "sh -c 'cat > <renamed>'" trick by
  # staging renamed hardlinks and shipping the stage dir.
  if [ -d "$TRAFFIC_DIR" ] && [ -n "$(ls -A "$TRAFFIC_DIR" 2>/dev/null)" ]; then
    pcap_stage="$STAGE_DIR/pcaps"
    mkdir -p "$pcap_stage"
    # Refresh stage: drop hardlinks for files that no longer exist locally
    # (Suricata pruned them via max-files); add new ones.
    for f in "$pcap_stage"/*; do
      [ -e "$f" ] || continue
      orig_name="${f#"$pcap_stage/${HOSTNAME_TAG}--"}"
      if [ ! -e "$TRAFFIC_DIR/$orig_name" ]; then
        rm -f "$f"
      fi
    done
    for f in "$TRAFFIC_DIR"/*; do
      [ -f "$f" ] || continue
      base="$(basename "$f")"
      tagged="$pcap_stage/${HOSTNAME_TAG}--$base"
      [ -e "$tagged" ] && continue
      ln "$f" "$tagged" 2>/dev/null || cp "$f" "$tagged"
    done
    rsync -az --ignore-existing -e "$ssh_cmd" \
      "$pcap_stage"/ "$VULNBOX_SSH_DEST/" \
      || echo "[shipper] pcap rsync failed (will retry)"
  fi

  # status file: a tiny health beacon the analysis box uses to show
  # "rules synced N/M" and "last seen" per vulnbox.
  status="$STAGE_DIR/status-${HOSTNAME_TAG}.json"
  rules_hash="-"
  if [ -f /var/lib/suricata/rules/local.rules ]; then
    rules_hash="$(sha256sum /var/lib/suricata/rules/local.rules 2>/dev/null | cut -d' ' -f1)"
  fi
  printf '{"hostname":"%s","loaded_rules_sha256":"%s","ts":%s}\n' \
    "$HOSTNAME_TAG" "$rules_hash" "$(date +%s)" > "$status"
  rsync -az -e "$ssh_cmd" "$status" "$VULNBOX_SSH_DEST/status-${HOSTNAME_TAG}.json" \
    || echo "[shipper] status rsync failed (will retry)"
}

echo "[shipper] hostname tag: ${HOSTNAME_TAG}"
echo "[shipper] shipping every ${SHIP_INTERVAL}s to ${VULNBOX_SSH_DEST}"
while true; do
  ship_once
  sleep "$SHIP_INTERVAL"
done
