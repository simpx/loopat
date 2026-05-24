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

Loopat's answer: **don't invent a new config system; just add tiers to the
one Claude Code already has.** Skills, agents, plugins, MCP servers, hooks —
all live in `.claude/` directories at every tier, and loopat merges them
before the SDK starts. The agent sees a single CC-native `.claude/` and
doesn't know there were ever five sources.

---

## Mental model in one line

Claude Code ships with **three setting source tiers — user · project · local**.
**Loopat adds two more — workspace · profile.** Same `.claude/` shape at every
tier. Five layers in, one merged `.claude/` out, fed to the SDK as the user
tier.

| Tier | Native to | Lives at | Scope |
|---|---|---|---|
| **workspace** | loopat | `knowledge/.loopat/.claude/` | the whole team |
| **profile** | loopat | `…/.loopat/profiles/<name>/.claude/` | opt-in role / mode (eng, oncall, …) |
| **user** | Claude Code | `personal/<user>/.claude/` (in loopat) | one team member |
| **project** | Claude Code | `<workdir>/.claude/` | one repo |
| **local** | Claude Code | `<workdir>/.claude/settings.local.*` | one local checkout |

The first two tiers are loopat's contribution. The last three are vanilla
Claude Code. Same files, same fields, just more layering.

---

## CC-compatible by design

If you have ever configured Claude Code, you have already learned loopat.

- **Same directory layout.** `.claude/settings.json`, `.claude/CLAUDE.md`,
  `.claude/skills/<name>/SKILL.md`, `.claude/agents/<name>.md` — everywhere.
- **Same setting fields.** `enabledPlugins`, `mcpServers`,
  `extraKnownMarketplaces`, `hooks`, `permissions`, `model` — they all
  behave exactly like Claude Code's docs describe.
- **Same conventions for "drop in to enable".** A `SKILL.md` in any
  `.claude/skills/<name>/` works. An `.md` in any `.claude/agents/`
  works. No new schemas.

Loopat invents nothing inside `.claude/`. The only thing loopat invents is
**where additional `.claude/` directories can live** — namely the workspace
and profile tiers. Once merged, the output is a perfectly ordinary
`.claude/` that any Claude Code reader (CLI, SDK, docs example) understands.

The practical payoff: when CC adds a new field to `.claude/settings.json`,
loopat picks it up for free. When you train a teammate, they already know
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
    // SDK now auto-loads $CLAUDE_CONFIG_DIR/.claude/* (user tier),
    // <cwd>/.claude/* (project tier), and local override files.
  }
})
```

Loopat's job is therefore **not** to feed config into the SDK. Loopat's job
is to **assemble the merged `.claude/` directory and point `CLAUDE_CONFIG_DIR`
at it**. The SDK then walks the directory the same way the CLI would.

Two narrow exceptions go through SDK options instead of settings.json,
because the sandbox isolates host state that would otherwise carry the
information:

- **MCP servers** — loopat injects credentials from the active vault
  (`apiKey`, OAuth tokens, …) at spawn time. Static `settings.json` can't
  carry runtime-resolved env vars, so the merged server list is passed via
  the `mcpServers:` SDK option.
- **The loopat builtin plugin** — loopat ships one bundled plugin that lives
  inside the loopat install directory, not in CC's plugin cache. It's
  passed via the `plugins:` SDK option. All other (marketplace) plugins
  are declared in `enabledPlugins` and resolved natively by the SDK.

Everything else — skills, agents, hooks, `CLAUDE.md`, marketplace plugin
selection — is read by the SDK directly from the composed `.claude/`.

---

## How the merge works

Each tier is a complete, standalone `.claude/` directory. Loopat walks them
in order (workspace → profile-1 → … → profile-N → personal) and merges by
content type:

| Content | Merge rule |
|---|---|
| `settings.json` | Deep shallow union per top-level key. `enabledPlugins`, `mcpServers`, `extraKnownMarketplaces`, `hooks` merge by sub-key — **later tier wins per key**. So a `personal` tier can flip an `enabledPlugins["foo@bar"]` to `false` and override the team default. |
| `CLAUDE.md` | Concatenated in tier order, with `## <tier>` section headers. Each tier's doctrine layers on top of the previous. |
| `skills/<name>/` | Symlink union. Same-name skill in a later tier shadows the earlier one. |
| `agents/<name>.md` | Symlink union, same rule. |
| `mise.toml` / `mise.lock` | TOML table-level union — `[tools]` and `[env]` sections each merge by key. |

The result is written to `loops/<loop-id>/.claude/`. When the SDK starts,
`CLAUDE_CONFIG_DIR` points here and CC's user tier reads it directly.

**Inside the sandbox, two `.claude/` directories actually exist** — and
that's by design:

1. **`loops/<id>/.claude/`** — the merged user tier, the loopat-composed
   source of truth.
2. **`<workdir>/.claude/`** — the repo's own `.claude/`, read as project
   tier directly by the SDK. Loopat does not merge this; the repo
   contributes whatever it contributes.

There is no third `.claude/` — **the sandbox does not see your host
machine's `~/.claude/`**. The sandbox `$HOME` is a fresh overlay with an
empty lower layer, so any host-side CC configuration you have outside of
the workspace stays outside. This is intentional: loops are reproducible
because they don't depend on whatever happens to be in your home directory.

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
  (`permissions`, `model`, `output styles`, `statusline`, future fields)
  gets the same per-key tier union for free.

The rule of thumb: **want to share something across the team or selectively
across roles? Express it as a `.claude/` artifact and put it in the tier
that owns it.** Loopat handles the rest.

---

## Capability reference

Detailed breakdown of each capability across the activation paths — what it
is, where it sits, how plain Claude Code activates it, how the SDK activates
it programmatically, how loopat enables it across tiers, and where it ends
up inside the sandbox.

| | **Skill** | **Subagent** | **MCP server** | **Plugin** | **Hook** | **Mise toolchain** |
|---|---|---|---|---|---|---|
| **What it is** | A named procedure invocable as `/<name>`. Stable, repeated workflows you want the human to trigger by name. | A delegated agent with its own prompt, tool restrictions, and model. The main agent hands work off via the `Task` tool. | A long-running process that exposes external tools (Jira, GitHub, internal APIs) to Claude. | A distributable bundle of skills + agents + MCP + hooks, with marketplace metadata for cross-team sharing. | A script triggered on events (`SessionStart`, `PreToolUse`, etc.). | Pinned tool versions (Node, Python, etc.) so every loop's shell sees the same toolchain. *(loopat extension)* |
| **Where in `.claude/`** | `.claude/skills/<name>/SKILL.md` (plus optional siblings). | `.claude/agents/<name>.md` — single file, frontmatter + body. | `.claude/settings.json` → `mcpServers.<name>: { ... }`. | `.claude/settings.json` → `enabledPlugins["foo@market"]: true` (+ `extraKnownMarketplaces` if not built in). | `.claude/settings.json` → `hooks.<event>: [ ... ]`. | `.claude/mise.toml` (versions) + `.claude/mise.lock` (lockfile). |
| **How CC enables it** | Drop the directory in. No enable flag — the file's presence is the enable. | Drop the file in. Same model as skills. | Listed in `mcpServers` → CC starts the server at session init. | Must be explicitly `true` in `enabledPlugins`. Dropping a plugin into `~/.claude/plugins/` is not enough. | Listed in `hooks` → CC invokes on the matching event. | Not a CC concept. |
| **How the SDK enables it** | `settingSources` must include `'user'` (and / or `'project'`); the directory is then discovered. Optional `skills: 'all' \| string[]` narrows visibility. | Either discovered via `settingSources`, or defined programmatically via `agents: { <name>: { ... } }` option. | Either via `settingSources` (settings.json `mcpServers`), or directly via `mcpServers:` SDK option. | Either via `settingSources` (`enabledPlugins` in settings.json), or directly via `plugins: [{type:"local", path:...}]` SDK option. | Either via `settingSources` (`hooks` in settings.json), or programmatically via `hooks:` option. | Not an SDK concept. |
| **How loopat enables it** | Drop into any tier's `.claude/skills/`. Merged in by `compose.ts` as a symlink union. | Drop into any tier's `.claude/agents/`. Same merge. | Add to any tier's `.claude/settings.json` `mcpServers`. Merged by key; loopat injects vault credentials at spawn. | Add to any tier's `.claude/settings.json` `enabledPlugins`. Loopat installs the plugin on the host if missing, then the SDK resolves it natively from `~/.claude/plugins/` (wholesale-bound into the sandbox). | Add to any tier's `.claude/settings.json` `hooks`. Standard SDK loading via `settingSources`. | Add to any tier's `.claude/mise.toml`. Loopat runs `mise install` + injects the resulting `PATH`/env into the sandbox. |
| **Where it lands in the sandbox** | `loops/<id>/.claude/skills/<name>/` (symlink to source tier). | `loops/<id>/.claude/agents/<name>.md` (symlink to source tier). | Not on disk — passed via the SDK process. | Plugin content stays at `~/.claude/plugins/...`, which is ro-bound wholesale into the sandbox. Activation is via the loop's merged `enabledPlugins`. | `loops/<id>/.claude/settings.json` `hooks` field; script lives at its source tier's host path (covered by the workspace / personal binds). | `loops/<id>/.claude/mise.toml` + injected env vars; tool binaries from host `~/.local/share/mise/` (also bound in). |

---

## Where to look next

- [`architecture.md`](architecture.md) — sandbox / vault model, read &
  write paths, full bwrap layout.
- [`composition.svg`](composition.svg) — the diagram on its own.
- [`design/sample-workspace/`](design/sample-workspace/) — a concrete
  example workspace showing all five tiers populated.
- Source of truth: [`server/src/compose.ts`](../server/src/compose.ts) and
  [`server/src/profiles.ts`](../server/src/profiles.ts).
