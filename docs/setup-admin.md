# Admin setup — provision a workspace

> Audience: you've just installed loopat and need to make it usable for
> a team. This guide is the **post-install** checklist — workspace
> config, knowledge repo, notes repo, sandboxes, MCP. Solo users can
> skim it; almost everything is optional and loopat will run with
> empty defaults.

If loopat isn't installed yet, do that first — see
[install.md](install.md). This guide picks up after `bun run dev`
prints its bootstrap banner.

---

## TL;DR

| Step | What | File / location | Optional? |
|---|---|---|---|
| 1 | Workspace config | `~/.loopat/config.json` | required if you want shared repos |
| 2 | Knowledge repo | `context/knowledge/` (cloned from remote) | optional, recommended |
| 3 | Notes repo | `context/notes/` (cloned from remote) | optional, recommended |
| 4 | Team CLAUDE.md / skills / MCP | `knowledge/.loopat/.claude/` | optional |
| 5 | Profiles (roles / modes) | `knowledge/.loopat/profiles/<name>/.claude/` | optional |
| 6 | Operator mounts | `config.json` `mounts[]` | optional |
| 7 | Activate users | UI → `/admin` | once members register |

You are the **first** user that registers — first registration auto-
promotes to `role: admin`, status `active`. Every subsequent user
lands as `member`, status `pending` and waits for you to activate them.

---

## 1. Workspace `config.json`

`~/.loopat/config.json` is the workspace-shared root. Templates with
empty fields after first run. Fill it in:

```jsonc
{
  "knowledge": { "git": "git@github.com:your-team/loopat-knowledge.git" },
  "notes":     { "git": "git@github.com:your-team/loopat-notes.git" },
  "repos": [
    { "name": "app",   "git": "git@github.com:your-team/app.git" },
    { "name": "infra", "git": "git@github.com:your-team/infra.git" }
  ],
  "mounts": [
    { "src": "$HOME/.cache", "dst": "$HOME/.cache", "rw": true }
  ]
}
```

| Field | Notes |
|---|---|
| `knowledge.git` | clone URL for team-shared knowledge repo. Empty → local-only dir. |
| `notes.git`     | clone URL for team-shared notes repo. Empty → local-only dir with `git init`. |
| `repos[]`       | each entry → cloned to `context/repos/<name>/`. Loops spawn against these. |
| `mounts[]`      | **operator-level** mounts; `src` is any host path. Shared by every loop on this workspace. See §6. |

Provider config (`apiKey`, `model`, `baseUrl`) is **not** here — that
lives per-user under `personal/<user>/.loopat/config.json`. Admins
don't pre-fill API keys for the team.

Restart `bun run dev` after editing. The banner clones any new
remotes and reports `✓ knowledge / ✓ notes / ✓ repos`.

---

## 2. Knowledge repo

`knowledge/` is the team's durable, curated context layer. Loops write it
freely in their own worktree, but their commits wait as **proposals** for
review & merge in the Context UI (gated promote — see docs/context-flow.md
"Gates"). Anything that lands on `main` is visible to every loop.

Layout once provisioned:

```
context/knowledge/
├── .loopat/                       ← reserved namespace (loopat-aware)
│   ├── .claude/                   workspace tier (always on)
│   │   ├── CLAUDE.md              (optional)  team prompt supplement
│   │   ├── settings.json          (optional)  enabledPlugins, mcpServers, hooks
│   │   ├── skills/                (optional)  team skills
│   │   ├── agents/                (optional)  team subagents
│   │   └── mise.toml              (optional)  team toolchain pins
│   └── profiles/                  profile tier (opt-in per loop)
│       └── <name>/.claude/        same shape as workspace .claude/ above
└── ... your team's prose docs (anything else)
```

Bootstrap clones the remote on first run. If the remote is private and
the clone fails, the banner shows `✗ knowledge` with a hint — fix SSH /
HTTPS access, `rm -rf context/knowledge`, restart.

---

## 3. Notes repo

Same shape as knowledge: empty git repo, `notes.git` URL in
`config.json`. On first clone loopat seeds:

- `notes/inbox.md` — append-only team scratchpad (loops write here)
- `notes/memory/` — team memory (`MEMORY.md` index + per-fact files)

Unlike knowledge, **notes is read-write** in sandboxes. Loops auto-
commit and push every write. Do **not** branch-protect main on this
repo — auto-push will fail.

---

## 4. Team Claude config — CLAUDE.md / skills / MCP

All three live under `knowledge/.loopat/.claude/`. Loopat ro-binds the
whole tree into each loop's `$CLAUDE_CONFIG_DIR/`, so Claude Code
discovers them natively as if they were `~/.claude/` on a normal host.

### Team CLAUDE.md

Workspace conventions everyone agrees on — directory layout, how to
run tests, what never to touch, doc pointers. Concatenated into every
loop's user-tier prompt. Keep it static so prompt cache stays warm.

### Skills

`SKILL.md` folders under `skills/`. Each folder becomes an invocable
slash-skill inside loops. Use these for repeatable team procedures
(release flow, on-call triage, repo-specific lint fix).

### MCP servers

```json
// knowledge/.loopat/.claude/settings.json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ghp_team_shared_token" }
    }
  }
}
```

`claude.json` is team-shared — only commit tokens that **everyone on
the team is allowed to use**. For per-user tokens (oauth, personal
PATs), leave them out and let each member set them via personal config.

Details on the full injection model: [claude-config.md](claude-config.md).

---

## 5. Profiles (roles / modes)

A profile = an opt-in bundle of `.claude/` config that loops can stack.
Each profile is a complete `.claude/` tree:

```
knowledge/.loopat/profiles/
├── role-eng/
│   └── .claude/
│       ├── CLAUDE.md          # role-specific doctrine
│       ├── settings.json      # enabledPlugins, mcpServers, hooks
│       ├── skills/<name>/SKILL.md
│       ├── agents/<name>.md
│       └── mise.toml          # toolchain pins for this role
├── role-legal/
│   └── .claude/…
└── mode-oncall/
    └── .claude/…
```

When a user spawns a loop and selects `[role-eng, mode-oncall]`, loopat
merges those profiles' `.claude/` directories on top of the team workspace
tier and the user's personal tier. Per-key shallow union; later tier wins
per key. See [composition.md](composition.md).

`mise.toml` inside any profile activates `mise install` for that loop;
toolchain installs are shared across all loops (cached at
`~/.local/share/mise/installs/`).

A loop selecting **zero** profiles still gets workspace + personal + the
project's own `.claude/` — works fine for pure-prose loops.

---

## 6. Operator mounts

The workspace `mounts[]` field exposes **host** paths into every
loop's sandbox. Use this for caches you want shared globally or for
trust roots:

```jsonc
"mounts": [
  { "src": "$HOME/.cache",       "dst": "$HOME/.cache",       "rw": true },
  { "src": "$HOME/.bun",         "dst": "$HOME/.bun",         "rw": true },
  { "src": "/etc/pki/ca-trust",  "dst": "/etc/pki/ca-trust" }
]
```

- `src` — any host path (`$HOME/...`, `~/...`, absolute `/...`)
- `dst` — must be sandbox-rooted (`$HOME/...`, `~/...`, `/...`)
- `rw` — defaults to false (read-only). Set true if loops need to write.

Operator mounts apply to **every** loop on this workspace. For per-
user mounts (private ssh keys, individual gh tokens), users add them
in their personal config — see [setup-user.md](setup-user.md).

> **Why this layer exists** — the three mount layers (operator /
> admin / member) map directly to filesystem ownership: operator owns
> the host, admin pushes to `knowledge/`, member writes their own
> `personal/`. Whoever owns the directory owns that layer's mount
> decisions. Details: [sandbox.md §三层 mount 权责](sandbox.md).

---

## 7. Activate users

When a new member registers, they land as `status: pending` and can't
log in until you activate them.

Open `http://<your-host>:10001/admin` (admin-only route) and flip the
status to `active`. The user can now log in and start their own
[user setup flow](setup-user.md).

---

## Verify

After the dust settles, the banner should be all green:

```
────────────────────────────────────────────────────────────
  loopat bootstrap — loopat (user=admin)
────────────────────────────────────────────────────────────
  ✓  workspace: /home/admin/.loopat
  ✓  workspace supplement: knowledge/.loopat/.claude/CLAUDE.md (present)
  ✓  knowledge: git@…/loopat-knowledge.git
  ✓  notes:     git@…/loopat-notes.git
  ✓  repos:     app, infra
  ✓  users:     1 (admin)
  ✓  config: /home/admin/.loopat/config.json
  ✓  bwrap (sandbox)
  ✓  claude binary (…/claude)
  ready. open http://localhost:10001
```

Share the URL with your team and point them at
[setup-user.md](setup-user.md).

---

## See also

- [install.md](install.md) — host install, system deps, env vars
- [setup-user.md](setup-user.md) — member-side companion to this guide
- [architecture.md](architecture.md) — read/write paths, context layers
- [claude-config.md](claude-config.md) — exact CLAUDE.md / skills / MCP wiring
- [sandbox.md](sandbox.md) — bwrap mechanics, three-tier mount authority
- [troubleshoot.md](troubleshoot.md) — banner errors, common pitfalls
