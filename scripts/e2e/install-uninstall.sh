#!/usr/bin/env bash
#
# e2e scenario #1 — install → create loops/containers → uninstall → zero residue.
#
# What it proves (the lifecycle a user actually runs):
#   1. a workspace can be provisioned and a real sandbox container started
#      (same code path the server uses);
#   2. `loopat uninstall` removes ONLY that workspace's resources — container,
#      images, network, data dir — leaving nothing behind;
#   3. ISOLATION: with two workspaces side by side, uninstalling one never
#      touches the other — even when one name is a PREFIX of the other
#      (loopat-e2e-a vs loopat-e2e-a2), because deletion is by the
#      loopat.workspace label, not a name glob.
#
# Safety: uses throwaway LOOPAT_HOMEs under /tmp; never touches ~/.loopat or any
# real workspace. A trap cleans up even on failure.
#
# Requires: bun + podman. First run builds a real sandbox base image (~minutes);
# later runs reuse cached layers.
#
# Run from anywhere:  bash scripts/e2e/install-uninstall.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
UNINSTALL="$REPO/server/src/uninstall.ts"
SETUP="$REPO/scripts/e2e/setup-ws.ts"

HOME_A=/tmp/loopat-e2e-a
HOME_A2=/tmp/loopat-e2e-a2   # "loopat-e2e-a" is a prefix of "loopat-e2e-a2"
WS_A=loopat-e2e-a
WS_A2=loopat-e2e-a2

c() { podman ps -aq --filter "label=loopat.workspace=$1" 2>/dev/null | wc -l | tr -d ' '; }
i() { podman images --filter "label=loopat.workspace=$1" -q 2>/dev/null | sort -u | wc -l | tr -d ' '; }
n() { podman network ls --filter "label=loopat.workspace=$1" -q 2>/dev/null | wc -l | tr -d ' '; }

uninstall() { LOOPAT_HOME="$1" bun run "$UNINSTALL" --yes >/dev/null 2>&1 || true; }
setup()     { LOOPAT_HOME="$1" bun run "$SETUP"; }

cleanup() { uninstall "$HOME_A"; uninstall "$HOME_A2"; rm -rf "$HOME_A" "$HOME_A2"; }
trap cleanup EXIT

fail() { echo "  ✗ FAIL: $1"; exit 1; }
ok()   { echo "  ✓ $1"; }

echo "e2e #1: install → uninstall (+ isolation, prefix ambiguity)"
cleanup  # start clean

echo "── provision two workspaces (real containers) ──"
setup "$HOME_A"
setup "$HOME_A2"

echo "── after install: both have resources ──"
[ "$(c "$WS_A")"  -ge 1 ] && [ "$(i "$WS_A")"  -ge 1 ] && [ "$(n "$WS_A")"  -ge 1 ] || fail "$WS_A not fully provisioned"
[ "$(c "$WS_A2")" -ge 1 ] && [ "$(i "$WS_A2")" -ge 1 ] && [ "$(n "$WS_A2")" -ge 1 ] || fail "$WS_A2 not fully provisioned"
ok "both workspaces have container + image + network + data"

echo "── uninstall $WS_A ──"
uninstall "$HOME_A"
[ "$(c "$WS_A")" = 0 ] && [ "$(i "$WS_A")" = 0 ] && [ "$(n "$WS_A")" = 0 ] || fail "$WS_A left podman residue"
[ -d "$HOME_A" ] && fail "$WS_A data dir not removed"
ok "$WS_A fully removed (container/image/network/data = 0)"

echo "── isolation + prefix check: $WS_A2 must be intact ──"
[ "$(c "$WS_A2")" -ge 1 ] && [ "$(i "$WS_A2")" -ge 1 ] && [ "$(n "$WS_A2")" -ge 1 ] || fail "$WS_A2 collateral-damaged by uninstalling its prefix $WS_A"
[ -d "$HOME_A2" ] || fail "$WS_A2 data dir wrongly removed"
ok "$WS_A2 untouched despite being '$WS_A' + suffix"

echo "── uninstall $WS_A2 ──"
uninstall "$HOME_A2"
[ "$(c "$WS_A2")" = 0 ] && [ "$(i "$WS_A2")" = 0 ] && [ "$(n "$WS_A2")" = 0 ] || fail "$WS_A2 left podman residue"
[ -d "$HOME_A2" ] && fail "$WS_A2 data dir not removed"
ok "$WS_A2 fully removed"

trap - EXIT
echo "PASS — install/uninstall leaves zero residue; workspaces are isolated."
