#!/usr/bin/env bash
# test-vm.sh — Build the VM test, codesign with entitlements, and run it.
set -euo pipefail
cd "$(dirname "$0")/../.."

ENTITLEMENTS="src-tauri/entitlements.plist"
TEST_FILTER="vm::tests::test_vm_lifecycle"

echo "▶ Building VM test …"

# Build lib tests and get the executable path
cargo test --manifest-path src-tauri/Cargo.toml --lib --no-run \
  --message-format=json 2>/dev/null \
  > /tmp/cargo-test-output.json

# Find the test executable (the one with executable != null)
BIN_PATH=$(jq -r 'select(.reason == "compiler-artifact" and .executable != null) | .executable' \
  /tmp/cargo-test-output.json | head -1)

rm -f /tmp/cargo-test-output.json

if [[ -z "$BIN_PATH" || ! -f "$BIN_PATH" ]]; then
  echo "ERROR: could not locate test binary" >&2
  exit 1
fi

echo "▶ Codesigning: $(basename "$BIN_PATH")"
codesign --entitlements "${ENTITLEMENTS}" --force --timestamp -s - "$BIN_PATH"

echo "▶ Running test …"
exec "$BIN_PATH" "$TEST_FILTER" --nocapture
