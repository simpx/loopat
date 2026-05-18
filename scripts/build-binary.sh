#!/usr/bin/env bash
# Build loopat as a standalone binary distribution.
#
# Output:  dist/loopat-server   (compiled Bun server)
#          dist/loopat-sandbox  (Rust sandbox binary)
#          dist/claude          (Claude CLI binary)
#          dist/web/dist/       (frontend assets)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Building web frontend..."
bun --cwd web run build

echo "==> Building loopat-sandbox (Rust)..."
. "$HOME/.cargo/env" 2>/dev/null || true
(cd loopat-sandbox && cargo build --release)

echo "==> Copying binaries..."
mkdir -p dist
cp loopat-sandbox/target/release/loopat-sandbox dist/

# Locate and copy the claude CLI binary from node_modules
CLAUDE_BIN=$(bun -e "
  const { resolveClaudeBinary } = require('./server/src/claude-binary.ts');
  console.log(resolveClaudeBinary());
" 2>/dev/null || find node_modules/.bun -name 'claude' -type f 2>/dev/null | head -1 || find node_modules -path '*/@anthropic-ai/claude-agent-sdk-*/claude' -type f 2>/dev/null | head -1 || echo "")
if [ -n "$CLAUDE_BIN" ] && [ "$CLAUDE_BIN" != "" ]; then
  cp "$CLAUDE_BIN" dist/claude
  chmod +x dist/claude
  echo "==> Claude binary: $CLAUDE_BIN → dist/claude"
else
  echo "==> WARNING: claude binary not found. Set LOOPAT_CLAUDE_BINARY at runtime."
fi

echo "==> Compiling loopat server binary..."
# The binary will look for tools (claude, loopat-sandbox) in its own directory
# No compile-time defines needed — resolvers check bundleDir = dirname(binary)
bun build --compile \
  --target=bun-linux-x64 \
  --outfile=dist/loopat-server \
  server/src/index.ts

echo "==> Copying web assets..."
mkdir -p dist/web
cp -r web/dist dist/web/dist

echo "==> Done: dist/"
ls -lh dist/loopat-server dist/loopat-sandbox dist/claude 2>/dev/null
