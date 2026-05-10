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
├── config.json                                # loopat runtime config (providers, repos, sandbox.mounts)
├── personal/<user>/secrets/<service>/<VAR>    # per-user secret files (env-var name = filename)
└── context/knowledge/
    └── .loopat/claude/                        # team-shared Claude config
        ├── CLAUDE.md     (optional)           # team prompt supplement
        ├── claude.json   (optional)           # { mcpServers, ... }
        └── skills/       (optional)           # team SKILL.md folders
```

Rules:

- Everything under `.loopat/` is **platform-reserved**. Everything else under
  `knowledge/` is plain team docs.
- `config.json` is **loopat runtime** (providers, repos, sandbox mounts). It
  does NOT hold Claude Code config — that's under `.loopat/claude/`.
- `personal/<user>/secrets/<service>/<VAR>` follows the ccx convention:
  filename = env-var name, file body = value.

## 2. Five injection paths

Five distinct pieces, three injection mechanisms.

| Piece | Source | How it reaches sandbox claude | Loaded by |
|---|---|---|---|
| **Platform doctrine** (always) | `server/templates/CLAUDE.md` | `systemPrompt.append` via SDK | loopat |
| **Team CLAUDE.md** (optional) | `knowledge/.loopat/claude/CLAUDE.md` | ro-bind → `$CLAUDE_CONFIG_DIR/CLAUDE.md` | Claude Code (user-tier) |
| **Project CLAUDE.md** (optional) | `<workdir>/CLAUDE.md` | nothing — exists in workdir | Claude Code (project-tier) |
| **Skills** (optional) | `knowledge/.loopat/claude/skills/` | ro-bind → `$CLAUDE_CONFIG_DIR/skills/` | Claude Code (user-tier) |
| **MCP servers** (optional) | `knowledge/.loopat/claude/claude.json` | server reads → `${VAR}` substitute → SDK `mcpServers` option | loopat |
| **MCP OAuth tokens** (optional) | host `~/.claude/.credentials.json` | ro-bind → `$CLAUDE_CONFIG_DIR/.credentials.json` | Claude Code |
| **Runtime block** (always) | computed | `systemPrompt.append` via SDK | loopat |

Mechanism summary:

1. **`systemPrompt.append`** — server reads file, concatenates into the SDK's
   `query({ systemPrompt: { type: 'preset', preset: 'claude_code', append } })`.
   Used for content loopat must always inject (platform doctrine, runtime).
2. **ro-bind to `$CLAUDE_CONFIG_DIR/*`** — bwrap mount; Claude Code natively
   auto-discovers as if those files were in `~/.claude/`. Used for team
   supplements that don't need transformation.
3. **SDK option pass-through** — server reads, transforms, passes object via
   `query({ mcpServers })`. Used for content that needs server-side
   transformation (secret substitution).

`settingSources: ["user", "project"]` is what makes Claude Code load both
`$CLAUDE_CONFIG_DIR/CLAUDE.md` (user) and `<workdir>/CLAUDE.md` (project).

## 3. Why mcpServers can't use the bind path

The bind path is simpler — Claude Code parses natively, loopat doesn't need
per-feature plumbing. So why not use it for `claude.json` too?

**Secret substitution.** `claude.json` may reference `${VAR}` placeholders
(e.g. `Authorization: "Bearer ${COOP_TOKEN}"`). These resolve against
`personal/<user>/secrets/<service>/<VAR>` files on the host. The hard
constraint is: **secret files must never enter the sandbox.**

If we bind the raw `claude.json` in, Claude Code sees the literal
`${COOP_TOKEN}` string — no substitution, MCP auth fails.

If we substitute to a temp file and bind it in, the substituted file lives
on host disk in plaintext — secret leak.

If we substitute and bind via `bwrap --ro-bind-data` (fd-based, in-memory),
it works — but it's strictly more complex than passing the substituted
object through the SDK `mcpServers` option. The SDK option route keeps the
substituted secret in server process memory only, never on disk.

So `mcpServers` stays on path 3 (SDK pass-through). If `claude.json` ever
grows fields that don't need substitution (`hooks`, `permissions`,
`statusLine`...), we can split — substituted fields via SDK, the rest via
bind.

## 4. MCP server config schema

`knowledge/.loopat/claude/claude.json` shape (mirrors `.claude.json`):

```json
{
  "mcpServers": {
    "<name>": {
      "type": "http" | "sse" | "stdio",
      "url": "...",                                  // http/sse
      "command": "...", "args": [...], "env": {...}, // stdio
      "headers": { "Authorization": "Bearer ${VAR}" } // http/sse
    }
  }
}
```

Two auth styles:

- **Static (API key / PAT)** — write the token to
  `personal/<user>/secrets/<service>/<VAR>`, reference as `${VAR}` in
  `headers`. Server substitutes before passing to SDK.
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
