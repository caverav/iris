#!/bin/bash
# Pull eve.json + rotating pcaps from each vulnbox to the analysis box's
# traffic dir. Inverted from the push-shipper because ICC-style gamenets
# block vulnbox -> player traffic; the analysis box reaches outwards
# instead and pulls.
#
# Environment:
#   VULNBOX_LIST    Comma-separated `host=ip` pairs, one per vulnbox.
#                   e.g. "vulnbox0-team6=10.60.6.1,vulnbox1-team6=10.61.6.1"
#   SSH_USER        Default ssh user on each vulnbox (default: root).
#   SSH_KEY         Path to private key inside the container
#                   (default: /keys/id_ed25519).
#   FETCH_INTERVAL  Seconds between pulls (default: 30).
#   TRAFFIC_DIR     Local dir to drop fetched files (default: /traffic).
#   REMOTE_PCAP_DIR Path on each vulnbox where Suricata writes pcaps
#                   (default: /opt/iris/traffic).
#   REMOTE_EVE      Path on each vulnbox to eve.json
#                   (default: /opt/iris/suricata-runtime/log/eve.json).
#
# Output layout in TRAFFIC_DIR:
#   eve-<hostname>.json     - one per vulnbox, eve glob picks them up
#   <hostname>--<pcap>      - hostname-prefixed pcaps
#   status-<hostname>.json  - last-fetch timestamps + sha of pcap dir
set -eu

: "${VULNBOX_LIST:?VULNBOX_LIST must be set, e.g. host1=10.60.6.1,host2=10.61.6.1}"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-/keys/id_ed25519}"
FETCH_INTERVAL="${FETCH_INTERVAL:-30}"
TRAFFIC_DIR="${TRAFFIC_DIR:-/traffic}"
# eve.json files land in the `log/` subdir to match where Suricata would
# have written them if it ran locally. The enricher's mount maps
# ${SURICATA_DIR_HOST}/log -> /suricata, so eve-<host>.json shows up at
# /suricata/eve-<host>.json on the enricher side and matches the
# /suricata/eve*.json glob it watches.
EVE_DIR="${EVE_DIR:-${TRAFFIC_DIR}/log}"
REMOTE_PCAP_DIR="${REMOTE_PCAP_DIR:-/opt/iris/traffic}"
REMOTE_EVE="${REMOTE_EVE:-/opt/iris/suricata-runtime/log/eve.json}"
SSH_OPTS="${SSH_OPTS:--o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10}"

mkdir -p "$TRAFFIC_DIR" "$EVE_DIR"
ssh_cmd="ssh -i $SSH_KEY $SSH_OPTS"

# Stage area for hostname-prefix renaming. MUST live on the same filesystem
# as TRAFFIC_DIR so the `ln` below makes a real hardlink: rsync's
# --append-verify grows the staged file in place, and a real hardlink lets
# the traffic-dir entry reflect that growth without another copy. A
# cross-fs stage (e.g. /tmp) silently fell back to `cp`, which then never
# refreshed once the first iteration had run.
STAGE_DIR="${TRAFFIC_DIR}/.stage"
mkdir -p "$STAGE_DIR"

fetch_one() {
  host="$1"
  ip="$2"
  stage="$STAGE_DIR/$host"
  mkdir -p "$stage"

  # eve.json: append-verify lets us resume across restarts and grow the
  # local copy as the remote one grows. Lands in EVE_DIR (default
  # ${TRAFFIC_DIR}/log) which is what the enricher's mount expects.
  rsync -az --append-verify -e "$ssh_cmd" \
    "${SSH_USER}@${ip}:${REMOTE_EVE}" \
    "$EVE_DIR/eve-${host}.json" \
    || echo "[fetcher] $host eve fetch failed (will retry)"

  # pcaps: append-verify treats Suricata's rotated pcap files as the
  # append-only logs they actually are. New rotated files (which don't
  # exist locally) are pulled in full; the currently-active file (which
  # Suricata is still writing to) is grown by appending the new bytes
  # only. --ignore-existing here was a bug: it pulled each pcap exactly
  # once and then never updated it, so any traffic logged after the
  # first fetch was invisible to the analysis box even though the file
  # grew to 100MB on the vulnbox.
  rsync -az --append-verify -e "$ssh_cmd" \
    "${SSH_USER}@${ip}:${REMOTE_PCAP_DIR}/" \
    "$stage/" \
    || echo "[fetcher] $host pcap fetch failed (will retry)"

  for f in "$stage"/*; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    dest="$TRAFFIC_DIR/${host}--${base}"
    if [ ! -e "$dest" ]; then
      ln "$f" "$dest" 2>/dev/null || cp "$f" "$dest"
    fi
  done

  printf '{"hostname":"%s","ip":"%s","ts":%s}\n' \
    "$host" "$ip" "$(date +%s)" \
    > "$TRAFFIC_DIR/status-${host}.json"
}

echo "[fetcher] vulnbox list: $VULNBOX_LIST"
echo "[fetcher] traffic dir : $TRAFFIC_DIR"
echo "[fetcher] interval    : ${FETCH_INTERVAL}s"

while true; do
  IFS=',' read -ra ENTRIES <<< "$VULNBOX_LIST"
  for entry in "${ENTRIES[@]}"; do
    case "$entry" in
      *=*)
        host="${entry%%=*}"
        ip="${entry#*=}"
        ;;
      *)
        echo "[fetcher] bad VULNBOX_LIST entry (need host=ip): $entry"
        continue
        ;;
    esac
    fetch_one "$host" "$ip"
  done
  sleep "$FETCH_INTERVAL"
done
