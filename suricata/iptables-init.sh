#!/bin/bash
# Idempotently install an NFQUEUE jump on the chosen chains so Suricata (IPS)
# can see and optionally drop traffic.
#
# Environment:
#   NFQUEUE_NUM     Queue number (default: 0).
#   NFQUEUE_IFACE   Match only this interface (default: unset = all).
#                   Applied as -i for ingress chains (PREROUTING, INPUT,
#                   FORWARD, DOCKER-USER) and as -o for egress chains
#                   (POSTROUTING, OUTPUT).
#   NFQUEUE_CHAINS  Comma-separated chain specs. Each spec is either a
#                   chain name (default table = filter) or table:chain.
#                   Use `raw:PREROUTING` to capture pre-NAT traffic so
#                   iris flows show original gamenet IPs instead of the
#                   docker-internal post-DNAT addresses.
#                   Default: INPUT,FORWARD,DOCKER-USER.
#   NFQUEUE_IPV6    If "1" also install on ip6tables (default: 1).
#   NFQUEUE_SKIP_PORTS  Comma-separated TCP/UDP ports that bypass NFQUEUE
#                   entirely. RETURN rules installed BEFORE the NFQUEUE
#                   jump so these packets never reach Suricata, never get
#                   pcap-logged, and never feed into iris. Most importantly:
#                   even if Suricata wedges (not just crashes), traffic on
#                   these ports keeps flowing. Default: "22,53,123,1900,5353"
#                   (SSH, DNS, NTP, SSDP, mDNS - all noise + the lifeline).
#                   Set to empty string to disable skipping.
#
# Safety:
#   Always uses --queue-bypass so a Suricata crash does not take traffic down.
#   Always runs `-C` first to avoid duplicate rules on restart.
set -eu

QUEUE_NUM="${NFQUEUE_NUM:-0}"
IFACE="${NFQUEUE_IFACE:-}"
CHAINS="${NFQUEUE_CHAINS:-INPUT,FORWARD,DOCKER-USER}"
IPV6="${NFQUEUE_IPV6:-1}"
SKIP_PORTS="${NFQUEUE_SKIP_PORTS-22,53,123,1900,5353}"

# Egress chains apply iface as -o; ingress chains apply iface as -i.
# Chains not in this set default to -i (covers FORWARD, INPUT, PREROUTING,
# DOCKER-USER, ...).
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
  local table="$2"
  local chain="$3"
  local iface_args
  iface_args="$(iface_args_for "$chain")"
  if ! $cmd -t "$table" -L "$chain" >/dev/null 2>&1; then
    echo "[iptables-init] chain $table:$chain not present for $cmd, skipping"
    return 0
  fi
  # shellcheck disable=SC2086
  if $cmd -t "$table" -C "$chain" $iface_args -j NFQUEUE --queue-num "$QUEUE_NUM" --queue-bypass 2>/dev/null; then
    echo "[iptables-init] jump already present on $cmd $table:$chain"
  else
    # shellcheck disable=SC2086
    $cmd -t "$table" -I "$chain" $iface_args -j NFQUEUE --queue-num "$QUEUE_NUM" --queue-bypass
    echo "[iptables-init] installed jump on $cmd $table:$chain $iface_args (queue $QUEUE_NUM, bypass on)"
  fi
}

# Each spec is either `chain` (default table = filter) or `table:chain`.
parse_spec() {
  local spec="$1"
  if [[ "$spec" == *:* ]]; then
    echo "${spec%%:*} ${spec##*:}"
  else
    echo "filter $spec"
  fi
}

# RETURN rules for skip ports go *above* the NFQUEUE jump so matching
# traffic short-circuits and never reaches Suricata. Inserts at position
# 1; the jump (already at position 1 from install_jump) gets pushed down.
# Uses multiport so a single rule covers both src and dst ports for a
# protocol, which is what we want for symmetric protocols like SSH.
install_skip() {
  local cmd="$1"
  local table="$2"
  local chain="$3"
  if [ -z "$SKIP_PORTS" ]; then return 0; fi
  if ! $cmd -t "$table" -L "$chain" >/dev/null 2>&1; then
    return 0  # install_jump already warned
  fi
  for proto in tcp udp; do
    if $cmd -t "$table" -C "$chain" -p "$proto" -m multiport --ports "$SKIP_PORTS" -j RETURN 2>/dev/null; then
      echo "[iptables-init] skip already present on $cmd $table:$chain $proto $SKIP_PORTS"
    else
      $cmd -t "$table" -I "$chain" 1 -p "$proto" -m multiport --ports "$SKIP_PORTS" -j RETURN
      echo "[iptables-init] installed skip on $cmd $table:$chain $proto for ports $SKIP_PORTS"
    fi
  done
}

IFS=',' read -r -a chains <<< "$CHAINS"
for spec in "${chains[@]}"; do
  spec_trimmed="$(echo "$spec" | tr -d '[:space:]')"
  [ -z "$spec_trimmed" ] && continue
  read -r table chain <<< "$(parse_spec "$spec_trimmed")"
  # Order matters: install JUMP first, then SKIP. Skip rules use -I 1 and
  # push the jump down to position 2+, so a matching skip-port packet
  # RETURNS before iptables walks down to the NFQUEUE jump.
  install_jump "$IPT4" "$table" "$chain"
  install_skip "$IPT4" "$table" "$chain"
  if [ "$IPV6" = "1" ]; then
    install_jump "$IPT6" "$table" "$chain"
    install_skip "$IPT6" "$table" "$chain"
  fi
done

echo "[iptables-init] done"
