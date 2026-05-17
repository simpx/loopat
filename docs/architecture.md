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

---

## Loop = Sandbox × Vault (in words)

The one abstraction to internalize:

| Axis | What it picks | Who owns it | Storage |
|---|---|---|---|
| **Sandbox** | the **tools** the loop can use (mise toolchain + shell + MCP servers) | admin / team | `knowledge/.loopat/sandboxes/<name>/` |
| **Vault** | the **credentials** the loop runs as (apiKey, ssh, tokens) | individual / member | `personal/<user>/.loopat/vaults/<name>/` |

Examples that fall out:

- alice spawns `frontend × dev` — uses team frontend tools, her dev credentials
- alice spawns `frontend × test` — same tools, different identity
- bob spawns `frontend × test` — same tools as alice, **his own** test creds (alice can't see)
- carol spawns `sre × prod` — different tools, her prod credentials

Same engine, four cells of the matrix.

---

## Read path — what the agent learns from

Per turn, the agent's effective "context" is assembled from layered sources:

| Layer | Source on host | Loaded by | Scope |
|---|---|---|---|
| **L1 doctrine** | `server/templates/CLAUDE.md` | system-prompt builder, always | sandbox basics, path conventions |
| **L2 team** | `knowledge/.loopat/claude/CLAUDE.md` | ro-bind to `.claude/CLAUDE.md`, SDK loads as user-tier | workspace conventions |
| **L3 project** | `workdir/CLAUDE.md` | SDK loads from cwd | repo-specific conventions |
| **L4 runtime** | server-computed (loop id, title, branch, driver, vault, sandbox) | concatenated into system prompt | per-turn variables |
| **skills** | `knowledge/.loopat/claude/skills/` | ro-bind to `.claude/skills/`, SDK auto-discovers | callable procedures |
| **mcp** | `knowledge/.loopat/claude/claude.json` | passed to SDK at spawn | external tools (jira / github / …) |
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
| sandbox toolchain spec | `server/src/sandboxes.ts`, `knowledge/.loopat/sandboxes/<name>/` |

See `docs/sandbox.md` for deeper bwrap mechanics and the three-tier mount authority detail.
