#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
TARGET_BRANCH_FILE="$HOME/.loopat/personal/panlilu/target_branch"
SLEEP_SEC=300

log() { echo "[ci $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

cd "$REPO_ROOT"

while true; do
  branch="main"
  if [[ -f "$TARGET_BRANCH_FILE" ]]; then
    branch="$(< "$TARGET_BRANCH_FILE")"
    branch="${branch:-main}"
  fi

  log "checking branch: $branch"

  git fetch origin "$branch" 2>&1 | tail -1 || { log "fetch failed, will retry"; sleep "$SLEEP_SEC"; continue; }

  local_sha=$(git rev-parse "$branch" 2>/dev/null || echo "")
  remote_sha=$(git rev-parse "origin/$branch" 2>/dev/null || echo "")

  if [[ -z "$local_sha" ]]; then
    log "local branch $branch does not exist, creating from origin/$branch"
    git checkout -b "$branch" "origin/$branch"
    bash "$REPO_ROOT/build-to-nginx.sh"
    pkill -f "bun run server/src/index.ts" 2>/dev/null || true
    log "deployed $remote_sha, server restart signaled"
  elif [[ "$local_sha" != "$remote_sha" ]]; then
    log "update detected: $local_sha -> $remote_sha"
    git checkout "$branch"
    git reset --hard "origin/$branch"
    bash "$REPO_ROOT/build-to-nginx.sh"
    pkill -f "bun run server/src/index.ts" 2>/dev/null || true
    log "deployed $remote_sha, server restart signaled"
  else
    log "up to date at $local_sha"
  fi

  sleep "$SLEEP_SEC"
done
