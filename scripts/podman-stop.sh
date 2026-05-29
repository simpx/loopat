#!/usr/bin/env bash
# podman-stop.sh — 停止运行中的 loopat 容器
#
# 使用方式:
#   ./scripts/podman-stop.sh
#   LOOPAT_CONTAINER=my-loopat ./scripts/podman-stop.sh   # 指定容器名

set -euo pipefail

LOOPAT_CONTAINER="${LOOPAT_CONTAINER:-loopat-server}"

if podman container exists "$LOOPAT_CONTAINER" 2>/dev/null; then
    echo "正在停止容器 $LOOPAT_CONTAINER..."
    podman stop "$LOOPAT_CONTAINER" 2>/dev/null || true
    podman rm -f "$LOOPAT_CONTAINER" 2>/dev/null || true
    echo "✓ 容器已停止"
else
    echo "容器 $LOOPAT_CONTAINER 不存在"
fi
