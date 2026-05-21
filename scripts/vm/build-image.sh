#!/usr/bin/env bash
# build-image.sh — Build the loopat Linux VM image for macOS Virtualization.framework
#
# Produces three files in src-tauri/resources/:
#   vmlinuz      – Linux kernel binary
#   initrd        – Initial RAM disk
#   rootfs.img.gz – Compressed root filesystem (ext4 disk image)
#
# Requirements:
#   - Docker Desktop (with buildx + privileged containers)
#   - macOS host (Apple Silicon or Intel)
#
# Usage:
#   scripts/vm/build-image.sh [--no-compress]

set -euo pipefail
cd "$(dirname "$0")/../.."

# ── Config ─────────────────────────────────────────────────────────────────
ROOTFS_SIZE_MB=4096          # Size of the rootfs disk image
OUTPUT_DIR="src-tauri/resources"
IMAGE_TAG="loopat-vm:latest"

# Detect host architecture
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  DOCKER_PLATFORM="linux/arm64"
else
  DOCKER_PLATFORM="linux/amd64"
fi

echo "▶ Building VM image for platform: $DOCKER_PLATFORM"
echo "  Output: $OUTPUT_DIR/"
echo ""

mkdir -p "$OUTPUT_DIR"

# Allow forcing a clean rebuild (bypasses Docker layer cache)
NO_CACHE_FLAG=""
if [[ "${1:-}" == "--no-cache" ]] || [[ "${2:-}" == "--no-cache" ]]; then
  NO_CACHE_FLAG="--no-cache"
  echo "  ⚠  --no-cache: forcing full rebuild"
fi

# ── Step 1: Build the Docker image ──────────────────────────────────────────
echo "▶ Step 1/4 — Building Docker image (this may take several minutes)…"
docker buildx build \
  $NO_CACHE_FLAG \
  --platform "$DOCKER_PLATFORM" \
  --build-arg "PLATFORM=$DOCKER_PLATFORM" \
  -t "$IMAGE_TAG" \
  -f scripts/vm/Dockerfile \
  --load \
  .
echo "  ✓ Docker image built"

# ── Step 2: Extract kernel and initrd ────────────────────────────────────────
echo "▶ Step 2/4 — Extracting kernel and initrd…"

# Verify files exist in the image before extracting
echo "  Verifying /boot contents in image…"
docker run --rm --platform "$DOCKER_PLATFORM" "$IMAGE_TAG" ls -lh /boot/vmlinuz-real /boot/initrd-real \
  || { echo "ERROR: vmlinuz-real or initrd-real missing from image — check Dockerfile RUN output above"; exit 1; }

# Remove any stale symlinks or files from prior failed runs before writing
rm -f "$OUTPUT_DIR/vmlinuz" "$OUTPUT_DIR/initrd"

# Use 'docker run cat' instead of 'docker cp': avoids symlink issues and works reliably
docker run --rm --platform "$DOCKER_PLATFORM" "$IMAGE_TAG" cat /boot/vmlinuz-real > "$OUTPUT_DIR/vmlinuz"
docker run --rm --platform "$DOCKER_PLATFORM" "$IMAGE_TAG" cat /boot/initrd-real  > "$OUTPUT_DIR/initrd"
echo "  ✓ Kernel: $(ls -lh $OUTPUT_DIR/vmlinuz | awk '{print $5}')"
echo "  ✓ Initrd: $(ls -lh $OUTPUT_DIR/initrd | awk '{print $5}')"

# ── Step 3: Create ext4 disk image from container filesystem ─────────────────
echo "▶ Step 3/4 — Creating rootfs disk image (${ROOTFS_SIZE_MB}MB)…"
echo "  (Requires privileged Docker container for loop mount)"

# Export container filesystem as tar (create a throwaway container for export)
ROOTFS_TAR=$(mktemp /tmp/loopat-rootfs-XXXXXX.tar)
CONTAINER=$(docker create --platform "$DOCKER_PLATFORM" "$IMAGE_TAG")
cleanup_all() { docker rm -f "$CONTAINER" 2>/dev/null || true; rm -f "$ROOTFS_TAR"; }
trap cleanup_all EXIT

docker export "$CONTAINER" > "$ROOTFS_TAR"
echo "  ✓ Filesystem exported ($(ls -lh "$ROOTFS_TAR" | awk '{print $5}'))"

# Use a privileged Alpine container to create the ext4 image
# (macOS cannot create ext4 images natively)
ABS_OUTPUT=$(cd "$OUTPUT_DIR" && pwd)
ABS_TAR=$(readlink -f "$ROOTFS_TAR")

docker run --privileged --rm \
  --platform "$DOCKER_PLATFORM" \
  -v "$ABS_OUTPUT:/output" \
  -v "$ABS_TAR:/rootfs.tar:ro" \
  alpine:latest \
  sh -c "
    set -e
    apk add --no-cache e2fsprogs e2fsprogs-extra >/dev/null 2>&1

    echo '  Creating ext4 image...'
    dd if=/dev/zero of=/output/rootfs.img bs=1M count=${ROOTFS_SIZE_MB} status=none
    mkfs.ext4 -F -L loopat-root /output/rootfs.img >/dev/null 2>&1

    echo '  Populating filesystem...'
    mkdir -p /mnt
    mount -o loop /output/rootfs.img /mnt

    # Extract — exclude dev/ (recreated at runtime) and proc/sys
    tar -C /mnt -xf /rootfs.tar \
      --exclude='./dev/*' \
      --exclude='./proc/*' \
      --exclude='./sys/*' \
      2>/dev/null || true

    # Ensure required dirs exist
    mkdir -p /mnt/proc /mnt/sys /mnt/dev /mnt/run /mnt/tmp
    mkdir -p /mnt/home/loopat/.loopat

    umount /mnt
    echo '  Filesystem populated'
  "

ROOTFS_IMG="$OUTPUT_DIR/rootfs.img"
echo "  ✓ Rootfs image: $(ls -lh "$ROOTFS_IMG" | awk '{print $5}')"

# ── Step 4: Compress ─────────────────────────────────────────────────────────
if [[ "${1:-}" != "--no-compress" ]]; then
  echo "▶ Step 4/4 — Compressing rootfs (gzip)…"
  gzip -9 --force "$ROOTFS_IMG"
  echo "  ✓ Compressed: $(ls -lh "${ROOTFS_IMG}.gz" | awk '{print $5}')"
else
  echo "▶ Step 4/4 — Skipping compression (--no-compress)"
fi

echo ""
echo "✅ VM image build complete!"
echo ""
echo "Files in $OUTPUT_DIR/:"
ls -lh "$OUTPUT_DIR"/vmlinuz "$OUTPUT_DIR"/initrd "$OUTPUT_DIR"/rootfs.img* 2>/dev/null | awk '{print "  " $5 "\t" $9}'
echo ""
echo "Next steps:"
echo "  1. Build Tauri app: cd src-tauri && cargo tauri build"
echo "     (Requires Rust: https://rustup.rs)"
echo ""
echo "  Note: The Tauri app uses Virtualization.framework natively —"
echo "  no need to install vfkit."
