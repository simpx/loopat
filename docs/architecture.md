---
title: loopat architecture
tags: [loopat, architecture, overview]
status: living doc
---

# loopat architecture

> **Loop = context + AI + workdir**, bound together in a per-loop bwrap sandbox.
> Every path the agent sees is composed from a few host-side sources.

## The big picture

**The centerpiece diagram lives in [architecture.html](./architecture.html)** —
a single self-contained HTML page with the layered overlay visualization,
the orthogonal `sandbox × vault` axes, and all the arrows wired up.
Open it in any browser; no build step, no dependencies.

This markdown file holds the **textual supplements** to that diagram:
read/write path tables, code map, and the philosophy notes — things that grep
better than they render.

For the **`.claude/` composition model** specifically — how team / profile /
personal / repo tiers merge into the loop's `.claude/` and how the SDK reads
it — see [composition.md](composition.md).

---

## Loop = Profiles × Vault (in words)

The one abstraction to internalize:

| Axis | What it picks | Who owns it | Storage |
|---|---|---|---|
| **Profiles** | the **`.claude/` tiers** to compose (toolchain + plugins + MCP + skills + agents + CLAUDE.md) | admin / team | `knowledge/.loopat/profiles/<name>/.claude/` (opt-in, 0..N per loop) |
| **Vault** | the **credentials** the loop runs as (apiKey, ssh, tokens) | individual / member | `personal/<user>/.loopat/vaults/<name>/` |

See [composition.md](composition.md) for the full five-tier merge story (workspace · profiles · personal · project · local).

Examples that fall out:

- alice spawns `[frontend] × dev` — frontend profile tools, her dev credentials
- alice spawns `[frontend] × test` — same profile, different identity
- bob spawns `[frontend, oncall] × test` — two profiles unioned, his own test creds (alice can't see)
- carol spawns `[sre] × prod` — different profile, her prod credentials

Same engine, four cells of the matrix.

---

## Read path — what the agent learns from

Per turn, the agent's effective "context" is assembled from layered sources:

| Layer | Source on host | Loaded by | Scope |
|---|---|---|---|
| **L1 doctrine** | `server/templates/CLAUDE.md` | system-prompt builder, always | sandbox basics, path conventions |
| **L2 team** | `knowledge/.loopat/.claude/CLAUDE.md` | ro-bind to `.claude/CLAUDE.md`, SDK loads as user-tier | workspace conventions |
| **L3 project** | `workdir/CLAUDE.md` | SDK loads from cwd | repo-specific conventions |
| **L4 runtime** | server-computed (loop id, title, branch, driver, vault, sandbox) | concatenated into system prompt | per-turn variables |
| **skills** | `knowledge/.loopat/.claude/skills/` | ro-bind to `.claude/skills/`, SDK auto-discovers | callable procedures |
| **mcp** | `knowledge/.loopat/.claude/settings.json` | passed to SDK at spawn | external tools (jira / github / …) |
| **personal memory** | `personal/memory/*.md` | SDK auto-recall via `.claude/settings.json` | your habits, user-specific facts |
| **team memory** | `notes/memory/MEMORY.md` + files | doctrine tells the agent to read on complex turns | gotchas, conventions |
| **chat thread** | `chat/<tid>/history.jsonl` | ro-bound at `/context/chat/<id>/` (only when spawned from chat) | seed conversation |
| **credentials** | `personal/.loopat/vaults/<v>/*` | walked + overlay-mounted at `.loopat/vault/` | apiKey, ssh, tokens |

The L1/L2/L3 stack is concatenated identically across loops on the same
workspace, maximizing prompt-cache hit rate.

---

## Write path — where the agent's output lands

| Path | Persistence | Notes |
|---|---|---|
| `workdir/*` | auto-commit on `loop/<slug>-<id6>` branch | the loop's actual work product |
| `notes/inbox.md` | auto-commit to team notes git | append-only scratchpad |
| `notes/<focus>.md` | auto-commit | small markdown task trees |
| `notes/memory/<name>.md` + index | auto-commit | **agent auto-promotes** from personal when topic is workspace-wide |
| `personal/memory/<name>.md` | SDK-managed, auto-commit | private observations |
| `/vault/*` | git-crypt encrypted at commit | rare — credential rotation paths |

**Never writes:** `knowledge/` (ro by design) and other `repos/<x>/` (only the
loop's own `workdir/`). These restrictions are mechanical (`--ro-bind` for
knowledge, behavior rules + worktree-branch isolation for repos) — not
trust-based.

---

## Distillation — knowledge condenses upward

Three deliberate promotions, each more friction'd than the last:

| From | To | Trigger |
|---|---|---|
| `personal/memory/` | `notes/memory/` | the agent auto-promotes when an observation generalizes; you can also curate manually |
| `notes/*` | `knowledge/` | you spawn a *distill loop* — its job is to read accumulated notes and propose `knowledge/` edits; you review like a PR |
| `loop/workdir/` | `repos/<name>/` | you merge the loop's branch back when work is done |

Continuous capture into ephemeral surfaces; deliberate promotion into durable
ones. AI fills the bottom; humans curate upward.

---

## Boundaries the sandbox enforces

| Agent attempts to … | What stops it |
|---|---|
| read another user's secrets | `personal/<other-user>/` isn't bound into this sandbox at all |
| read another vault's keys | host-side `.loopat/vaults/` is tmpfs'd; only the selected vault overlays as `/.loopat/vault/` |
| escape via a symlink in the vault | `walkVaultFiles` checks `realpath` against `personal/<user>/` and refuses targets outside |
| modify team knowledge | `knowledge/` is `ro-bind`; writes return EROFS |
| commit to another repo's mainline | repos are rw but workflow rules + worktree-branch isolation steer commits onto `loop/…` only |
| see the host filesystem outside `/loopat` | sandbox root is a fresh tmpfs; only explicitly-bound paths exist |

The first three are vault-specific; the last three are baseline.

---

## Why this shape (philosophy)

1. **Filesystem-first, no DB.** Every artifact is a file. Loop state, vault
   contents, memory, branch — all readable with `ls` and `cat`.

2. **Loop ephemeral, context persistent.** `/loopat/loop/<id>/` dies with the
   loop. Everything under `/loopat/context/` survives — branch + memory +
   notes remain.

3. **Capability ⊥ identity.** Sandbox × vault. Same engine powers
   "alice testing the frontend" and "carol fighting a prod fire" — different
   cells of the same matrix.

4. **Read down, write up — slowly.** Knowledge flows downward (everyone
   consumes shared knowledge). Writing back to `knowledge/` requires a
   distillation loop, not a one-line `echo >>`. The friction is intentional.

5. **The sandbox is the membrane.** Nothing crosses implicitly. Every path
   the agent sees is a `--bind` line in `buildBwrapArgs`. The host can sleep
   through any AI misbehavior because the agent's horizon is a 12-line argv
   list.

---

## Where to look in the code

| Concept | File(s) |
|---|---|
| sandbox composition (`buildBwrapArgs`) | `server/src/bwrap.ts` |
| vault catalog + symlink validation | `server/src/vaults.ts` |
| loop lifecycle + auto-init | `server/src/loops.ts` |
| L1 doctrine (bundled) | `server/templates/CLAUDE.md` |
| memory recall config | `server/src/loops.ts` (`.claude/settings.json` per loop) |
| auto-commit on writes | `server/src/workspace.ts` (`vaultWrite`) |
| chat → loop spawn | `server/src/chat.ts` |
| `.claude/` tier composition | `server/src/compose.ts`, `server/src/profiles.ts` |
| profile catalog | `knowledge/.loopat/profiles/<name>/.claude/` |

See `docs/sandbox.md` for deeper bwrap mechanics and the three-tier mount authority detail.

---

## Team Claude config + injection paths

How CLAUDE.md / skills / MCP servers / OAuth credentials reach the Claude
process running inside a loopat sandbox.

### Where team Claude config lives

All team-shared Claude Code config lives under the reserved namespace
`knowledge/.loopat/.claude/`:

```
LOOPAT_HOME/
├── config.json                                       # workspace runtime config (knowledge/notes/repos)
├── personal/<user>/.loopat/
│   ├── config.json                                   # per-user config (providers, default, shell)
│   └── vaults/<name>/                                # one or more named credential bundles (default, dev, prod, ...)
│       ├── envs/<NAME>                               # auto-injected env var; also feeds ${VAR} in apiKey
│       └── mounts/home/<rel>/...                     # auto-bound at sandbox $HOME/<rel>/...
└── context/knowledge/
    └── .loopat/claude/                               # team-shared Claude config
        ├── CLAUDE.md     (optional)                  # team prompt supplement
        ├── claude.json   (optional)                  # { mcpServers, ... }
        └── skills/       (optional)                  # team SKILL.md folders
```

Rules:

- Everything under `.loopat/` (in either `knowledge/` or `personal/<user>/`) is
  **platform-conventioned**: loopat knows the path and the semantics. Content
  ownership is still the user/team's; `.loopat/` only marks "loopat will look
  here and do something."
- Everything else under `knowledge/` is plain team docs; everything else under
  `personal/<user>/` is user-owned freeform space.
- Workspace `config.json` is **team-shared** (knowledge/notes/repos URLs only).
  Per-user fields (providers, default, shell) live in
  `personal/<user>/.loopat/config.json`. There is no `mounts` or `envs` field —
  those are conventional, derived from vault filesystem layout (see next bullet).
  Operator `mounts` live in workspace `config.json` and can name any host path
  (cross-user shared caches like `/etc/pki/ca-trust`).
- `personal/<user>/.loopat/vaults/<name>/` has two convention directories that
  drive automatic sandbox delivery at spawn time:
  - `envs/<NAME>` — file content is injected as env var `$NAME` (also feeds
    `${VAR}` substitution in provider `apiKey`).
  - `mounts/home/<rel>/...` — each top-level entry is `--bind`'d into the
    sandbox at `$HOME/<rel>/...`.
  Each loop picks one active vault (`meta.config.vault`, default `"default"`).
  No symlink, no `/loopat/context/vault` entrypoint — AI sees a configured
  machine, not a "vault" concept.

### Five injection paths

Five distinct pieces, three injection mechanisms.

| Piece | Source | How it reaches sandbox claude | Loaded by |
|---|---|---|---|
| **Platform doctrine** (always) | `server/templates/CLAUDE.md` | `systemPrompt.append` via SDK | loopat |
| **Team CLAUDE.md** (optional) | `knowledge/.loopat/.claude/CLAUDE.md` | ro-bind → `$CLAUDE_CONFIG_DIR/CLAUDE.md` | Claude Code (user-tier) |
| **Project CLAUDE.md** (optional) | `<workdir>/CLAUDE.md` | nothing — exists in workdir | Claude Code (project-tier) |
| **Skills** (optional) | `knowledge/.loopat/.claude/skills/` | ro-bind → `$CLAUDE_CONFIG_DIR/skills/` | Claude Code (user-tier) |
| **MCP servers** (optional) | `knowledge/.loopat/.claude/settings.json` | server reads → SDK `mcpServers` option (as-is) | loopat |
| **MCP OAuth tokens** (optional) | host `~/.claude/.credentials.json` | ro-bind → `$CLAUDE_CONFIG_DIR/.credentials.json` | Claude Code |
| **Runtime block** (always) | computed | `systemPrompt.append` via SDK | loopat |

Mechanism summary:

1. **`systemPrompt.append`** — server reads file, concatenates into the SDK's
   `query({ systemPrompt: { type: 'preset', preset: 'claude_code', append } })`.
   Used for content loopat must always inject (platform doctrine, runtime).
2. **ro-bind to `$CLAUDE_CONFIG_DIR/*`** — bwrap mount; Claude Code natively
   auto-discovers as if those files were in `~/.claude/`. Used for team
   supplements that don't need transformation.
3. **SDK option pass-through** — server reads, passes object via
   `query({ mcpServers })`. Currently only used for team MCP config; could
   move to bind path if we never need server-side transformation.

`settingSources: ["user", "project"]` is what makes Claude Code load both
`$CLAUDE_CONFIG_DIR/CLAUDE.md` (user) and `<workdir>/CLAUDE.md` (project).

### MCP server config schema

`knowledge/.loopat/.claude/settings.json` shape (mirrors `.claude.json`):

```json
{
  "mcpServers": {
    "<name>": {
      "type": "http" | "sse" | "stdio",
      "url": "...",                                  // http/sse
      "command": "...", "args": [...], "env": {...}, // stdio
      "headers": { "Authorization": "Bearer <literal>" } // http/sse
    }
  }
}
```

Auth styles:

- **Static (API key / PAT)** — put the literal token in `env`/`headers`.
  Since this file lives in `knowledge/` (team-shared), only commit
  shareable tokens. For per-user static tokens, future work is a personal
  MCP config at `personal/<user>/.loopat/claude/claude.json`.
- **OAuth** — no static token. Claude Code's built-in MCP OAuth client
  uses `~/.claude/.credentials.json` (host driver's file, ro-bound into
  the sandbox). On first MCP request, Claude Code reads existing tokens;
  refresh-on-expiry currently fails because the bind is ro (separate
  flow needed).

### Permission model gotcha (canUseTool)

Built-in tools (Read/Bash/...) run under `permissionMode: "bypassPermissions"`
+ `allowDangerouslySkipPermissions: true` — they skip the `canUseTool`
callback entirely.

**MCP tools always route through `canUseTool`**, regardless of bypass flags.
The callback must return a SDK-schema-valid result:

- `{ behavior: "allow", updatedInput: <record> }` — echo the input back
- `{ behavior: "deny", message: <string> }`

A bare `{ behavior: "allow" }` works for built-ins (which skip the callback)
but trips a ZodError the first time an MCP tool is invoked.
