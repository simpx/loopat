#!/usr/bin/env bash
# Launch loopat in the background (nohup'd `bun run dev`). pid → .run/server.pid,
# log → .run/server.log. Stop with scripts/stop.sh.
#
# bun --hot picks up file changes, so `git pull` is usually enough for an
# update — no restart needed. If a pull touches deps or schema, run
# scripts/stop.sh && scripts/start.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p .run
if [ -f .run/server.pid ] && kill -0 "$(cat .run/server.pid)" 2>/dev/null; then
  echo "already running (pid $(cat .run/server.pid)) — use scripts/stop.sh first"
  exit 1
fi

# Default LAN-accessible. Override with HOST=127.0.0.1 for local-only.
export HOST="${HOST:-0.0.0.0}"
export LOOPAT_SERVE_HOST="${LOOPAT_SERVE_HOST:-0.0.0.0}"

nohup bun run dev > .run/server.log 2>&1 &
echo $! > .run/server.pid

echo "loopat started"
echo "  pid:  $(cat .run/server.pid)"
echo "  log:  .run/server.log  (tail -f .run/server.log)"
echo "  stop: scripts/stop.sh"
