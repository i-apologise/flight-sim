#!/usr/bin/env bash
# Local mirror of GitHub Actions integration job.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOGDIR="${TMPDIR:-/tmp}/flight-sim-ci-local"
mkdir -p "$LOGDIR"
PORT="${PORT:-8787}"
API="http://127.0.0.1:${PORT}"

cleanup() {
  if [[ -f "$LOGDIR/server.pid" ]]; then
    pid=$(cat "$LOGDIR/server.pid")
    kill "$pid" 2>/dev/null || true
    sleep 0.5
    kill -9 "$pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "Starting server on :$PORT ..."
STRESS_MAX_PLAYERS=32 TIER=public PORT="$PORT" \
  pnpm --filter @flight-sim/server-node start \
  >"$LOGDIR/server.log" 2>&1 &
echo $! >"$LOGDIR/server.pid"

for i in $(seq 1 40); do
  if curl -sf "$API/api/health" >/dev/null; then
    echo "Server healthy (${i}s)"
    break
  fi
  if [[ "$i" -eq 40 ]]; then
    echo "Server failed to start"
    cat "$LOGDIR/server.log" || true
    exit 1
  fi
  sleep 1
done

export API
pnpm --filter @flight-sim/loadtest test:sync
pnpm --filter @flight-sim/loadtest test:combat
pnpm --filter @flight-sim/loadtest test:stress-ci
echo "All integration tests passed."
