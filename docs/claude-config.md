---
title: team Claude config + injection paths
tags: [loopat, architecture, claude, mcp, skills]
status: draft (review before promoting to knowledge/)
---

# Team Claude config + injection paths

How CLAUDE.md / skills / MCP servers / OAuth credentials reach the Claude
process running inside a loopat sandbox.

## 1. Where team Claude config lives

All team-shared Claude Code config lives under the reserved namespace
`knowledge/.loopat/claude/`:

```
LOOPAT_HOME/
├── config.json                                       # workspace runtime config (knowledge/notes/repos)
├── personal/<user>/.loopat/
│   ├── config.json                                   # per-user config (providers, default, sandbox.mounts)
│   └── secrets/
│       ├── provider-keys/<provider-name>             # loopat reads → provider.apiKey
│       └── <service>/<VAR>                           # user-owned tokens (filename = env-var name)
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
  Per-user fields (providers, default, sandbox.mounts) live in
  `personal/<user>/.loopat/config.json`.
- `personal/<user>/.loopat/secrets/<service>/<VAR>` follows the ccx convention:
  filename = env-var name, file body = value.

## 2. Five injection paths

Five distinct pieces, three injection mechanisms.

| Piece | Source | How it reaches sandbox claude | Loaded by |
|---|---|---|---|
| **Platform doctrine** (always) | `server/templates/CLAUDE.md` | `systemPrompt.append` via SDK | loopat |
| **Team CLAUDE.md** (optional) | `knowledge/.loopat/claude/CLAUDE.md` | ro-bind → `$CLAUDE_CONFIG_DIR/CLAUDE.md` | Claude Code (user-tier) |
| **Project CLAUDE.md** (optional) | `<workdir>/CLAUDE.md` | nothing — exists in workdir | Claude Code (project-tier) |
| **Skills** (optional) | `knowledge/.loopat/claude/skills/` | ro-bind → `$CLAUDE_CONFIG_DIR/skills/` | Claude Code (user-tier) |
| **MCP servers** (optional) | `knowledge/.loopat/claude/claude.json` | server reads → SDK `mcpServers` option (as-is) | loopat |
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

## 3. Why mcpServers currently uses the SDK option route

Historical: `claude.json` used to reference `${VAR}` placeholders resolved
against per-user secret files, with the constraint that secret files must
never enter the sandbox. That constraint forced the SDK option route (keeps
substituted strings in server process memory only, never on disk).

The `${VAR}` mechanism was removed (2026-05-12). MCP config is now passed
through as-is. Static-auth servers should keep tokens in `env`/`headers`
directly, or move to a personal-tier MCP config (future work).

Today the SDK option route remains because the rewrite hasn't been done;
the bind path would also work. Future cleanup: ro-bind
`knowledge/.loopat/claude/claude.json` into `$CLAUDE_CONFIG_DIR/claude.json`
and drop `loadTeamClaudeJson`.

## 4. MCP server config schema

`knowledge/.loopat/claude/claude.json` shape (mirrors `.claude.json`):

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
- **OAuth (coop / yuque / aone-* …)** — no static token. Claude Code's
  built-in MCP OAuth client uses `~/.claude/.credentials.json` (host driver's
  file, ro-bound into the sandbox). On first MCP request, Claude Code reads
  existing tokens; refresh-on-expiry currently fails because the bind is ro
  (separate flow needed).

## 5. Permission model gotcha (canUseTool)

Built-in tools (Read/Bash/...) run under `permissionMode: "bypassPermissions"`
+ `allowDangerouslySkipPermissions: true` — they skip the `canUseTool`
callback entirely.

**MCP tools always route through `canUseTool`**, regardless of bypass flags.
The callback must return a SDK-schema-valid result:

- `{ behavior: "allow", updatedInput: <record> }` — echo the input back
- `{ behavior: "deny", message: <string> }`

A bare `{ behavior: "allow" }` works for built-ins (which skip the callback)
but trips a ZodError the first time an MCP tool is invoked. Fixed in
`session.ts` to echo `updatedInput: input` on the allow paths.
