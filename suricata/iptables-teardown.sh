#!/bin/bash
# Remove the NFQUEUE jump installed by iptables-init.sh.
# Uses the same env vars to find the rule to delete.
set -eu

QUEUE_NUM="${NFQUEUE_NUM:-0}"
IFACE="${NFQUEUE_IFACE:-}"
CHAINS="${NFQUEUE_CHAINS:-INPUT,FORWARD,DOCKER-USER}"
IPV6="${NFQUEUE_IPV6:-1}"

iface_args=""
if [ -n "$IFACE" ]; then
  iface_args="-i $IFACE"
fi

remove_jump() {
  local cmd="$1"
  local chain="$2"
  # Repeatedly delete until gone (in case of stale duplicates).
  # shellcheck disable=SC2086
  while $cmd -C "$chain" $iface_args -j NFQUEUE --queue-num "$QUEUE_NUM" --queue-bypass 2>/dev/null; do
    $cmd -D "$chain" $iface_args -j NFQUEUE --queue-num "$QUEUE_NUM" --queue-bypass
    echo "[iptables-teardown] removed jump from $cmd $chain"
  done
}

IFS=',' read -r -a chains <<< "$CHAINS"
for chain in "${chains[@]}"; do
  chain_trimmed="$(echo "$chain" | tr -d '[:space:]')"
  [ -z "$chain_trimmed" ] && continue
  remove_jump "iptables" "$chain_trimmed"
  if [ "$IPV6" = "1" ]; then
    remove_jump "ip6tables" "$chain_trimmed"
  fi
done

echo "[iptables-teardown] done"
