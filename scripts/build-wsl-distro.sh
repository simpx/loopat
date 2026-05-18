#!/usr/bin/env bash
# Build a WSL2-compatible distro tar containing the loopat stack.
#
# Prerequisites: Docker, dist/ directory from `bun run build:binary`
# Output:         dist-windows/loopat-wsl.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="$PWD/dist-windows/loopat-wsl.tar.gz"
mkdir -p dist-windows

BUILD_DIR=$(mktemp -d)
cp dist/loopat          "$BUILD_DIR/loopat-server"
cp dist/loopat-sandbox  "$BUILD_DIR/loopat-sandbox"
cp dist/claude          "$BUILD_DIR/claude"

echo "==> Building WSL distro rootfs..."

cat > "$BUILD_DIR/Dockerfile" <<'DOCKERFILE'
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    LOOPAT_SERVE_HOST=0.0.0.0

# Basic tools + bubblewrap
RUN apt-get update && apt-get install -y --no-install-recommends \
    bubblewrap \
    ca-certificates \
    bash \
    coreutils \
    util-linux \
    procps \
    sudo \
    openssh-client \
    git \
    fish \
    vim \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set up non-root loopat user (mirrors root Dockerfile)
RUN groupadd -r loopat \
    && useradd -m -g loopat -G sudo -s /bin/bash loopat \
    && echo "loopat ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/loopat \
    && chmod 0440 /etc/sudoers.d/loopat

# suid bwrap so loopat (non-root) can create user/mount namespaces
RUN chmod u+s /usr/bin/bwrap

# Install loopat binaries
COPY loopat-server   /opt/loopat/loopat-server
COPY loopat-sandbox  /opt/loopat/loopat-sandbox
COPY claude          /opt/loopat/claude
RUN chmod +x /opt/loopat/*

# Version identifier (written by build script)
ARG WSL_VERSION
RUN echo "$WSL_VERSION" > /opt/loopat/.wsl-version

# Ensure standard mount points + data volume
RUN mkdir -p /tmp /proc /dev /sys /home/loopat/.loopat

CMD ["/opt/loopat/loopat-server"]
DOCKERFILE

WSL_VERSION="${WSL_VERSION:-$(date +%Y%m%d%H%M%S)}"
echo "$WSL_VERSION" > "$OUT.version"
echo "==> WSL distro version: $WSL_VERSION"

docker build \
  --build-arg WSL_VERSION="$WSL_VERSION" \
  --tag loopat-wsl:latest "$BUILD_DIR" 2>&1

echo "==> Exporting rootfs..."
docker container create --name loopat-wsl-tmp loopat-wsl:latest > /dev/null
docker export loopat-wsl-tmp | gzip > "$OUT"
docker container rm loopat-wsl-tmp > /dev/null

rm -rf "$BUILD_DIR"
echo "==> WSL distro: $(ls -lh "$OUT" | awk '{print $5}')  $OUT"
