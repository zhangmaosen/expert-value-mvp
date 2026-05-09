#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-3000}"
HEARTBEAT_SEC="${HEARTBEAT_SEC:-8}"

cd "$(dirname "$0")/.."

./node_modules/.bin/next dev --hostname "$HOST" --port "$PORT" &
NEXT_PID=$!

cleanup() {
  if kill -0 "$NEXT_PID" 2>/dev/null; then
    kill "$NEXT_PID" 2>/dev/null || true
    wait "$NEXT_PID" 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

echo "[dev-stable] next dev started on http://$HOST:$PORT (pid=$NEXT_PID)"

while kill -0 "$NEXT_PID" 2>/dev/null; do
  echo "[dev-stable] heartbeat $(date '+%H:%M:%S')"
  sleep "$HEARTBEAT_SEC"
done

wait "$NEXT_PID"