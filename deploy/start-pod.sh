#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NETWORK="${NETWORK:-bridge}"

HTTP_PROXY="${HTTP_PROXY:-${http_proxy:-}}"
HTTPS_PROXY="${HTTPS_PROXY:-${https_proxy:-}}"
NO_PROXY="${NO_PROXY:-${no_proxy:-}}"

SERVER_NAME="loopat-server"
BRIDGE_NET="loopat"
LOOPAT_IMAGE="${LOOPAT_IMAGE:-loopat:latest}"
LOOPAT_HOME="${LOOPAT_HOME:-$HOME/.loopat}"
PODMAN_SOCK="${PODMAN_SOCK:-/run/user/1000/podman/podman.sock}"

echo "=== loopat deploy ==="
echo "  network: $NETWORK"
echo "  data:    $LOOPAT_HOME"

if ! podman network exists "$BRIDGE_NET" 2>/dev/null; then
  podman network create "$BRIDGE_NET"
fi

if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  echo "  installing deps..."
  (cd "$PROJECT_DIR" && bun install --frozen-lockfile)
fi
if [ ! -d "$PROJECT_DIR/web/dist" ]; then
  echo "  building frontend..."
  (cd "$PROJECT_DIR/web" && bun run build)
fi

SERVE_BIN="$PROJECT_DIR/server/src/serve-rs/target/release/loopat-serve"
PORT_PROXY_BIN="$PROJECT_DIR/server/src/port-proxy-rs/target/release/loopat-port-proxy"

if podman container exists "$SERVER_NAME" 2>/dev/null; then
  echo "  stopping old server..."
  podman stop --time 5 "$SERVER_NAME" 2>/dev/null || true
  podman rm --force "$SERVER_NAME" 2>/dev/null || true
fi

if [ "$NETWORK" = "host" ]; then
  NET_ARGS=(--network host)
else
  NET_ARGS=(--network "$BRIDGE_NET" -p 7787:7787 -p 7788:7788)
fi

echo "  creating server..."
podman create \
  --name "$SERVER_NAME" \
  "${NET_ARGS[@]}" \
  --privileged \
  --init \
  -w "$PROJECT_DIR" \
  -v "$LOOPAT_HOME:$LOOPAT_HOME" \
  -v "$PROJECT_DIR:$PROJECT_DIR" \
  -v "$SERVE_BIN:/usr/local/bin/loopat-serve:ro" \
  -v "$PORT_PROXY_BIN:/usr/local/bin/loopat-port-proxy:ro" \
  -v "$PODMAN_SOCK:/run/podman/podman.sock" \
  -e "LOOPAT_HOME=$LOOPAT_HOME" \
  -e "LOOPAT_INSTALL_DIR=$PROJECT_DIR" \
  -e LOOPAT_POD_MODE=true \
  -e "LOOPAT_NETWORK_MODE=$NETWORK" \
  -e "CONTAINER_HOST=unix:///run/podman/podman.sock" \
  -e "HTTP_PROXY=$HTTP_PROXY" \
  -e "HTTPS_PROXY=$HTTPS_PROXY" \
  -e "http_proxy=$HTTP_PROXY" \
  -e "https_proxy=$HTTPS_PROXY" \
  -e "NO_PROXY=$NO_PROXY" \
  -e "no_proxy=$NO_PROXY" \
  "$LOOPAT_IMAGE"

podman start "$SERVER_NAME"

echo "=== ready ==="
echo "  logs: podman logs -f $SERVER_NAME"
