#!/usr/bin/env bash
# Build a rich LOOPAT_HOME demo workspace at /tmp/loopat-demo showing the
# tiered .claude/ model end-to-end with multiple profiles, plugins, and users.
#
# Layout (all 5 layers of the merge model represented):
#
#   /tmp/loopat-demo/
#   ├── context/
#   │   ├── knowledge/                            ← team git repo (SoT)
#   │   │   ├── architecture.md                   ← team docs
#   │   │   ├── runbook-overview.md
#   │   │   ├── marketplace/                      ← team's CC marketplace
#   │   │   │   ├── .claude-plugin/marketplace.json
#   │   │   │   ├── internal-mcp/
#   │   │   │   ├── pagerduty-mcp/
#   │   │   │   └── deploy-cli/
#   │   │   └── .loopat/
#   │   │       ├── .claude/                      ← layer 1: team
#   │   │       │   ├── settings.json
#   │   │       │   ├── CLAUDE.md
#   │   │       │   ├── skills/
#   │   │       │   └── agents/
#   │   │       └── profiles/                     ← layer 2: profiles (×6)
#   │   │           ├── role-eng-backend/.claude/
#   │   │           ├── role-eng-frontend/.claude/
#   │   │           ├── role-eng-ml/.claude/
#   │   │           ├── role-security/.claude/
#   │   │           ├── mode-oncall/.claude/
#   │   │           ├── mode-review/.claude/
#   │   │           └── mode-incident/.claude/
#   │   ├── notes/                                ← team memory
#   │   │   └── memory/
#   │   └── repos/
#   │       └── acme-api/                         ← workdir mock; layer 5 (repo)
#   │           ├── README.md
#   │           ├── src/
#   │           └── .claude/                      ← project-tier .claude/
#   │               ├── settings.json
#   │               └── CLAUDE.md
#   ├── personal/                                 ← layer 4: personal (×3)
#   │   ├── alice/    (eng-backend + security)
#   │   ├── bob/      (eng-frontend + review)
#   │   └── carol/    (sre, oncall by default)
#   └── loops/                                    ← populated on `loopat run`
set -euo pipefail

LOOPAT_HOME="${LOOPAT_HOME:-/tmp/loopat-demo}"

echo "Setting up demo workspace: $LOOPAT_HOME"

if [[ -d "$LOOPAT_HOME" ]]; then
  echo "[!] $LOOPAT_HOME exists. Remove and rebuild? (y/N)"
  read -r ans
  [[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "abort"; exit 1; }
  rm -rf "$LOOPAT_HOME"
fi

mkdir -p "$LOOPAT_HOME/loops"

# ─── workspace knowledge git repo ───────────────────────────────────────
WS="$LOOPAT_HOME/context/knowledge"
mkdir -p "$WS"

cat > "$WS/architecture.md" <<'EOF'
# Acme System Architecture

API gateway → product / order / notification services → Postgres + Redis + Kafka.
Worker pool consumes from Kafka for async tasks.
EOF

cat > "$WS/runbook-overview.md" <<'EOF'
# Runbook Overview

- DB issues: see runbook/db.md
- API 5xx spikes: see runbook/api.md
- Worker queue backup: see runbook/worker.md
EOF

# Team-tier .claude/ (layer 1)
TEAM="$WS/.loopat/.claude"
mkdir -p "$TEAM/skills" "$TEAM/agents"
cat > "$TEAM/settings.json" <<'EOF'
{
  "_comment": "Team-tier CC config. Shared via knowledge git. Marketplace at knowledge/marketplace/.",
  "enabledPlugins": {},
  "extraKnownMarketplaces": {
    "acme-internal": {
      "source": { "source": "directory", "path": "../../marketplace" }
    }
  }
}
EOF
# Team-tier mise.toml — baseline toolchain everyone gets
cat > "$TEAM/mise.toml" <<'EOF'
[tools]
node = "20"

[env]
NODE_ENV = "development"
EOF

cat > "$TEAM/CLAUDE.md" <<'EOF'
# Acme · team baseline

> Loaded for every loop. Lowest precedence — overridable by profile / personal.

## Conventions
- Conventional Commits (feat / fix / chore)
- Never push to `main`; always go through PR
- Never `git push --force` to shared branches

## Safety
- Credentials live in `personal/<user>/.loopat/vaults/<v>/`, never in the repo
- Ask before destructive ops (rm -rf, drop table, branch -D)
EOF

# Team skill: always-on team helper
mkdir -p "$TEAM/skills/team-onboarding"
cat > "$TEAM/skills/team-onboarding/SKILL.md" <<'EOF'
---
name: team-onboarding
description: Guide new team members through their loopat setup.
---

# Acme team onboarding

Walk new members through: personal config, default profiles, vault setup.
EOF

# Team agent (subagent that can be delegated to)
cat > "$TEAM/agents/code-archaeologist.md" <<'EOF'
---
name: code-archaeologist
description: Trace the history of a code path or decision through commits + notes.
---

You are a code archaeologist. Given a file or symbol, walk git log, blame,
and team notes to surface why it exists in its current form.
EOF

# ─── Profiles (layer 2) ─────────────────────────────────────────────────
PROFILES="$WS/.loopat/profiles"

make_profile() {
  local name="$1" claude_md="$2" plugin_spec="$3"
  local pdir="$PROFILES/$name/.claude"
  mkdir -p "$pdir/skills" "$pdir/agents"
  if [[ -n "$plugin_spec" ]]; then
    cat > "$pdir/settings.json" <<EOF
{ "enabledPlugins": { $plugin_spec } }
EOF
  else
    echo '{ "enabledPlugins": {} }' > "$pdir/settings.json"
  fi
  printf '%s\n' "$claude_md" > "$pdir/CLAUDE.md"
}

make_profile "role-eng-backend" '# Role · Backend Engineer

- Schema changes need staging migration dry-run first
- Hot-path edits need benchmarks
- DB tools are read-only by default
- Use internal-mcp to query services without curl' \
  '"internal-mcp@acme-internal": true, "deploy-cli@acme-internal": true'

# backend role brings go toolchain
cat > "$PROFILES/role-eng-backend/.claude/mise.toml" <<'EOF'
[tools]
go = "1.22"
golangci-lint = "1.62"

[env]
GOFLAGS = "-mod=readonly"
EOF

make_profile "role-eng-frontend" '# Role · Frontend Engineer

- Storybook stories accompany every new component
- Accessibility checks via `make a11y` before merging
- Bundle size deltas commented on PR' \
  ''

make_profile "role-eng-ml" '# Role · ML Engineer

- Experiment tracking in MLflow; commit run IDs to notes
- Dataset versioning via DVC
- GPU jobs go through the cluster scheduler, not local' \
  ''

# ML role brings python toolchain
cat > "$PROFILES/role-eng-ml/.claude/mise.toml" <<'EOF'
[tools]
python = "3.12"
uv = "latest"

[env]
PYTHONDONTWRITEBYTECODE = "1"
EOF

make_profile "role-security" '# Role · Security

- Review auth / crypto / SQL paths first
- Credentials always from vault, never inline
- Run audit on every new MCP integration' \
  ''

make_profile "mode-oncall" 'You are on call. Prioritize stability. Defer new features.
Use the runbook search before changing anything in prod.
Escalate to SRE lead if errors > 5% within 15 minutes.' \
  '"pagerduty-mcp@acme-internal": true'

make_profile "mode-review" 'You are a reviewer. Do not write new code.
Check correctness > security > tests > style.
Every comment must include an actionable suggestion.' \
  ''

make_profile "mode-incident" 'INCIDENT mode. Focus: triage, communicate, restore.
- Acknowledge the page in <2 minutes
- Open #incident-<service>-<date> if customer-facing
- Rollback before debug if user impact is active' \
  '"pagerduty-mcp@acme-internal": true'

# Profile-specific skill (only loaded when role-eng-backend is active)
mkdir -p "$PROFILES/role-eng-backend/.claude/skills/db-explore"
cat > "$PROFILES/role-eng-backend/.claude/skills/db-explore/SKILL.md" <<'EOF'
---
name: db-explore
description: Read-only database exploration helper for backend engineers.
---

Run safe SELECT queries against staging. Never modify production data.
EOF

# Profile-specific skill for oncall
mkdir -p "$PROFILES/mode-oncall/.claude/skills/runbook-search"
cat > "$PROFILES/mode-oncall/.claude/skills/runbook-search/SKILL.md" <<'EOF'
---
name: runbook-search
description: Search Acme runbooks by symptom keyword. Use during incidents.
---

Given a symptom phrase, fuzzy-match against runbook/*.md and surface top 3 hits.
EOF

# ─── Team marketplace (3 plugins) ───────────────────────────────────────
MP="$WS/marketplace"
mkdir -p "$MP/.claude-plugin"
cat > "$MP/.claude-plugin/marketplace.json" <<'EOF'
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "acme-internal",
  "description": "Acme private plugin marketplace",
  "owner": { "name": "Acme Platform" },
  "plugins": [
    { "name": "internal-mcp",  "source": "./internal-mcp",  "description": "Internal services MCP" },
    { "name": "pagerduty-mcp", "source": "./pagerduty-mcp", "description": "PagerDuty MCP wrapper" },
    { "name": "deploy-cli",    "source": "./deploy-cli",    "description": "Deploy tooling (dev/staging/prod)" }
  ]
}
EOF

make_plugin() {
  local name="$1" desc="$2" mcp_env="$3"
  local d="$MP/$name"
  mkdir -p "$d/.claude-plugin"
  cat > "$d/.claude-plugin/plugin.json" <<EOF
{ "name": "$name", "version": "1.0.0", "description": "$desc", "author": { "name": "Acme Platform" } }
EOF
  if [[ -n "$mcp_env" ]]; then
    cat > "$d/.mcp.json" <<EOF
{ "mcpServers": { "$name": { "command": "node", "args": ["\${CLAUDE_PLUGIN_ROOT}/server.js"], "env": $mcp_env } } }
EOF
  fi
}

make_plugin "internal-mcp"   "Internal services MCP"       '{ "INTERNAL_API_TOKEN": "${INTERNAL_API_TOKEN}" }'
make_plugin "pagerduty-mcp"  "PagerDuty MCP wrapper"       '{ "PAGERDUTY_TOKEN": "${PAGERDUTY_TOKEN}" }'
make_plugin "deploy-cli"     "Deploy tooling"              ""

# Add slash commands + skills so plugins appear in CC's `/` menu

# pagerduty-mcp: a skill (auto-triggered or via /pagerduty-mcp:ack-incident)
mkdir -p "$MP/pagerduty-mcp/skills/ack-incident"
cat > "$MP/pagerduty-mcp/skills/ack-incident/SKILL.md" <<'EOF'
---
name: ack-incident
description: Acknowledge a PagerDuty incident by ID or by symptom keywords.
---

# Acknowledge incident

Given an incident ID, call pagerduty.ack(id). If the user described symptoms
instead of an ID, search for the most recent open incident matching, then ack.
EOF

# internal-mcp: a skill — invokable as /internal-mcp:db-explore
mkdir -p "$MP/internal-mcp/skills/db-explore"
cat > "$MP/internal-mcp/skills/db-explore/SKILL.md" <<'EOF'
---
name: db-explore
description: Open a read-only DB exploration session against the internal services
---

# DB explore

Use the internal-mcp `db.query` tool to run safe SELECT statements.
Refuse any write operation; suggest creating a migration PR instead.
EOF

# deploy-cli: a skill — invokable as /deploy-cli:deploy
mkdir -p "$MP/deploy-cli/skills/deploy"
cat > "$MP/deploy-cli/skills/deploy/SKILL.md" <<'EOF'
---
name: deploy
description: Deploy current branch to a chosen environment
---

# Deploy

Ask the user: which env? (dev / staging / prod). For prod, require an extra
confirmation. Then invoke the deploy tool and watch for completion.
EOF

# ─── Notes (team memory) ────────────────────────────────────────────────
mkdir -p "$LOOPAT_HOME/context/notes/memory"
cat > "$LOOPAT_HOME/context/notes/memory/MEMORY.md" <<'EOF'
# Team memory index

- [API rate-limit history](api-ratelimit-history.md)
- [Postgres failover lessons](postgres-failover-lessons.md)
EOF
cat > "$LOOPAT_HOME/context/notes/memory/api-ratelimit-history.md" <<'EOF'
# API rate-limit history

2025-Q3 we moved from leaky-bucket to token-bucket to handle burst traffic.
Constants live in `services/api-gateway/config/ratelimit.go`.
EOF

# ─── Mock workdir (layer 5: repo .claude/) ──────────────────────────────
REPO="$LOOPAT_HOME/context/repos/acme-api"
mkdir -p "$REPO/src" "$REPO/.claude"
cat > "$REPO/README.md" <<'EOF'
# acme-api

Internal API gateway. Routes requests to product/order/notification services.
EOF
cat > "$REPO/src/main.go" <<'EOF'
package main

func main() {
    // placeholder
}
EOF
cat > "$REPO/.claude/settings.json" <<'EOF'
{
  "_comment": "Repo-tier (CC project-tier). Highest precedence in the merge.",
  "enabledPlugins": {}
}
EOF
cat > "$REPO/.claude/CLAUDE.md" <<'EOF'
# acme-api repo conventions

- Go modules; minimum Go 1.22
- `make test` runs unit tests + race detector
- API contracts in `api/v1/*.proto` — regenerate with `make proto`
EOF
(cd "$REPO" && git init -q -b main && git add -A && git -c user.email=a@b -c user.name=demo commit -qm "init")

# ─── Personal users (layer 4) ───────────────────────────────────────────
make_personal() {
  local user="$1" profiles_json="$2"
  local pers="$LOOPAT_HOME/personal/$user"
  mkdir -p "$pers/.claude/skills" "$pers/.claude/agents" "$pers/.loopat/vaults/dev"

  cat > "$pers/.claude/settings.json" <<'EOF'
{ "_comment": "Personal CC config — only this user sees it." }
EOF
  cat > "$pers/.claude/CLAUDE.md" <<EOF
# $user · personal preferences

- Prefer direct patches over explanations
EOF
  cat > "$pers/.loopat/config.json" <<EOF
{
  "_comment": "$user's loopat personal config — loopat-specific (not CC).",
  "default_profiles": $profiles_json,
  "default_vault": "dev"
}
EOF
  echo -n "placeholder-internal-token-$user" > "$pers/.loopat/vaults/dev/INTERNAL_API_TOKEN"
  echo -n "placeholder-pagerduty-token-$user" > "$pers/.loopat/vaults/dev/PAGERDUTY_TOKEN"
  echo -n "placeholder-github-token-$user" > "$pers/.loopat/vaults/dev/GITHUB_TOKEN"
}

# 3 users with different default profiles
make_personal "alice" '["role-eng-backend", "role-security"]'
make_personal "bob"   '["role-eng-frontend", "mode-review"]'
make_personal "carol" '["role-security", "mode-oncall"]'

# Initialize knowledge as a git repo (loopat expects this in production)
(cd "$WS" && git init -q -b main && git add -A && git -c user.email=setup@local -c user.name=setup commit -qm "initial demo workspace")

cat <<EOF

✓ Demo workspace ready at: $LOOPAT_HOME

Layout summary:
  team layer:       knowledge/.loopat/.claude/  (1 skill, 1 agent)
  profiles:         7 profiles (4 role-*, 3 mode-*)
  marketplace:      knowledge/marketplace/  (3 plugins)
  notes:            notes/memory/  (sample entries)
  repos:            repos/acme-api/  (with own .claude/)
  personal users:   alice, bob, carol  (different default_profiles)

Try:
  export LOOPAT_HOME=$LOOPAT_HOME

  # list available profiles
  bun scripts/loopat.ts list

  # dry-run for each user (different default_profiles)
  bun scripts/loopat.ts run --user alice --dry-run
  bun scripts/loopat.ts run --user bob   --dry-run
  bun scripts/loopat.ts run --user carol --dry-run

  # stress: load many profiles at once
  bun scripts/loopat.ts run --user alice +mode-oncall +mode-incident +role-eng-ml --dry-run

  # run with repo layer (5th merge source)
  bun scripts/loopat.ts run --user alice --dry-run
  # (workdir mounting: would need to set up loop with repo=acme-api in real spawn)

  # full bwrap end-to-end
  bun scripts/loopat.ts run --user alice +mode-oncall --bwrap

EOF
