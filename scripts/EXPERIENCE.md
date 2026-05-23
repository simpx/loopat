# Experience the new loopat composition model

This is the "complete implementation" entry — backend modules promoted into
`server/src/`, plus a CLI driver. Uses a temp `LOOPAT_HOME=/tmp/loopat-experience`
so your real `~/.dashscope` isn't touched.

---

## Setup (once)

```bash
# Build a clean /tmp/loopat-experience from the sample workspace
bash scripts/setup-experience.sh
```

This materializes:

```
/tmp/loopat-experience/
├── context/
│   ├── profiles/{base, role-eng-backend, role-security, mode-oncall, mode-review}/
│   ├── plugins/{internal-mcp, pagerduty-mcp}/    ← CC local marketplace
│   ├── knowledge/company-handbook.md
│   └── notes/memory/MEMORY.md
├── personal/alice/
│   ├── .loopat/config.json                       ← default_profiles
│   ├── .loopat/vaults/dev/                       ← 3 placeholder tokens
│   └── CLAUDE.md
└── loops/                                        ← populated on `loopat run`
```

---

## Try it

```bash
export LOOPAT_HOME=/tmp/loopat-experience

# 1. List available profiles
bun scripts/loopat.ts list

# 2. Dry-run — see what would happen
bun scripts/loopat.ts run --dry-run
bun scripts/loopat.ts run +mode-oncall --dry-run

# 3. Materialize (without spawning claude) — see the sandbox dir
bun scripts/loopat.ts run +mode-oncall
ls /tmp/loopat-experience/loops/

# 4. Materialize + launch claude in bubblewrap (interactive)
bun scripts/loopat.ts run +mode-oncall --bwrap

# 5. Materialize + non-interactive print
bun scripts/loopat.ts run +mode-oncall --bwrap -- --print "what mode am I in?"

# 6. Add/remove profiles per loop
bun scripts/loopat.ts run +mode-oncall -role-security --bwrap
bun scripts/loopat.ts run --profiles=mode-incident --bwrap

# 7. Help
bun scripts/loopat.ts help
```

---

## What each command actually does

`run +mode-oncall --bwrap` triggers:

1. Read `/tmp/loopat-experience/personal/alice/.loopat/config.json` →
   `default_profiles: [role-eng-backend, role-security]`
2. Compute active set: `base + role-eng-backend + role-security + mode-oncall`
3. Union plugins: `internal-mcp@acme-internal, pagerduty-mcp@acme-internal`
4. Register the workspace local marketplace `acme-internal` with CC (idempotent)
5. `claude plugin install <each plugin>` — installs (skips if already there)
6. Concat 5 CLAUDE.md fragments (4 profiles + Alice's personal) →
   `/tmp/loopat-experience/loops/<id>/CLAUDE.md`
7. Symlink profile knowledge dirs →
   `/tmp/loopat-experience/loops/<id>/context/profile-knowledge/<profile>/`
8. Read vault files → env var dict
9. Launch claude in bwrap with:
   - `/loopat/loop` ← bind of `loops/<id>/` (rw)
   - `/loopat/knowledge` ← bind of `context/knowledge/` (ro)
   - `/loopat/vault` ← bind of `.loopat/vaults/dev/` (ro)
   - Vault env vars exported
   - cwd = `/loopat/loop` so CC picks up `CLAUDE.md` as project context

---

## How to confirm it's really working

Inside the claude session, ask:

```
What mode am I in per CLAUDE.md?
List the section markers (<!-- ========== X ==========) in your project CLAUDE.md.
Check if INTERNAL_API_TOKEN is set (yes/no, don't echo value).
What files are in /loopat/vault?
```

Expected: claude lists `base, role-eng-backend, role-security, mode-oncall, personal:alice`,
acknowledges INTERNAL_API_TOKEN exists, lists the 3 vault files.

---

## What's where

| File | Purpose |
|------|---------|
| `server/src/profiles.ts` | Profile resolver (production-track module) |
| `server/src/profile-materialize.ts` | Plugin install + concat + knowledge mount + vault env loader |
| `server/src/paths.ts` | Added `workspaceProfilesDir()` + related helpers |
| `scripts/loopat.ts` | CLI driver (uses the server modules) |
| `scripts/setup-experience.sh` | Builds `/tmp/loopat-experience` from sample |

---

## What's NOT done in this round

- Not wired into the running server's loop spawn HTTP path
- UI still uses the old sandbox model (don't touch web UI; will break if you do)
- `sandboxes.ts` / `compose.ts` / `plugin-installer.ts` / `bwrap.ts` / `loops.ts` unchanged
- No data migration from old sandbox layout to new profile layout

Next phases (separate sessions):
- Promote materializer into `loops.ts` spawn flow, retire `sandboxes.ts`
- Update `bwrap.ts` mount strategy for profile knowledge
- UI: replace sandbox dropdown with profile multi-select
