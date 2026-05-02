#!/bin/sh
# Pull the canonical local.rules from the analysis box's api over HTTP basic
# auth and reload the local Suricata if the file changed. Runs as a sibling
# loop to ship.sh on every vulnbox; both share the same container image.
#
# Environment:
#   IRIS_API_BASE      Required. Base URL for the analysis box's api,
#                      e.g. http://10.0.0.1:5000  (or https://...).
#                      No trailing slash.
#   IRIS_ADMIN_USER    Basic-auth user (default: admin).
#   IRIS_ADMIN_PASS    Basic-auth pass (required if api requires auth).
#   PULL_INTERVAL      Seconds between polls (default 10).
#   RULES_DEST         Where to drop the rules (default
#                      /var/lib/suricata/rules/local.rules).
#   SURICATA_SOCKET    Suricata's unix-command socket
#                      (default /run/suricata/suricata-command.socket).
set -eu

: "${IRIS_API_BASE:?IRIS_API_BASE must be set, e.g. http://10.0.0.1:5000}"
PULL_INTERVAL="${PULL_INTERVAL:-10}"
RULES_DEST="${RULES_DEST:-/var/lib/suricata/rules/local.rules}"
SURICATA_SOCKET="${SURICATA_SOCKET:-/run/suricata/suricata-command.socket}"
IRIS_ADMIN_USER="${IRIS_ADMIN_USER:-admin}"
IRIS_ADMIN_PASS="${IRIS_ADMIN_PASS:-}"

mkdir -p "$(dirname "$RULES_DEST")"

curl_args="-fsS --max-time 10 --retry 0"
if [ -n "$IRIS_ADMIN_PASS" ]; then
  curl_args="$curl_args -u ${IRIS_ADMIN_USER}:${IRIS_ADMIN_PASS}"
fi

# `reload-rules` over Suricata's unix-command socket. Tiny JSON-line dialect:
# 1) send {"version":"0.2"}\n, expect {"return":"OK"...}
# 2) send {"command":"reload-rules"}\n, expect {"return":"OK"...}
reload_suricata() {
  if [ ! -S "$SURICATA_SOCKET" ]; then
    echo "[pull-rules] $SURICATA_SOCKET not present yet, will reload on next change"
    return 0
  fi
  # socat speaks unix-domain sockets reliably across distros.
  printf '{"version":"0.2"}\n{"command":"reload-rules"}\n' \
    | socat -t 5 - UNIX-CONNECT:"$SURICATA_SOCKET" >/tmp/reload.out 2>&1 || {
      echo "[pull-rules] suricata reload failed: $(cat /tmp/reload.out 2>/dev/null)"
      return 1
    }
  echo "[pull-rules] suricata reload-rules: $(tr -d '\n' </tmp/reload.out)"
}

pull_once() {
  tmp="$(mktemp)"
  # Endpoint returns {"path":..., "content":"..."} - unwrap with jq if
  # available, fall back to a sed extract that handles the common shape.
  body="$(mktemp)"
  if ! curl $curl_args -H 'Accept: application/json' \
       "$IRIS_API_BASE/admin/rules" -o "$body"; then
    echo "[pull-rules] fetch failed; will retry"
    rm -f "$tmp" "$body"
    return 0
  fi

  jq -r '.content // ""' < "$body" > "$tmp"

  # Compare - only act when the file actually changed, so we don't churn
  # Suricata's reload pipeline.
  new_hash="$(sha256sum "$tmp" 2>/dev/null | cut -d' ' -f1)"
  cur_hash="-"
  if [ -f "$RULES_DEST" ]; then
    cur_hash="$(sha256sum "$RULES_DEST" 2>/dev/null | cut -d' ' -f1)"
  fi

  if [ "$new_hash" != "$cur_hash" ]; then
    echo "[pull-rules] new ruleset (sha256=${new_hash}); writing $RULES_DEST"
    install -m 0644 "$tmp" "$RULES_DEST"
    reload_suricata || true
  fi

  rm -f "$tmp" "$body"
}

echo "[pull-rules] polling ${IRIS_API_BASE}/admin/rules every ${PULL_INTERVAL}s"
while true; do
  pull_once
  sleep "$PULL_INTERVAL"
done
