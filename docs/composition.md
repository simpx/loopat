---
title: .claude composition
tags: [loopat, .claude, composition]
status: living doc
---

# `.claude` composition

> **Loopat extends Claude Code's `.claude/` config model with two extra tiers
> for team sharing — same files, same fields, more layers.** Every artifact
> Claude Code natively understands works in loopat without changes; you just
> get four more places to put them.

<p align="center">
  <img src="composition.svg" alt="five .claude tiers compose into one loop runtime" width="100%">
</p>

When a team shares an AI workspace, configuration multiplies fast: each role
needs different skills, each on-call rotation wants different MCP servers, each
person has their own credentials and habits. The standard answer is "everyone
runs their own CLI with their own `~/.claude/`" — fine for one person, painful
across a team.

Loopat's answer: **don't invent a new config system; just add tiers to the one
Claude Code already has.** Skills, agents, plugins, MCP servers, hooks — all
live in `.claude/` directories at every tier, and loopat merges them before the
SDK starts. The agent sees a single CC-native `.claude/` and doesn't know there
were ever five sources.

---

## Mental model in one line

Claude Code ships with **three setting source tiers — user · project · local**.
**Loopat adds two more — workspace · profile.** Same `.claude/` shape at every
tier. The first three are merged by loopat into the SDK's user tier; the last
two are read by the SDK directly from the workdir.

| Tier | Native to | Lives at | Scope | How it reaches the SDK |
|---|---|---|---|---|
| **workspace** | loopat | `knowledge/.loopat/.claude/` | the whole team | merged into user tier by loopat |
| **profile** | loopat | `knowledge/.loopat/profiles/<name>/.claude/` | opt-in role / mode | merged into user tier by loopat |
| **user (personal)** | Claude Code | `personal/<user>/.loopat/.claude/` | one team member | merged into user tier by loopat |
| **project** | Claude Code | `workdir/.claude/` | one repo | read directly by SDK |
| **local** | Claude Code | `workdir/.claude/*.local.*` | one local checkout | read directly by SDK |

Override order is **strongest at the bottom of the table** — `local` beats
everything, and within the merged user tier `personal` beats every other
loopat-managed source.

---

## CC-compatible by design

If you have ever configured Claude Code, you have already learned loopat.

- **Same directory layout.** `.claude/settings.json`, `.claude/CLAUDE.md`,
  `.claude/skills/<name>/SKILL.md`, `.claude/agents/<name>.md` — everywhere.
- **Same setting fields.** `enabledPlugins`, `mcpServers`,
  `extraKnownMarketplaces`, `hooks`, `permissions`, `model` — they all
  behave exactly like Claude Code's docs describe.
- **Same conventions for "drop in to enable".** A `SKILL.md` in any
  `.claude/skills/<name>/` works. An `.md` in any `.claude/agents/` works.
  No new schemas.

Loopat invents nothing inside `.claude/`. The only thing loopat invents is
**where additional `.claude/` directories can live** — namely the workspace
and profile tiers. Once merged, the output is a perfectly ordinary `.claude/`
that any Claude Code reader (CLI, SDK, docs example) understands.

The practical payoff: when CC adds a new field to `.claude/settings.json`,
loopat picks it up for free. When you onboard a teammate, they already know
half the config from prior CC experience.

---

## How the SDK sees `.claude/`

A common assumption: *"the SDK is a thin wrapper; it doesn't read filesystem
config."* That is wrong — **the Claude Agent SDK is built on the same engine
as the Claude Code CLI, and it fully understands `.claude/`**. The
`settingSources` option controls which tiers it reads:

```ts
query({
  options: {
    settingSources: ["user", "project", "local"],
    // SDK auto-loads $CLAUDE_CONFIG_DIR/* (user tier),
    // <cwd>/.claude/* (project tier), and *.local.* (local tier).
  }
})
```

Loopat's job is therefore **not** to feed config into the SDK. Loopat's job
is to **assemble the merged `.claude/` directory and point `CLAUDE_CONFIG_DIR`
at it**. The SDK then walks the directory the same way the CLI would. Two
narrow channels stay outside this filesystem path — both because the sandbox
isolates host state that would otherwise carry the data:

- **MCP server credentials.** The MCP server *configuration* (transport,
  command, headers, env keys) lives in `.claude/settings.json` like
  everything else — it gets merged and lands on disk in
  `loops/<id>/.claude/settings.json`. But **credentials** (api keys, OAuth
  bearer tokens) come from the loop's selected vault at spawn time. Loopat
  reads the merged server list, injects the vault credentials into each
  server's `env` / `headers`, and passes the augmented list via the
  `mcpServers:` SDK option. Secrets never get written to settings.json on
  disk. See the MCP deep-dive below.
- **The loopat builtin plugin.** Loopat ships one bundled plugin that lives
  inside the loopat install directory, not in CC's plugin cache. It's
  passed via the `plugins:` SDK option. All other plugins are declared in
  `enabledPlugins` and resolved natively by the SDK from
  `~/.claude/plugins/` (ro-bound into the sandbox).

Everything else — skills, agents, hooks, `CLAUDE.md`, marketplace plugin
selection — is read by the SDK directly from the composed `.claude/`.

---

## How the merge works

Each tier is a complete, standalone `.claude/` directory. Loopat walks them
in order (workspace → profile-1 → … → profile-N → personal) and merges by
content type:

| Content | Merge rule |
|---|---|
| `settings.json` | Deep shallow union per top-level key. `enabledPlugins`, `mcpServers`, `extraKnownMarketplaces`, `hooks` merge by sub-key — **later tier wins per key**. So a personal tier can flip `enabledPlugins["foo@bar"]` to `false` and override a team default. |
| `CLAUDE.md` | Concatenated in tier order, with `## <tier>` section headers. Each tier's doctrine layers on top of the previous. |
| `skills/<name>/` | Symlink union. Same-name skill in a later tier shadows the earlier one. |
| `agents/<name>.md` | Symlink union, same rule. |
| `mise.toml` / `mise.lock` | TOML table-level union — `[tools]` and `[env]` sections each merge by key. |

The result is written to `loops/<loop-id>/.claude/`. When the SDK starts,
`CLAUDE_CONFIG_DIR` points here and CC's user tier reads it directly.

**Inside the sandbox, two `.claude/` directories actually exist** — and
that's by design:

1. **`loops/<id>/.claude/`** — the merged user tier, the loopat-composed
   source of truth. Mounted at the SDK's `CLAUDE_CONFIG_DIR`.
2. **`<workdir>/.claude/`** — the repo's own `.claude/`, read as project
   tier (and local tier for `*.local.*` files) directly by the SDK. Loopat
   does not merge this; the repo contributes whatever it contributes.

There is no third `.claude/` — **the sandbox does not see your host
machine's `~/.claude/`**. The sandbox `$HOME` is a fresh overlay with an
empty lower layer, so any host-side CC configuration you have outside of
the workspace stays outside. This is intentional: loops are reproducible
because they don't depend on whatever happens to be in your home directory.

(There is one host-side exception: the directory `~/.claude/plugins/` is
ro-bound wholesale so the SDK can resolve marketplace plugins. Sibling
files like `~/.claude.json` and `~/.claude/.credentials.json` stay
invisible — see the next section.)

---

## What about `~/.claude.json`?

`~/.claude.json` is Claude Code's host-side application state file —
**different from `~/.claude/settings.json`**. It tracks:

- account / OAuth state, onboarding completion, notification history
- top-level `mcpServers` — globally-registered MCP servers
- `projects.<cwd>` — per-directory state including `mcpServers` (what
  `claude mcp add` writes), `allowedTools`, trust-dialog acceptance,
  session usage stats

In other words, it's the file CC mutates as you use the CLI on your host
machine: every `claude mcp add`, every project you've ever opened, every
permissions choice. **Loopat never reads or writes `~/.claude.json`**, and
the loopat sandbox can't see it (sandbox `$HOME` is an empty overlay).

What this means for your mental model:

- **Adding an MCP server via `claude mcp add` on your host does NOT make
  it available in loops.** That command writes to `~/.claude.json`, which
  the sandbox doesn't see.
- **To use an MCP server in a loop, declare it in some `.claude/settings.json`
  tier** (workspace / profile / personal). Loopat will merge it and the SDK
  will start it.
- **Host CC and loopat loops have disjoint MCP sets.** This is a feature:
  loops are reproducible regardless of what host CC happens to know about.

The one thing that *is* shared between host and sandbox is the **plugin
install cache** (`~/.claude/plugins/` — a directory, not the
`.claude.json` file). Loopat ro-binds it so the SDK inside the sandbox can
resolve `enabledPlugins` natively. Plugin install state is a small,
file-tree-shaped global; mixing it doesn't compromise the
reproducibility story the way MCP-on-host-CLI would.

---

## Putting things in `.claude/`: what gets tiered

Anything that lives inside `.claude/` automatically gets the five-tier
treatment. That includes everything Claude Code natively supports, plus
small loopat-side extensions:

- **Skills** — `.claude/skills/<name>/SKILL.md` — reusable named procedures
  invoked as `/<skill-name>`. Drop one in any tier; it becomes available
  to every loop that selects that tier.
- **Subagents** — `.claude/agents/<name>.md` — delegated agents the main
  Claude can hand work to. Frontmatter declares `description`, `tools`,
  `model`; body is the agent's system prompt.
- **MCP servers** — declared in `.claude/settings.json` under `mcpServers`.
  Loopat injects vault credentials at spawn so secrets never sit in
  config files.
- **Plugins** — declared in `.claude/settings.json` under `enabledPlugins`
  and (when needed) `extraKnownMarketplaces`. The plugin itself stays in
  Claude Code's standard plugin cache; loopat ensures it gets installed
  on the host and visible to the sandbox.
- **Hooks** — declared in `.claude/settings.json` under `hooks`. Scripts
  triggered on `SessionStart`, `PreToolUse`, `PostToolUse`, etc.
- **`CLAUDE.md`** — team doctrine, role expectations, system prompt
  fragments. Concatenated across tiers.
- **Mise toolchain** — `.claude/mise.toml` + `.claude/mise.lock`. Loopat's
  own addition: pins the version of every tool the loop's shell will see.
  Team can pin Node, profile can add Python, personal can override a single
  version — same merge model.
- **Other CC fields** — anything else in `.claude/settings.json`
  (`permissions`, `model`, output styles, statusline, future fields)
  gets the same per-key tier union for free.

The rule of thumb: **want to share something across the team or selectively
across roles? Express it as a `.claude/` artifact and put it in the tier
that owns it.** Loopat handles the rest.

---

## Capability reference

For each capability: what it is, where its definition lives, how it gets
turned on, how credentials are handled (if any), how plain CC / the SDK /
loopat each activate it, and where it lands inside the sandbox.

| | **Skill** | **Subagent** | **MCP server** | **Plugin** | **Hook** | **Mise toolchain** |
|---|---|---|---|---|---|---|
| **What it is · when to use it** | A named procedure invocable as `/<name>`. Stable, repeated workflows you want the human to trigger by name. | A delegated agent with its own prompt, tool restrictions, and model. The main agent hands work off via the `Task` tool. | A long-running process that exposes external tools (Jira, GitHub, internal APIs) to Claude over stdio / HTTP / SSE. | A distributable bundle of skills + agents + MCP + hooks, with marketplace metadata for cross-team sharing. | A script triggered on lifecycle events (`SessionStart`, `PreToolUse`, `PostToolUse`, …). | Pinned tool versions (Node, Python, etc.) so every loop's shell sees the same toolchain. *(loopat extension)* |
| **Where to define** | `.claude/skills/<name>/SKILL.md` plus optional siblings in the same directory. | `.claude/agents/<name>.md` — single file, frontmatter + body. | `.claude/settings.json` → `mcpServers.<name>: { type, command, args, headers, env, … }`. | `.claude/settings.json` → `enabledPlugins["foo@market"]: true` (+ `extraKnownMarketplaces` if not built in). | `.claude/settings.json` → `hooks.<event>: [{ matcher, hooks: […] }]`. | `.claude/mise.toml` (versions) + `.claude/mise.lock` (lockfile). |
| **How to enable** | Presence-based. Drop the directory in; it's enabled. | Presence-based. Drop the file in; it's enabled. | Presence-based, key by key. Listing the server under `mcpServers` enables it; remove the key to disable. | **Explicit flag required.** `enabledPlugins["foo@market"]: true`. Files in `~/.claude/plugins/` alone don't enable anything. | Presence-based per event. Listing a hook under `hooks.<event>` enables it. | Presence-based. Listing a tool in `[tools]` enables it for the loop's shell. |
| **How auth works** | None — skills are just markdown. | None — agents are just markdown + prompt. | **Loopat reads the selected vault and injects credentials into `env` / `headers` at spawn**; the augmented config is passed via the `mcpServers:` SDK option. Plain CC stores OAuth in `~/.claude/.credentials.json`; loopat instead manages tokens per-vault. | Marketplace install may need git auth (SSH key, HTTPS PAT) — runs on host, uses host's git creds. Plugins themselves usually don't carry their own auth (their bundled MCPs do, see above). | None — hooks are just scripts; whatever creds they need they read themselves. | None — `mise install` runs in the host with whatever creds it already has (rare). |
| **How plain CC activates it** | CC scans `<config-dir>/skills/` at session start; available immediately. | CC scans `<config-dir>/agents/`; subagents listed via Task tool. | CC reads `mcpServers` from each settings tier and starts each server at session init. | Resolves spec → `~/.claude/plugins/installed_plugins.json` → loads installPath. Requires the user to have run `claude plugin install <spec>` first. | CC registers the hooks at session init; invokes the script when the matching event fires. | Not a CC concept. (Mise activates outside of CC.) |
| **How the SDK activates it** | Discovered via `settingSources` (`'user'`, `'project'`). Narrowing option: `skills: 'all' \| string[]`. | Discovered via `settingSources` *or* defined programmatically via `agents: { <name>: { ... } }`. | Either via `settingSources` (settings.json) *or* directly via the `mcpServers:` option (loopat uses this so it can inject credentials). | Either via `settingSources` (CC plugin cache resolution) *or* programmatically via `plugins: [{type:"local", path:...}]`. | Either via `settingSources` *or* programmatically via the `hooks:` option. | Not an SDK concept. |
| **How loopat activates it** | Drop into any tier's `.claude/skills/`. Merged into `loops/<id>/.claude/skills/` as a symlink union; SDK discovers via `settingSources: 'user'`. | Drop into any tier's `.claude/agents/`. Same merge mechanism. | Add to any tier's `.claude/settings.json` `mcpServers`. Compose merges by key; loopat then reads the selected vault, injects credentials, and passes the augmented map via the `mcpServers:` SDK option. | Add to any tier's `.claude/settings.json` `enabledPlugins`. Compose merges. `ensureLoopPluginsInstalled` runs `claude plugin install` on host for anything missing; bwrap ro-binds `~/.claude/plugins/` wholesale so SDK resolves natively. | Add to any tier's `.claude/settings.json` `hooks`. Standard `settingSources` discovery. | Add to any tier's `.claude/mise.toml`. Bwrap runs `mise install` + `mise env --json` on the merged file before sandbox spawn and injects `PATH` / env via `--setenv`. |
| **Where it lands in the sandbox** | `loops/<id>/.claude/skills/<name>/` — a symlink to the source tier's host path. | `loops/<id>/.claude/agents/<name>.md` — symlink to the source tier's host path. | Server config lives in `loops/<id>/.claude/settings.json` (no creds). Augmented config (with creds) reaches the SDK in memory; the running server is a regular host process the SDK talks to. | Plugin code is at `~/.claude/plugins/marketplaces/<m>/plugins/<n>/` (ro-bound wholesale into the sandbox). Activation is via the loop's merged `enabledPlugins`. | `loops/<id>/.claude/settings.json` hooks field; script lives at its source tier's host path (covered by the workspace / personal binds). | `loops/<id>/.claude/mise.toml` + injected env vars; tool binaries from host `~/.local/share/mise/` (also bound in). |

---

## Where to look next

- [`architecture.md`](architecture.md) — sandbox / vault model, read &
  write paths, full bwrap layout.
- [`composition.svg`](composition.svg) — the diagram on its own.
- [`design/sample-workspace/`](design/sample-workspace/) — a concrete
  example workspace showing all five tiers populated.
- Source of truth: [`server/src/compose.ts`](../server/src/compose.ts) and
  [`server/src/profiles.ts`](../server/src/profiles.ts).
