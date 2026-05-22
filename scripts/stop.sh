#!/usr/bin/env bash
# Stop the loopat server started by scripts/start.sh.
# Kills the whole process group (bun run dev + its server/vite children).
set -euo pipefail
cd "$(dirname "$0")/.."

PID_FILE=.run/server.pid
[ -f "$PID_FILE" ] || { echo "not running (no $PID_FILE)"; exit 0; }
PID=$(cat "$PID_FILE")

if ! kill -0 "$PID" 2>/dev/null; then
  echo "stale pid $PID — removing pid file"
  rm "$PID_FILE"
  exit 0
fi

# Negative pid = process group. Catches bun + vite + server children.
kill -TERM -- -"$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true

for _ in $(seq 1 20); do
  kill -0 "$PID" 2>/dev/null || { rm "$PID_FILE"; echo "stopped"; exit 0; }
  sleep 0.25
done

echo "did not exit in 5s — SIGKILL"
kill -KILL -- -"$PID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null || true
rm "$PID_FILE"
echo "killed"
