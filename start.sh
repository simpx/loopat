#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Building web frontend..."
cd web && bun run build && cd ..

echo "==> Starting server..."
exec bun run server/src/index.ts
