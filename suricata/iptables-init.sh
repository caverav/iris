#!/bin/bash
# Idempotently install an NFQUEUE jump on the chosen chains so Suricata (IPS)
# can see and optionally drop traffic.
#
# Environment:
#   NFQUEUE_NUM     Queue number (default: 0).
#   NFQUEUE_IFACE   Match only this interface (default: unset = all).
#   NFQUEUE_CHAINS  Comma-separated chains (default: INPUT,FORWARD,DOCKER-USER).
#   NFQUEUE_IPV6    If "1" also install on ip6tables (default: 1).
#
# Safety:
#   Always uses --queue-bypass so a Suricata crash does not take traffic down.
#   Always runs `-C` first to avoid duplicate rules on restart.
set -eu

QUEUE_NUM="${NFQUEUE_NUM:-0}"
IFACE="${NFQUEUE_IFACE:-}"
CHAINS="${NFQUEUE_CHAINS:-INPUT,FORWARD,DOCKER-USER}"
IPV6="${NFQUEUE_IPV6:-1}"

iface_args=""
if [ -n "$IFACE" ]; then
  iface_args="-i $IFACE"
fi

# Pick whichever iptables backend the host kernel is using. The image ships
# both iptables-nft and iptables-legacy; the inactive one returns an empty
# rule set. Compare rule counts and prefer the one with rules. Default to
# nft on tie, since modern distros (RHEL 9+, Ubuntu 22.04+, NixOS, ...) all
# use nft. Same trick as kubernetes-sigs/iptables-wrappers.
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
echo "[iptables-init] using host backend: $BACKEND ($IPT4 / $IPT6)"

install_jump() {
  local cmd="$1"
  local chain="$2"
  if ! $cmd -L "$chain" >/dev/null 2>&1; then
    echo "[iptables-init] chain $chain not present for $cmd, skipping"
    return 0
  fi
  # shellcheck disable=SC2086
  if $cmd -C "$chain" $iface_args -j NFQUEUE --queue-num "$QUEUE_NUM" --queue-bypass 2>/dev/null; then
    echo "[iptables-init] jump already present on $cmd $chain"
  else
    # shellcheck disable=SC2086
    $cmd -I "$chain" $iface_args -j NFQUEUE --queue-num "$QUEUE_NUM" --queue-bypass
    echo "[iptables-init] installed jump on $cmd $chain (queue $QUEUE_NUM, bypass on)"
  fi
}

IFS=',' read -r -a chains <<< "$CHAINS"
for chain in "${chains[@]}"; do
  chain_trimmed="$(echo "$chain" | tr -d '[:space:]')"
  [ -z "$chain_trimmed" ] && continue
  install_jump "$IPT4" "$chain_trimmed"
  if [ "$IPV6" = "1" ]; then
    install_jump "$IPT6" "$chain_trimmed"
  fi
done

echo "[iptables-init] done"
