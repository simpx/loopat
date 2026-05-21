#!/usr/bin/env bash
# codesign-runner.sh — invoked by cargo as a runner before executing the binary.
# Signs the binary with the project entitlements (ad-hoc, for local dev only),
# then exec's it so `cargo tauri dev` picks up the Virtualization.framework entitlement.
set -euo pipefail

BINARY="$1"
shift

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTITLEMENTS="$REPO_ROOT/src-tauri/entitlements.plist"

codesign --entitlements "$ENTITLEMENTS" --force --timestamp -s - "$BINARY" 2>/dev/null || true

exec "$BINARY" "$@"
