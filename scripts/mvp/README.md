# Loopat MVP (parallel POC)

> Parallel implementation of the **profile + plugin** composition model from
> [`../../docs/design/composition-model.md`](../../docs/design/composition-model.md).
>
> **Not integrated into the server**. Lives here so we can iterate on the model
> without disrupting the existing `sandboxes.ts` / `compose.ts` codepath.

---

## Why parallel

The existing server has a substantial sandbox model (single-name + `extends`
chain, ~600 lines across `sandboxes.ts` + `compose.ts` + `plugin-installer.ts`).
Replacing it inline would mean simultaneously refactoring back-end + UI +
migration logic before we know the new model is right.

This MVP is a **standalone POC** that:

- Reads the new `profile + plugin` shape from `docs/design/sample-workspace/`
- Orchestrates real `claude plugin install` calls (cross-marketplace too)
- Concatenates CLAUDE.md fragments
- Mounts profile knowledge dirs into a sandbox loop dir
- **Loads vault env vars + spawns claude** (with or without bwrap)

If we like the feel, we promote this code into `server/src/` and remove the
old sandbox machinery (破坏性替换).

---

## Run it

```bash
# Default: alice, sample workspace, dry-run shows the plan
bun scripts/mvp/cli.ts run --dry-run

# Real materialize (installs plugins, writes loop sandbox)
bun scripts/mvp/cli.ts run +mode-oncall

# Drop a default profile temporarily
bun scripts/mvp/cli.ts run +mode-oncall -role-security --dry-run

# Override defaults entirely (still keeps base)
bun scripts/mvp/cli.ts run --profiles=mode-incident --dry-run

# Materialize + launch claude directly
bun scripts/mvp/cli.ts run +mode-oncall --spawn

# Materialize + launch claude inside bubblewrap (isolated /loopat/* view)
bun scripts/mvp/cli.ts run +mode-oncall --bwrap

# Pass args to claude via `--`
bun scripts/mvp/cli.ts run +mode-oncall --bwrap -- --print "show pwd"

# Show vault env var names (not values)
bun scripts/mvp/cli.ts run +mode-oncall --dry-run --show-env

# Different user / workspace
bun scripts/mvp/cli.ts run --user bob --workspace /path/to/other/workspace
```

`--help` for full options.

---

## Files

| File | Purpose | LoC |
|------|---------|-----|
| `profiles.ts` | Read profile.json, compute active set, return PLAN (pure) | ~160 |
| `materialize.ts` | Execute plan: install plugins, concat CLAUDE.md, mount knowledge | ~180 |
| `vaults.ts` | Read `personal/<u>/vaults/<v>/*` files → env var map | ~50 |
| `spawn.ts` | Launch claude (direct or bwrap-wrapped) with vault env | ~115 |
| `cli.ts` | Argv parsing + orchestration + output | ~200 |
| `README.md` | This file | — |

Pure / side-effect separation:
- `profiles.ts` + `vaults.ts` are pure — `--dry-run` runs only these
- `materialize.ts` + `spawn.ts` do side effects (CC install + spawn)

---

## What's done

- ✅ Profile resolver: `default_profiles` + CLI `+x -y` + `--profiles=` override
- ✅ Plugin union/dedup across active profiles
- ✅ Local marketplace auto-registration (`claude plugin marketplace add`)
- ✅ Cross-marketplace plugin install orchestration (CC alone can't)
- ✅ CLAUDE.md concat with source markers
- ✅ Knowledge dir mount (symlinks per profile, separated by source)
- ✅ Idempotency — re-run skips already-installed plugins
- ✅ Missing profile detection (clean error)
- ✅ **Vault env loader** (filename → env var name convention)
- ✅ **Direct spawn** (cwd=loopDir, vault env injected to claude process)
- ✅ **Bwrap spawn** (virtual `/loopat/loop`, `/loopat/knowledge`, `/loopat/vault`)
- ✅ Pass-through args to claude via `--`

## What's NOT done (intentionally deferred)

- ❌ Workspace-global knowledge auto-mount in non-bwrap mode (bwrap does it)
- ❌ Plugin lock / version pinning (no CC support yet either)
- ❌ Workdir / repo binding (loop dir is the cwd; no separate workdir mount)
- ❌ UI (CLI only)
- ❌ Integration with running server / loop spawn flow / DB

These are the "promote into server/src/" items.

---

## Tested scenarios (2026-05)

| Scenario | Result |
|----------|--------|
| `--dry-run` | shows plan + vault info, no side effects |
| `+mode-oncall` | 2 plugins installed, 5 CLAUDE.md sections, 3 vault vars |
| `+mode-oncall -role-security` | role-security cleanly removed |
| Cross-marketplace dep (`frontend-design@claude-plugins-official`) | installed alongside local plugins |
| Re-run same args | idempotent (already-installed skipped) |
| Unknown profile name | clean error |
| `--spawn` | claude launched in loopDir with vault env injected; claude saw INTERNAL_API_TOKEN |
| `--bwrap` | claude launched in bwrap, saw `/loopat/loop`, `/loopat/knowledge`, `/loopat/vault` |
| Bwrap + claude bash `ls /loopat/vault` | returned 3 env files (GITHUB_TOKEN, INTERNAL_API_TOKEN, PAGERDUTY_TOKEN) |

---

## See also

- [`../../docs/design/composition-model.md`](../../docs/design/composition-model.md) — concept
- [`../../docs/design/sample-workspace/`](../../docs/design/sample-workspace/) — test data
- [`../../docs/design/sample-workspace/EXAMPLE-COMPOSITION.md`](../../docs/design/sample-workspace/EXAMPLE-COMPOSITION.md) — walkthrough
- `server/src/bwrap.ts` — production bwrap reference (538 lines, more mounts + overlayfs + member mount tiers)
