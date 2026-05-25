#!/usr/bin/env bash
# stop_all.sh — kill every loopat-related process on this host.
#
# Pairs with production_start.sh / start.sh. Targets:
#   1. production_start.sh wrapper (else it'll relaunch the server we kill)
#   2. dev/prod server tree under this repo (bun run dev → --hot index.ts +
#      vite, or bun run server/src/index.ts)
#   3. sandboxed loop processes (bwrap) whose bind args reference LOOPAT_HOME
#
# Conservative by design: matches only on absolute paths into this repo or
# LOOPAT_HOME, never blindly `pkill bun` / `pkill claude` — you might run
# unrelated bun or claude sessions on the same machine.
#
# Usage:
#   ./scripts/stop_all.sh           # SIGTERM, escalate to SIGKILL after 7.5s
#   ./scripts/stop_all.sh --dry-run # list what would be killed, take no action
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOOPAT_HOME_DIR="${LOOPAT_HOME:-$HOME/.loopat}"

DRY_RUN=0
[[ "${1:-}" == "--dry-run" || "${1:-}" == "-n" ]] && DRY_RUN=1

# Absolute-path-anchored command-line patterns — catch anything whose cmd
# string itself names this repo or LOOPAT_HOME (vite spawn, bwrap binds, etc.)
PATTERNS=(
  "${REPO_ROOT}/scripts/production_start\\.sh"
  "${REPO_ROOT}.*server/src/index\\.ts"
  "${REPO_ROOT}/web/node_modules/.*vite"
  "bwrap.*${LOOPAT_HOME_DIR}"
)

# Collect pids: cmd-pattern matches + cwd matches + pid file. Dedup at end.
pids=()

# (a) Command-line pattern matches
for pat in "${PATTERNS[@]}"; do
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && pids+=("$pid")
  done < <(pgrep -f -- "$pat" || true)
done

# (b) Procs whose cwd lives inside the repo — catches `bun run dev` started
#     from the repo root, since the bun cmd line itself has no absolute
#     paths. Also picks up child bun --hot procs which inherit the cwd.
for proc_cwd in /proc/[0-9]*/cwd; do
  pid="${proc_cwd#/proc/}"; pid="${pid%/cwd}"
  resolved="$(readlink -f "$proc_cwd" 2>/dev/null || true)"
  [[ -z "$resolved" ]] && continue
  if [[ "$resolved" == "$REPO_ROOT" || "$resolved" == "$REPO_ROOT"/* ]]; then
    # Filter to actual loopat-process names so we don't match unrelated
    # editors / shells someone has open in this dir.
    # Whitelist of process names that belong to the dev/prod server tree.
    # Notably NOT `claude` — that's the user's interactive CLI session; loopat
    # itself only spawns CC via bwrap, which is caught by the cmd-line pattern.
    comm="$(cat /proc/"$pid"/comm 2>/dev/null || true)"
    case "$comm" in
      bun|node|vite) pids+=("$pid") ;;
    esac
  fi
done

# (c) Pid file (start.sh / production_start.sh writes it)
if [[ -f "$REPO_ROOT/.run/server.pid" ]]; then
  pid_from_file="$(cat "$REPO_ROOT/.run/server.pid" 2>/dev/null || true)"
  [[ -n "${pid_from_file:-}" ]] && pids+=("$pid_from_file")
fi

# Filter: skip ourselves, skip non-existent pids
me="$$"
uniq_pids=()
declare -A seen=()
for pid in "${pids[@]}"; do
  [[ "$pid" == "$me" ]] && continue
  [[ -n "${seen[$pid]:-}" ]] && continue
  kill -0 "$pid" 2>/dev/null || continue
  seen[$pid]=1
  uniq_pids+=("$pid")
done

if [[ ${#uniq_pids[@]} -eq 0 ]]; then
  echo "no loopat processes found"
  rm -f "$REPO_ROOT/.run/server.pid"
  exit 0
fi

echo "found ${#uniq_pids[@]} pid(s):"
ps -o pid,ppid,pgid,etime,cmd -p "${uniq_pids[@]}" 2>/dev/null || true

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo
  echo "(dry-run — no signals sent)"
  exit 0
fi

echo
echo "sending SIGTERM..."
for pid in "${uniq_pids[@]}"; do
  kill -TERM "$pid" 2>/dev/null || true
done

# Poll up to 7.5s for graceful exit.
for _ in $(seq 1 30); do
  still=()
  for pid in "${uniq_pids[@]}"; do
    kill -0 "$pid" 2>/dev/null && still+=("$pid")
  done
  if [[ ${#still[@]} -eq 0 ]]; then
    rm -f "$REPO_ROOT/.run/server.pid"
    echo "all stopped"
    exit 0
  fi
  sleep 0.25
done

echo "${#still[@]} pid(s) didn't exit in 7.5s — SIGKILL: ${still[*]}"
for pid in "${still[@]}"; do
  kill -KILL "$pid" 2>/dev/null || true
done

rm -f "$REPO_ROOT/.run/server.pid"
echo "killed"
