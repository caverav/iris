#!/bin/bash
# Remove the NFQUEUE jump installed by iptables-init.sh.
# Uses the same env vars to find the rule to delete.
set -eu

QUEUE_NUM="${NFQUEUE_NUM:-0}"
IFACE="${NFQUEUE_IFACE:-}"
CHAINS="${NFQUEUE_CHAINS:-INPUT,FORWARD,DOCKER-USER}"
IPV6="${NFQUEUE_IPV6:-1}"

egress_chain() {
  case "$1" in
    POSTROUTING|OUTPUT) return 0 ;;
    *) return 1 ;;
  esac
}

iface_args_for() {
  if [ -z "$IFACE" ]; then
    echo ""
    return
  fi
  if egress_chain "$1"; then
    echo "-o $IFACE"
  else
    echo "-i $IFACE"
  fi
}

parse_spec() {
  local spec="$1"
  if [[ "$spec" == *:* ]]; then
    echo "${spec%%:*} ${spec##*:}"
  else
    echo "filter $spec"
  fi
}

# Mirror iptables-init's backend detection so we tear down rules against
# the same backend they were installed on.
detect_iptables_backend() {
  local nft legacy
  nft=$(iptables-nft-save 2>/dev/null | grep -c '^-' || true)
  legacy=$(iptables-legacy-save 2>/dev/null | grep -c '^-' || true)
  nft=${nft:-0}
  legacy=${legacy:-0}
  if [ "$legacy" -gt "$nft" ]; then
    echo legacy
  else
    echo nft
  fi
}

BACKEND="$(detect_iptables_backend)"
IPT4="iptables-${BACKEND}"
IPT6="ip6tables-${BACKEND}"

remove_jump() {
  local cmd="$1"
  local table="$2"
  local chain="$3"
  local iface_args
  iface_args="$(iface_args_for "$chain")"
  # Repeatedly delete until gone (in case of stale duplicates).
  # shellcheck disable=SC2086
  while $cmd -t "$table" -C "$chain" $iface_args -j NFQUEUE --queue-num "$QUEUE_NUM" --queue-bypass 2>/dev/null; do
    $cmd -t "$table" -D "$chain" $iface_args -j NFQUEUE --queue-num "$QUEUE_NUM" --queue-bypass
    echo "[iptables-teardown] removed jump from $cmd $table:$chain"
  done
}

IFS=',' read -r -a chains <<< "$CHAINS"
for spec in "${chains[@]}"; do
  spec_trimmed="$(echo "$spec" | tr -d '[:space:]')"
  [ -z "$spec_trimmed" ] && continue
  read -r table chain <<< "$(parse_spec "$spec_trimmed")"
  remove_jump "$IPT4" "$table" "$chain"
  if [ "$IPV6" = "1" ]; then
    remove_jump "$IPT6" "$table" "$chain"
  fi
done

echo "[iptables-teardown] done"
