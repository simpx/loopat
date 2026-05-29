#!/usr/bin/env bash
# podman-start.sh — 以 podman 容器方式运行 loopat 主程序
#
# 这个脚本会：
# 1. 检查 loopat-server 镜像是否存在，不存在则构建
# 2. 以 rootless podman 方式启动容器 (uid 2000, --userns keep-id)
# 3. 将主机的 .loopat 和代码目录挂载到容器 (保持路径一致)
# 4. 注入 podman socket 使服务器可以控制外部 podman daemon
#
# 使用方式:
#   ./scripts/podman-start.sh                    # 基本用法
#   APT_MIRROR=mirrors.tuna.tsinghua.edu.cn ./scripts/podman-start.sh   # 国内 apt 源
#   LOOPAT_HOME=/custom/path ./scripts/podman-start.sh                  # 自定义数据目录
#   DOCKER_MIRROR=docker.m.daocloud.io ./scripts/podman-start.sh        # docker-io 镜像
#
# 环境变量:
#   LOOPAT_HOME        loopat 数据目录位置 (默认: ~/.loopat)
#   LOOPAT_CODE_DIR    loopat 代码目录位置 (默认: 脚本所在目录的父目录)
#   APT_MIRROR         Debian apt 镜像源
#   DOCKER_MIRROR      Docker Hub 镜像源
#   LOOPAT_PORT        HTTP 服务端口 (默认: 7787)
#   LOOPAT_IMAGE       容器镜像名称 (默认: loopat-server:latest)
#   LOOPAT_CONTAINER   容器名称 (默认: loopat-server)

set -euo pipefail

cd "$(dirname "$0")/.."

# 默认值
CODE_DIR="${LOOPAT_CODE_DIR:-.}"
LOOPAT_HOME="${LOOPAT_HOME:-$HOME/.loopat}"
LOOPAT_PORT="${LOOPAT_PORT:-7787}"
LOOPAT_IMAGE="${LOOPAT_IMAGE:-loopat-server:latest}"
LOOPAT_CONTAINER="${LOOPAT_CONTAINER:-loopat-server}"
WORKSPACE_NAME="${WORKSPACE:-$(basename "$LOOPAT_HOME" | sed 's/^\.*//')}"
[[ -z "$WORKSPACE_NAME" ]] && WORKSPACE_NAME="loopat"
APT_MIRROR="${APT_MIRROR:-}"
DOCKER_MIRROR="${DOCKER_MIRROR:-}"

# 检查 podman 是否可用
if ! command -v podman >/dev/null 2>&1; then
    echo "错误: 找不到 podman 命令"
    echo "请先安装 podman: sudo apt install podman uidmap slirp4netns"
    exit 1
fi

# 检查代码目录
REPO_ROOT="$(cd "$CODE_DIR" && pwd)"
if [[ ! -f "$REPO_ROOT/server/src/index.ts" ]]; then
    echo "错误: $REPO_ROOT 不是有效的 loopat 代码目录"
    echo "请设置 LOOPAT_CODE_DIR 指向 loopat 代码根目录"
    exit 1
fi

# 检查 .loopat 目录（如果不存在就创建）
if [[ -d "$LOOPAT_HOME" ]]; then
    LOOPAT_HOME="$(cd "$LOOPAT_HOME" && pwd)"
else
    mkdir -p "$LOOPAT_HOME"
    echo "已创建 $LOOPAT_HOME 目录"
fi

# 检查是否已经有同名容器在运行
if podman ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${LOOPAT_CONTAINER}$"; then
    echo "警告: 容器 '$LOOPAT_CONTAINER' 已存在"
    read -p "是否停止并删除它重新启动? [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        podman stop "$LOOPAT_CONTAINER" 2>/dev/null || true
        podman rm -f "$LOOPAT_CONTAINER" 2>/dev/null || true
    else
        echo "取消启动"
        exit 1
    fi
fi

# 构建镜像（如果不存在）
if ! podman image exists "$LOOPAT_IMAGE" 2>/dev/null; then
    echo "正在构建 $LOOPAT_IMAGE 镜像..."
    BUILD_ARGS=(-t "$LOOPAT_IMAGE" -f "$REPO_ROOT/server/templates/loopat-server/Containerfile")

    [[ -n "$APT_MIRROR" ]] && BUILD_ARGS+=(--build-arg "APT_MIRROR=$APT_MIRROR")
    [[ -n "$DOCKER_MIRROR" ]] && BUILD_ARGS+=(--build-arg "DOCKER_MIRROR=$DOCKER_MIRROR")

    if ! podman build "${BUILD_ARGS[@]}" "$REPO_ROOT"; then
        echo "错误: 镜像构建失败"
        exit 1
    fi
    echo "镜像构建完成: $LOOPAT_IMAGE"
fi

# 检查 podman network 是否存在（sandbox 需要用这个网络）
if ! podman network exists loopat 2>/dev/null; then
    echo "正在创建 podman network: loopat"
    podman network create loopat
fi

# 确定 loopat 容器本身的监听地址（主服务器和 serve）
LOOPAT_HOST="${LOOPAT_HOST:-0.0.0.0}"
LOOPAT_SERVE_HOST="${LOOPAT_SERVE_HOST:-0.0.0.0}"
LOOPAT_SERVE_PORT="${LOOPAT_SERVE_PORT:-7788}"

# 查找宿主机的 podman socket 用于注入
HOST_PODMAN_SOCK=""
if [[ -S "/run/user/$(id -u)/podman/podman.sock" ]]; then
    HOST_PODMAN_SOCK="/run/user/$(id -u)/podman/podman.sock"
elif [[ -S "/var/run/docker.sock" ]]; then
    # Docker socket (通过 podman-docker 或真实 docker)
    HOST_PODMAN_SOCK="/var/run/docker.sock"
elif [[ -S "/run/podman/podman.sock" ]]; then
    HOST_PODMAN_SOCK="/run/podman/podman.sock"
fi

# 启动容器
echo "正在启动 loopat 容器..."
echo "  容器名称: $LOOPAT_CONTAINER"
echo "  镜像: $LOOPAT_IMAGE"
echo "  代码目录: $REPO_ROOT"
echo "  数据目录: $LOOPAT_HOME"
echo "  HTTP 端口: $LOOPAT_PORT"
echo "  Serve 端口: $LOOPAT_SERVE_PORT"
if [[ -n "$HOST_PODMAN_SOCK" ]]; then
    echo "  Podman socket: $HOST_PODMAN_SOCK (注入)"
else
    echo "  Podman socket: 未找到 (sandbox 功能受限)"
fi

PODMAN_RUN_ARGS=(
    # -d
    --name "$LOOPAT_CONTAINER"
    --userns "keep-id:uid=2000,gid=2000"
    --network loopat
    --hostname "loop-$WORKSPACE_NAME"
    -p "0.0.0.0:${LOOPAT_PORT}:7787"
    -p "0.0.0.0:${LOOPAT_SERVE_PORT}:7788"
    -e "LOOPAT_HOME=$LOOPAT_HOME"
    -e "LOOPAT_INSTALL_DIR=$REPO_ROOT"
    -e "HOST=$LOOPAT_HOST"
    -e "LOOPAT_SERVE_HOST=$LOOPAT_SERVE_HOST"
    -e "LOOPAT_SERVE_PORT=$LOOPAT_SERVE_PORT"
)

# 挂载代码目录 (容器内路径与宿主机相同，sandbox 才能找到 LOOPAT_INSTALL_DIR)
PODMAN_RUN_ARGS+=(-v "$REPO_ROOT:$REPO_ROOT")

# 挂载 .loopat 数据目录 (容器内路径与宿主机相同)
PODMAN_RUN_ARGS+=(-v "$LOOPAT_HOME:$LOOPAT_HOME")

# 挂载宿主机的 home 目录 (用于 sandbox 创建时访问 ~/.claude 等文件)
PODMAN_RUN_ARGS+=(-v "$HOME:$HOME:ro")

# 注入 podman socket (让容器内代码能控制宿主机 podman daemon)
if [[ -n "$HOST_PODMAN_SOCK" ]]; then
    PODMAN_RUN_ARGS+=(-v "${HOST_PODMAN_SOCK}:${HOST_PODMAN_SOCK}")
fi

podman run "${PODMAN_RUN_ARGS[@]}" "$LOOPAT_IMAGE"

echo ""
echo "✓ Loopat 容器已启动"
echo "  访问地址: http://0.0.0.0:${LOOPAT_PORT}"
echo "  容器日志: podman logs -f $LOOPAT_CONTAINER"
echo "  停止命令: ./scripts/podman-stop.sh"
