#!/bin/bash
# The realistic concurrent browser group — the five Agent live suites launched
# in the same instant — with port state MEASURED from /proc/net/tcp.
#
# Run this only after the sequential battery is green: contention is a second
# question, not a substitute for the first. KEEP_DIST=1 reuses bundles the
# sequential run built, so the group measures runtime contention rather than
# five concurrent Vite builds.
#
# No sleep makes anything pass here. The only sleep is the observer's sampling
# interval, and the observer's held-port set should descend to [] as suites
# finish — that descent is the evidence.
#
#   bash e2e/tools/contention.sh
set -u
cd "$(dirname "$0")/.." || exit 1
TOOLS=./tools
OUT="${TMPDIR:-/tmp}/scoutbox-contention"
LISTEN="node $TOOLS/listeners.mjs"
rm -rf "$OUT"; mkdir -p "$OUT"

SUITES="m23AgentLive m23AgentComplianceLive m23AgentTransactionLive m23AgentIntegrationLive m23AgentGrassrootsLive"
# every API / static port the five suites bind (see each suite's header)
PORTS=4028,4029,4030,4040,4051,8728,8729,8730,8740,8828,8829,8830,8840,8851,8929,8930,9029,9030,9040,9140,9151

if command -v ss >/dev/null; then echo "note: ss exists on this host; still measuring from /proc so the result is comparable"; fi
echo "=== PRECONDITION ==="
held=$($LISTEN $PORTS)
[ -n "$held" ] && { echo "REFUSING: ports held -> $held (run: node $TOOLS/reap.mjs)"; exit 2; }
echo "ok — zero listeners on all contention ports (measured)"
echo "cpus=$(nproc) mem_avail_mb=$(free -m | awk '/^Mem:/{print $7}')"

T0=$(date +%s)
echo "GROUP START $(date -u +%H:%M:%SZ)"
for s in $SUITES; do
  ( st=$(date +%s)
    KEEP_DIST=1 timeout 1800 node "$s.test.mjs" > "$OUT/$s.log" 2>&1
    rc=$?
    echo "$s rc=$rc dur=$(( $(date +%s) - st ))s" > "$OUT/$s.result" ) &
done
( while [ "$(ls "$OUT"/*.result 2>/dev/null | wc -l)" -lt 5 ]; do
    printf '%s load=%s held=[%s]\n' "$(date -u +%H:%M:%S)" "$(cut -d' ' -f1 /proc/loadavg)" "$($LISTEN $PORTS)" >> "$OUT/observer.log"
    sleep 10
  done ) &
wait
echo "GROUP END   $(date -u +%H:%M:%SZ) wall=$(( $(date +%s) - T0 ))s"

echo "=== PER-SUITE ==="
fails=0
for s in $SUITES; do
  r=$(cat "$OUT/$s.result" 2>/dev/null || echo "$s NO RESULT"); echo "$r | $(grep -iE '[0-9]+ checks' "$OUT/$s.log" | tail -1 | cut -c1-70)"
  case "$r" in *"rc=0"*) ;; *) fails=$((fails+1));; esac
done
echo "=== PORT RELEASE (measured the instant the last suite exited) ==="
held=$($LISTEN $PORTS)
[ -n "$held" ] && { echo "!!! STILL HELD -> $held"; fails=$((fails+1)); } || echo "zero listeners on all contention ports"
echo "=== SURVIVORS ==="
node $TOOLS/survivors.mjs || fails=$((fails+1))
echo "=== OBSERVER ==="; cat "$OUT/observer.log"
[ $fails -eq 0 ] && echo "CONTENTION OK" || { echo "CONTENTION FAILED ($fails)"; exit 1; }
