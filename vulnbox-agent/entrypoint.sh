#!/bin/sh
# vulnbox-agent runs two cooperating loops: ship.sh pushes eve/pcaps to the
# analysis box, pull-rules.sh polls the canonical local.rules and reloads
# Suricata on change. Both are independent; if one fails we want the other
# to keep going (and to surface the failure rather than silently restart
# only the dead loop).
set -eu

/usr/local/bin/ship.sh &
ship_pid=$!

if [ -n "${IRIS_API_BASE:-}" ]; then
  /usr/local/bin/pull-rules.sh &
  pull_pid=$!
else
  echo "[entrypoint] IRIS_API_BASE not set - rules-puller disabled"
  pull_pid=""
fi

# Forward signals so docker stop is clean.
trap 'kill ${ship_pid} ${pull_pid} 2>/dev/null || true' INT TERM

# wait -n returns the first child's exit; if either dies, exit so the
# container restart policy brings us back up fresh.
wait -n
status=$?
echo "[entrypoint] a child exited with $status; tearing down"
kill "${ship_pid}" ${pull_pid} 2>/dev/null || true
exit "$status"
