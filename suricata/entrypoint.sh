#!/bin/bash
# Tulip Suricata entrypoint.
#
# Responsibilities:
#   * Seed /etc/suricata and /var/lib/suricata/rules on first run (idempotent).
#     Never overwrite files the user has edited.
#   * Optionally pull ET-Open rules via suricata-update when
#     SURICATA_UPDATE_ENABLE=1.
#   * Exec Suricata with the options provided via SURICATA_OPTIONS.
set -euo pipefail

SEED_RULES_DIR="/seed/rules"
SEED_ETC_DIR="/seed/etc"
RULES_DIR="/var/lib/suricata/rules"
ETC_DIR="/etc/suricata"

mkdir -p "$RULES_DIR" "$ETC_DIR"

# Seed rules if none present. cp -n keeps user edits.
if [ -d "$SEED_RULES_DIR" ]; then
  for f in "$SEED_RULES_DIR"/*; do
    [ -e "$f" ] || continue
    cp -n "$f" "$RULES_DIR/"
  done
fi

# Seed suricata.yaml if absent. cp -n keeps user edits.
if [ -d "$SEED_ETC_DIR" ]; then
  for f in "$SEED_ETC_DIR"/*; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    if [ ! -e "$ETC_DIR/$base" ]; then
      cp "$f" "$ETC_DIR/$base"
    fi
  done
fi

if [ "${SURICATA_UPDATE_ENABLE:-0}" = "1" ]; then
  echo "[tulip-suricata] running suricata-update (SURICATA_UPDATE_ENABLE=1)"
  suricata-update --no-test -o "$RULES_DIR" || echo "[tulip-suricata] suricata-update failed, continuing with existing rules"
fi

echo "[tulip-suricata] launching: /usr/bin/suricata ${SURICATA_OPTIONS:-}"
# shellcheck disable=SC2086
exec /usr/bin/suricata ${SURICATA_OPTIONS:-}
