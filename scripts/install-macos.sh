#!/usr/bin/env bash
# loopat macOS install helper.
# Removes quarantine + self-signs so Gatekeeper doesn't block the binary.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$DIR/loopat" ]; then
  echo "Error: loopat binary not found next to this script."
  echo "Place this script in the same directory as loopat and loopat-sandbox."
  exit 1
fi

BUNDLED_BINS=("$DIR/loopat" "$DIR/loopat-sandbox" "$DIR/claude" "$DIR/mise" "$DIR/git-crypt")

echo "==> Removing quarantine attributes…"
xattr -cr "${BUNDLED_BINS[@]}" 2>/dev/null || true

echo "==> Self-signing binaries (ad-hoc)…"
for bin in "${BUNDLED_BINS[@]}"; do
  if [ -f "$bin" ]; then
    codesign --force --deep --sign - "$bin" 2>/dev/null || echo "  (codesign skipped for $(basename "$bin"))"
  fi
done

echo ""
echo "==> Linux-compatible sandbox paths (/loopat)"
if [ -e /loopat ]; then
  echo "    /loopat already exists."
else
  ROOT="$HOME/.loopat/macos-root"
  echo "    macOS needs a one-time synthetic /loopat root to match Linux paths."
  echo "    To enable it:"
  echo "      mkdir -p \"$ROOT\""
  echo "      printf 'loopat\\t%s\\n' \"$ROOT\" | sudo tee -a /etc/synthetic.conf"
  echo "      # then reboot macOS once"
fi

echo ""
echo "==> Claude CLI is REQUIRED"
echo "    loopat needs Anthropic's Claude Code CLI binary to function."
echo ""
echo "    If Claude is already installed, find it and set the env var:"
echo "        export LOOPAT_CLAUDE_BINARY=\$(which claude)"
echo "    Add that line to your ~/.zshrc so it persists."
echo ""
echo "    To install Claude CLI (choose one):"
echo "      Option A — Install via npm (recommended):"
echo "        npm install -g @anthropic-ai/claude-code"
echo "        export LOOPAT_CLAUDE_BINARY=\$(which claude)"
echo ""
echo "      Option B — Use npx (no install):"
echo "        export LOOPAT_CLAUDE_BINARY=\$(npx -y -p @anthropic-ai/claude-code which claude)"
echo ""
echo "    Verify it works:"
echo "        ls -l \"\$LOOPAT_CLAUDE_BINARY\""
echo ""
echo "==> Done. Run:"
echo "    $DIR/loopat"
