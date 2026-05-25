#!/usr/bin/env bash
# production_start.sh — infinite-loop launcher for the loopat production server.
#
# Designed to pair with simple_ci.sh:
#   simple_ci.sh  — polls git, builds on update, pkills the server process
#   production_start.sh — restarts the server whenever it exits (crash, CI kill, OOM)
#
# Usage:
#   ./scripts/production_start.sh           # foreground, logs to stdout
#   ./scripts/production_start.sh &         # background (or use a process manager)
#   LOG_FILE=/var/log/loopat.log ./scripts/production_start.sh   # custom log path
#
# Stop:  kill the script's pid. The script traps SIGTERM/SIGINT and stops the
#        running server before exiting.
#
# Env vars (all optional):
#   HOST                Bind address for main server (default: 0.0.0.0)
#   LOOPAT_SERVE_HOST   Bind address for workspace serve (default: 0.0.0.0)
#   LOG_FILE            Path to log file (default: .run/production.log)
#   RESTART_DELAY       Seconds to wait before restarting (default: 3)
#   BUILD_BEFORE_START  If set, run bun run build before starting

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_DIR="$REPO_ROOT/.run"

LOG_FILE="${LOG_FILE:-$RUN_DIR/production.log}"
RESTART_DELAY="${RESTART_DELAY:-3}"

export HOST="${HOST:-127.0.0.1}"
export LOOPAT_SERVE_HOST="${LOOPAT_SERVE_HOST:-127.0.0.1}"
export NODE_ENV=production

mkdir -p "$RUN_DIR"

log() { echo "[loopat $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# pid of the running server child (set in run_server, cleared on exit)
SERVER_PID=""

cleanup() {
  log "caught signal, shutting down..."
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    log "stopping server (pid $SERVER_PID)..."
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$SERVER_PID" 2>/dev/null; then
      log "server did not stop — SIGKILL"
      kill -KILL "$SERVER_PID" 2>/dev/null || true
    fi
  fi
  log "exiting"
  exit 0
}

trap cleanup SIGTERM SIGINT SIGHUP

run_server() {
  cd "$REPO_ROOT"

  if [[ -n "${BUILD_BEFORE_START:-}" ]]; then
    log "building before start..."
    bun install && (cd web && bun run build) || {
      log "BUILD FAILED — will retry on next loop iteration"
      return 1
    }
  fi

  log "starting server (HOST=$HOST NODE_ENV=$NODE_ENV)..."
  bun run server/src/index.ts &
  SERVER_PID=$!

  echo "$SERVER_PID" > "$RUN_DIR/server.pid"

  wait "$SERVER_PID" || true
  local exit_code=$?
  SERVER_PID=""

  log "server exited (code=${exit_code})"
  return 0
}

log "=== loopat production launcher starting (pid=$$) ==="
log "log file: $LOG_FILE"
log "restart delay: ${RESTART_DELAY}s"

iteration=0
while true; do
  iteration=$((iteration + 1))
  log "--- iteration $iteration ---"

  run_server

  log "restarting in ${RESTART_DELAY}s..."
  sleep "$RESTART_DELAY"
done
