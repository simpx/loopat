#!/usr/bin/env bash
cd "$(dirname "$0")/.."

while true; do
  echo "==> Starting server... ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  bun run server/src/index.ts || true
  echo "==> Server exited. Restarting in 3s..."
  sleep 3
done
