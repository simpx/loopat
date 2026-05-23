#!/usr/bin/env bash
# End-to-end demo of the tiered .claude/ model.
# Assumes scripts/setup-demo.sh has been run (LOOPAT_HOME=/tmp/loopat-demo).
#
# Walks through several composition scenarios to show how the merge produces
# different sandboxes for different users + CLI flag combinations.
set -euo pipefail

LOOPAT_HOME="${LOOPAT_HOME:-/tmp/loopat-demo}"
export LOOPAT_HOME

if [[ ! -d "$LOOPAT_HOME" ]]; then
  echo "[!] LOOPAT_HOME does not exist: $LOOPAT_HOME"
  echo "    Run scripts/setup-demo.sh first."
  exit 2
fi

cd "$(dirname "$0")/.."

banner() {
  echo ""
  echo "╔════════════════════════════════════════════════════════════════════════════╗"
  printf "║ %-74s ║\n" "$1"
  echo "╚════════════════════════════════════════════════════════════════════════════╝"
}

echo "Demo workspace: $LOOPAT_HOME"
echo ""

banner "1. List available profiles"
bun scripts/loopat.ts list

banner "2. Alice (backend + security) — defaults only"
bun scripts/loopat.ts run --user alice --dry-run | sed 's/^/  /'

banner "3. Bob (frontend + review) — defaults only"
bun scripts/loopat.ts run --user bob --dry-run | sed 's/^/  /'

banner "4. Carol (security + oncall) — defaults only"
bun scripts/loopat.ts run --user carol --dry-run | sed 's/^/  /'

banner "5. Alice + incident mode (CLI +mode-incident)"
bun scripts/loopat.ts run --user alice +mode-incident --dry-run | sed 's/^/  /'

banner "6. Alice — STRESS: load 5 profiles at once"
bun scripts/loopat.ts run --user alice +mode-oncall +mode-incident +role-eng-ml --dry-run | sed 's/^/  /'

banner "7. Alice — override to a single profile"
bun scripts/loopat.ts run --user alice --profiles=mode-incident --dry-run | sed 's/^/  /'

banner "8. Real materialize: Alice + mode-oncall (no spawn)"
bun scripts/loopat.ts run --user alice +mode-oncall 2>&1 | sed 's/^/  /'

LOOP=$(ls -td "$LOOPAT_HOME/loops/loop-"* | head -1)
echo ""
echo "  → Inspecting materialized loop: $LOOP"
echo ""
echo "  ── settings.json (merged) ──"
sed 's/^/    /' "$LOOP/.claude/settings.json"
echo ""
echo "  ── CLAUDE.md sources ──"
grep "<!-- ==========" "$LOOP/.claude/CLAUDE.md" | sed 's/^/    /'
echo ""
echo "  ── skills (symlinked from sources) ──"
ls "$LOOP/.claude/skills/" 2>/dev/null | sed 's/^/    /'
echo ""
echo "  ── agents ──"
ls "$LOOP/.claude/agents/" 2>/dev/null | sed 's/^/    /'

banner "Demo complete"
echo ""
echo "Next steps:"
echo "  - Run a real session:    bun scripts/loopat.ts run --user alice +mode-oncall --bwrap"
echo "  - Hit the web UI:        LOOPAT_HOME=$LOOPAT_HOME bun --cwd server run dev   (then http://localhost:5173)"
echo "  - Run the merge tests:   bun --cwd server run test"
