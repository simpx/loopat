#!/usr/bin/env bash
# prepare-resources.sh — Collect VM image files into src-tauri/resources/
#
# Run this BEFORE `cargo tauri build` to ensure all required files are present.
# The script is idempotent — skips files that already exist.
#
# Usage:
#   scripts/vm/prepare-resources.sh
#
# Note: vfkit is no longer needed — the Tauri app uses Virtualization.framework
# natively via an ObjC bridge compiled into the Rust binary.

set -euo pipefail
cd "$(dirname "$0")/../.."

RESOURCES="src-tauri/resources"

mkdir -p "$RESOURCES"

log() { echo "  [prepare] $*"; }

# ── VM image files (kernel, initrd, rootfs) ───────────────────────────────────
# These are produced by `scripts/vm/build-image.sh`. If they're missing,
# tell the user to run that first.
MISSING=()
for f in vmlinuz initrd rootfs.img.gz; do
  if [[ ! -f "$RESOURCES/$f" ]]; then
    MISSING+=("$f")
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo ""
  echo "⚠️  Missing VM image files in $RESOURCES/:"
  for f in "${MISSING[@]}"; do
    echo "     - $f"
  done
  echo ""
  echo "   Run first:  bun run build:vm"
  echo "   (or: scripts/vm/build-image.sh)"
  echo ""
  exit 1
fi

log "✓ vmlinuz present ($(ls -lh "$RESOURCES/vmlinuz" | awk '{print $5}'))"
log "✓ initrd present ($(ls -lh "$RESOURCES/initrd" | awk '{print $5}'))"
log "✓ rootfs.img.gz present ($(ls -lh "$RESOURCES/rootfs.img.gz" | awk '{print $5}'))"

echo ""
echo "✅ All resources ready in $RESOURCES/"
echo "   You can now run: cd src-tauri && cargo tauri build"
