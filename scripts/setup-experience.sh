#!/usr/bin/env bash
# Materialize a clean LOOPAT_HOME at /tmp/loopat-experience for the
# CC-native composition model (post-2026-05 refactor).
#
# Layout:
#   /tmp/loopat-experience/
#   ├── context/
#   │   └── knowledge/                            ← team git repo
#   │       ├── company-handbook.md
#   │       └── .loopat/
#   │           ├── .claude/                      ← team-tier CC config
#   │           │   ├── settings.json             ← enabledPlugins + extraKnownMarketplaces
#   │           │   ├── CLAUDE.md
#   │           │   ├── skills/
#   │           │   └── agents/
#   │           ├── profiles/                     ← composition units
#   │           │   ├── role-eng-backend/
#   │           │   │   └── .claude/              ← profile-tier CC config
#   │           │   │       ├── settings.json
#   │           │   │       └── CLAUDE.md
#   │           │   ├── role-security/.claude/
#   │           │   ├── mode-oncall/.claude/
#   │           │   └── mode-review/.claude/
#   │           └── marketplace/                  ← team's local CC marketplace
#   │               ├── .claude-plugin/marketplace.json
#   │               ├── internal-mcp/
#   │               └── pagerduty-mcp/
#   ├── personal/alice/
#   ├── personal/simpx/
#   └── loops/
set -euo pipefail

LOOPAT_HOME="${LOOPAT_HOME:-/tmp/loopat-experience}"

echo "Setting up: $LOOPAT_HOME"

if [[ -d "$LOOPAT_HOME" ]]; then
  echo "[!] $LOOPAT_HOME exists. Remove and rebuild? (y/N)"
  read -r ans
  [[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "abort"; exit 1; }
  rm -rf "$LOOPAT_HOME"
fi

mkdir -p "$LOOPAT_HOME/loops"

# ─── workspace knowledge git repo with .loopat/ inside ──────────────────
WS="$LOOPAT_HOME/context/knowledge"
mkdir -p "$WS"
cat > "$WS/company-handbook.md" <<'EOF'
# Acme Company Handbook

> Workspace-global docs. AI may read these on demand.

- IT: it@acme.internal
- HR: hr@acme.internal
EOF

# Team-tier .claude/
TEAM="$WS/.loopat/.claude"
mkdir -p "$TEAM/skills" "$TEAM/agents"

cat > "$TEAM/settings.json" <<'EOF'
{
  "_comment": "Team-tier CC config. Shared via knowledge git repo. Admin edits via CC's own commands (cd .loopat && claude plugin install --scope=project ...). Marketplace location is the team's choice — here it lives at knowledge/marketplace/, declared relative to this settings file.",
  "enabledPlugins": {},
  "extraKnownMarketplaces": {
    "acme-internal": {
      "source": {
        "source": "directory",
        "path": "../../marketplace"
      }
    }
  }
}
EOF

cat > "$TEAM/CLAUDE.md" <<'EOF'
# Acme · team baseline

> Loaded for every loop. Concat'd before profile + personal CLAUDE.md.

## Conventions

- 主语言：中文写文档、英文写代码
- Conventional Commits（feat / fix / chore）
- Never push to `main`; always go through PR
- Never `git push --force` to shared branches

## Safety

- Credentials live in `personal/<user>/.loopat/vaults/<v>/`, never in the repo
- Ask before destructive ops (rm -rf, drop table, branch -D)
EOF

# Team-tier skills (always-on team skills, replaces the old .loopat/claude/skills/)
mkdir -p "$TEAM/skills/loopat-onboarding"
cat > "$TEAM/skills/loopat-onboarding/SKILL.md" <<'EOF'
---
name: loopat-onboarding
description: Guide a new team member through their first loop setup.
---

# Loopat onboarding

When a user is new to the team workspace, walk them through:
1. Verifying their personal/<user>/.loopat/config.json
2. Default profiles for their role
3. Their vault setup
EOF

# ─── Profiles ───────────────────────────────────────────────────────────
PROFILES="$WS/.loopat/profiles"
mkdir -p "$PROFILES"

# role-eng-backend
mkdir -p "$PROFILES/role-eng-backend/.claude/skills"
cat > "$PROFILES/role-eng-backend/.claude/settings.json" <<'EOF'
{
  "enabledPlugins": {
    "internal-mcp@acme-internal": true
  }
}
EOF
cat > "$PROFILES/role-eng-backend/.claude/CLAUDE.md" <<'EOF'
# Role · Backend Engineer

- Schema changes need staging migration dry-run first
- Hot-path edits need benchmarks
- DB tools are read-only by default
EOF

# role-security
mkdir -p "$PROFILES/role-security/.claude"
cat > "$PROFILES/role-security/.claude/settings.json" <<'EOF'
{ "enabledPlugins": {} }
EOF
cat > "$PROFILES/role-security/.claude/CLAUDE.md" <<'EOF'
# Role · Security

- Review auth/crypto/SQL paths first
- Credentials always from vault, never inline
EOF

# mode-oncall
mkdir -p "$PROFILES/mode-oncall/.claude"
cat > "$PROFILES/mode-oncall/.claude/settings.json" <<'EOF'
{
  "enabledPlugins": {
    "pagerduty-mcp@acme-internal": true
  }
}
EOF
cat > "$PROFILES/mode-oncall/.claude/CLAUDE.md" <<'EOF'
# Mode · Oncall

You are on call. Prioritize stability. Defer new features.
Use the runbook search before changing anything in prod.
EOF

# mode-review
mkdir -p "$PROFILES/mode-review/.claude"
cat > "$PROFILES/mode-review/.claude/settings.json" <<'EOF'
{ "enabledPlugins": {} }
EOF
cat > "$PROFILES/mode-review/.claude/CLAUDE.md" <<'EOF'
# Mode · Code Review

You are a reviewer. Don't write new code. Check correctness > security > tests > style.
Every comment must include an actionable suggestion.
EOF

# ─── Team's local CC marketplace ────────────────────────────────────────
# Lives at knowledge/marketplace/, NOT under .loopat/. This is the team's
# choice — loopat doesn't dictate where private plugin marketplaces live.
# The location is declared in .loopat/.claude/settings.json's
# extraKnownMarketplaces (relative path).
MP="$WS/marketplace"
mkdir -p "$MP/.claude-plugin"
cat > "$MP/.claude-plugin/marketplace.json" <<'EOF'
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "acme-internal",
  "description": "Acme team-private plugin marketplace",
  "owner": { "name": "Acme Platform Team" },
  "plugins": [
    { "name": "internal-mcp", "source": "./internal-mcp", "description": "Internal services MCP" },
    { "name": "pagerduty-mcp", "source": "./pagerduty-mcp", "description": "PagerDuty MCP wrapper" }
  ]
}
EOF

mkdir -p "$MP/internal-mcp/.claude-plugin"
cat > "$MP/internal-mcp/.claude-plugin/plugin.json" <<'EOF'
{
  "name": "internal-mcp",
  "version": "2.0.0",
  "description": "Acme internal services MCP",
  "author": { "name": "Acme Platform" }
}
EOF
cat > "$MP/internal-mcp/.mcp.json" <<'EOF'
{
  "mcpServers": {
    "acme-internal": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/server.js"],
      "env": { "INTERNAL_API_TOKEN": "${INTERNAL_API_TOKEN}" }
    }
  }
}
EOF

mkdir -p "$MP/pagerduty-mcp/.claude-plugin"
cat > "$MP/pagerduty-mcp/.claude-plugin/plugin.json" <<'EOF'
{
  "name": "pagerduty-mcp",
  "version": "1.5.0",
  "description": "PagerDuty MCP wrapper",
  "author": { "name": "Acme SRE" }
}
EOF
cat > "$MP/pagerduty-mcp/.mcp.json" <<'EOF'
{
  "mcpServers": {
    "pagerduty": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/server.js"],
      "env": { "PAGERDUTY_TOKEN": "${PAGERDUTY_TOKEN}" }
    }
  }
}
EOF

# ─── Personal users (CC-native .claude/ shape) ──────────────────────────
for USER in alice simpx; do
  PERS="$LOOPAT_HOME/personal/$USER"
  mkdir -p "$PERS/.claude/skills" "$PERS/.claude/agents"
  mkdir -p "$PERS/.loopat/vaults/dev"

  # Personal CC-native config (the 4th .claude layer in the merge stack)
  cat > "$PERS/.claude/CLAUDE.md" <<EOF
# $USER · personal preferences

> Concat'd last; highest precedence.

- Prefer direct patches over explanations
EOF

  cat > "$PERS/.claude/settings.json" <<'EOF'
{ "_comment": "Personal CC config — only this user sees it." }
EOF

  # Loopat-specific personal config (separate from .claude/)
  cat > "$PERS/.loopat/config.json" <<EOF
{
  "_comment": "$USER's loopat personal config — loopat-specific (not CC).",
  "default_profiles": ["role-eng-backend", "role-security"],
  "default_vault": "dev"
}
EOF

  echo -n "placeholder-internal-token-DO-NOT-USE" > "$PERS/.loopat/vaults/dev/INTERNAL_API_TOKEN"
  echo -n "placeholder-pagerduty-token-DO-NOT-USE" > "$PERS/.loopat/vaults/dev/PAGERDUTY_TOKEN"
  echo -n "placeholder-github-token-DO-NOT-USE" > "$PERS/.loopat/vaults/dev/GITHUB_TOKEN"
done

# Initialize knowledge as a git repo (loopat expects this in production)
(cd "$WS" && git init -q -b main && git add -A && git -c user.email=setup@local -c user.name=setup commit -qm "initial team workspace")

echo ""
echo "✓ Ready. Try:"
echo ""
echo "  export LOOPAT_HOME=$LOOPAT_HOME"
echo "  bun scripts/loopat.ts list"
echo "  bun scripts/loopat.ts run --dry-run"
echo "  bun scripts/loopat.ts run +mode-oncall --bwrap"
