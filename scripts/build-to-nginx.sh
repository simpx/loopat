#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${NGINX_ROOT:-/var/www/loopat}"

echo "==> Installing dependencies..."
(cd server && bun install)
(cd web && bun install)

echo "==> Building web frontend..."
(cd web && bun run build)

echo "==> Copying to $TARGET ..."
sudo mkdir -p "$TARGET"
sudo rm -rf "$TARGET"/*
sudo cp -r web/dist/* "$TARGET"/

echo "==> Done. Files in $TARGET:"
ls -lh "$TARGET"
