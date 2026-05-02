#!/bin/bash
# Periodic maintenance for an iris analysis box:
#
#   * Prune accumulated pcaps in TRAFFIC_DIR (the fetcher would otherwise
#     keep every rotated file forever, since `--ignore-existing` means
#     deletions on the vulnbox don't propagate).
#   * Apply / refresh TimescaleDB chunk-retention policies on flow,
#     flow_item, and flow_index so old data drops cleanly without
#     per-row scans.
#
# Both jobs are off by default - they only run when the corresponding
# env var is set. The container is opt-in via the `janitor` compose
# profile, so existing deployments don't suddenly start dropping data.
#
# Environment:
#   TIMESCALE                Postgres connection string (required for DB pruning).
#   TRAFFIC_DIR              Where pcaps + eve-*.json live (default /traffic).
#   JANITOR_INTERVAL_SECONDS Sleep between sweeps (default 3600 = 1h).
#   IRIS_PCAP_RETENTION_HOURS  Delete pcaps older than this many hours.
#                              Empty = don't prune by age.
#   IRIS_PCAP_MAX_GB           Cap total pcap bytes; oldest files deleted
#                              first when over the cap. Empty = no cap.
#   IRIS_DB_RETENTION_HOURS    timescaledb chunk retention. Empty = leave alone.
set -euo pipefail

TRAFFIC_DIR="${TRAFFIC_DIR:-/traffic}"
JANITOR_INTERVAL_SECONDS="${JANITOR_INTERVAL_SECONDS:-3600}"
IRIS_PCAP_RETENTION_HOURS="${IRIS_PCAP_RETENTION_HOURS:-}"
IRIS_PCAP_MAX_GB="${IRIS_PCAP_MAX_GB:-}"
IRIS_DB_RETENTION_HOURS="${IRIS_DB_RETENTION_HOURS:-}"
TIMESCALE="${TIMESCALE:-}"

prune_pcaps_by_age() {
  [ -z "$IRIS_PCAP_RETENTION_HOURS" ] && return 0
  [ -d "$TRAFFIC_DIR" ] || return 0
  local mins=$(( IRIS_PCAP_RETENTION_HOURS * 60 ))
  # Match Suricata's rotated names (`*.pcap.<ts>`) and conventional `.pcap`,
  # but leave eve-*.json and status-*.json alone.
  local victims
  victims="$(find "$TRAFFIC_DIR" -maxdepth 1 -type f \
              \( -name '*.pcap' -o -name '*.pcap.*' \) \
              -mmin "+$mins" -print)" || true
  if [ -n "$victims" ]; then
    local count
    count=$(echo "$victims" | wc -l)
    echo "[janitor] age-pruning $count pcap(s) older than ${IRIS_PCAP_RETENTION_HOURS}h"
    echo "$victims" | xargs -r rm -f --
  fi
}

prune_pcaps_by_size() {
  [ -z "$IRIS_PCAP_MAX_GB" ] && return 0
  [ -d "$TRAFFIC_DIR" ] || return 0
  local cap=$(( IRIS_PCAP_MAX_GB * 1024 * 1024 * 1024 ))
  local guard=0
  while :; do
    # Total bytes of just pcap files, ignoring eve/status sidecars.
    local total
    total=$(find "$TRAFFIC_DIR" -maxdepth 1 -type f \
              \( -name '*.pcap' -o -name '*.pcap.*' \) \
              -printf '%s\n' 2>/dev/null | awk '{s+=$1} END{print s+0}')
    if [ "$total" -le "$cap" ]; then
      [ "$guard" -gt 0 ] && echo "[janitor] size now $((total / 1024 / 1024)) MiB <= cap"
      return 0
    fi
    # Find oldest pcap, delete it, loop. Hard cap of 1000 deletes per
    # sweep so a runaway loop can't trash the disk.
    guard=$((guard + 1))
    if [ "$guard" -gt 1000 ]; then
      echo "[janitor] WARN: hit 1000-file delete guard, bailing out of size prune"
      return 0
    fi
    local oldest
    oldest=$(find "$TRAFFIC_DIR" -maxdepth 1 -type f \
              \( -name '*.pcap' -o -name '*.pcap.*' \) \
              -printf '%T@ %p\n' 2>/dev/null | sort -n | head -1 | cut -d' ' -f2-)
    if [ -z "$oldest" ]; then
      return 0  # no more pcaps to delete and still over cap - nothing more we can do
    fi
    echo "[janitor] size-pruning $(basename "$oldest")"
    rm -f -- "$oldest"
  done
}

apply_db_retention() {
  [ -z "$IRIS_DB_RETENTION_HOURS" ] && return 0
  [ -z "$TIMESCALE" ] && { echo "[janitor] TIMESCALE unset, skipping DB retention"; return 0; }
  local interval="${IRIS_DB_RETENTION_HOURS} hours"
  # `flow` and `flow_item` are hypertables - use timescaledb's
  # chunk-retention policy, which drops whole chunks rather than walking
  # rows. Drop+re-add so a changed env actually takes effect.
  for tbl in flow flow_item; do
    local sql="SELECT remove_retention_policy('$tbl', if_exists => true);
SELECT add_retention_policy('$tbl', INTERVAL '$interval');"
    if echo "$sql" | psql "$TIMESCALE" -v ON_ERROR_STOP=1 >/dev/null 2>&1; then
      echo "[janitor] retention on $tbl set to $interval"
    else
      echo "[janitor] WARN: failed to apply retention on $tbl"
    fi
  done
  # `flow_index` is a plain table, not a hypertable. Its flow_id encodes
  # the flow's timestamp via fid_unpack_time(), but there's no expression
  # index on that, so a straight DELETE across millions of rows would
  # take minutes and lock out concurrent COPYs from the assembler. Batch
  # it: delete up to FLOW_INDEX_BATCH rows per statement, loop until a
  # round affects zero rows or we hit FLOW_INDEX_MAX_BATCHES (a hard cap
  # so a runaway loop can't wedge the DB).
  local batch="${FLOW_INDEX_BATCH:-50000}"
  local max_batches="${FLOW_INDEX_MAX_BATCHES:-200}"
  local total=0
  for i in $(seq 1 "$max_batches"); do
    local n
    n=$(psql "$TIMESCALE" -tA -v ON_ERROR_STOP=1 -c "
      WITH victims AS (
        SELECT ctid FROM flow_index
        WHERE fid_unpack_time(flow_id) < NOW() - INTERVAL '$interval'
        LIMIT $batch
      )
      DELETE FROM flow_index WHERE ctid IN (SELECT ctid FROM victims)
      RETURNING 1
    " 2>/dev/null | wc -l)
    n=${n:-0}
    total=$((total + n))
    [ "$n" -eq 0 ] && break
  done
  if [ "$total" -gt 0 ]; then
    echo "[janitor] pruned $total flow_index rows older than $interval"
  fi
}

echo "[janitor] interval=${JANITOR_INTERVAL_SECONDS}s"
echo "[janitor] pcap age=${IRIS_PCAP_RETENTION_HOURS:-off}h max_size=${IRIS_PCAP_MAX_GB:-off}GB"
echo "[janitor] db retention=${IRIS_DB_RETENTION_HOURS:-off}h"

while true; do
  prune_pcaps_by_age || echo "[janitor] age prune failed (continuing)"
  prune_pcaps_by_size || echo "[janitor] size prune failed (continuing)"
  apply_db_retention || echo "[janitor] db retention failed (continuing)"
  sleep "$JANITOR_INTERVAL_SECONDS"
done
