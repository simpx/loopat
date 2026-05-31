---
title: notes realtime — git as a consistency backend
tags: [loopat, notes, git, realtime, collaboration]
status: design (stage 0 implemented)
---

# notes realtime (git-as-database)

Multi-user notes editing where **git is the single source of truth** and
**realtime is a best-effort layer on top**. The realtime layer never owns
correctness — it only makes conflicts *rarer* by keeping everyone close to the
latest. If it stalls, the worst case is more held-back conflicts, never lost
data or inconsistency.

This is a concrete application of [`context-flow.md`](context-flow.md): notes is
edited by **no-AI UI loops**, one per user, all converging on `origin`.

---

## Model

- **Each browser session edits through a per-user UI-loop worktree** opened from
  `origin/main`. A no-AI loop. (Session granularity is per-user for now; a
  per-tab dimension can be added later without changing the model.)
- **Save is the loop-outside rule:** `commit → rebase onto origin/main →
  ff-push HEAD:main`; a real same-spot conflict is **held back** — the local
  edit is kept and surfaced, never silently merged or auto-discarded.
- **Data is one-item-per-file**, so the conflict unit is a file. Different people
  editing different notes never collide; only the *same* note edited at once
  conflicts — rare, and precise. The index (`MEMORY.md`-style) is the one shared
  hot spot; keep it append-only / sort-normalized so it auto-merges too.
- **A server is a disposable replica** of `origin` plus a gateway — never
  authoritative, rebuildable from `origin` at any time. So **multi-user on one
  server and across servers are the same thing**.

## Realtime = a change feed, two tiers

Correctness is git's; the feed only propagates "something landed" faster.

- **Server-internal (free, event-driven).** A save passes through the server, so
  right after a successful push the server broadcasts to its *own* other
  sessions — no poll, near-zero latency.
- **Cross-server (a `ChangeSource`).** The only shared point is `origin`, so each
  server watches it. Pluggable, **poll first** (assume `origin` is remote;
  interval tunable), webhook / platform-SSE / fs-watch later. "2s poll" is just a
  parameter of the poll implementation, not the model.

A change (internal event or `ChangeSource`) → server fetches → its worktree
ff-updates → it pushes the event to the page over **SSE** → the page pulls and
refreshes (guarding any in-flight local edit).

## Stages

- **Stage 0 — done** ([commit `50945bd`]). Per-user worktree
  (`ensureUiNotesWorktree`) + explicit save (`syncUiNotes` = ff-only + rebase +
  held-back). `vaultRoot("notes")` resolves to the worktree; `POST
  /api/notes/save` triggers the push. Regression test:
  `server/test/ui-notes-sync.test.ts`.
- **Stage 1.** `ChangeSource` interface + a `PollSource`; a per-repo server event
  bus (emit on save success); `GET /api/notes/events` (SSE); the page subscribes
  and refreshes on events.
- **Stage 2.** Conflict UX parity with personal (take-remote / resolve-in-a-loop);
  multi-session validation.
- **Stage 3.** Quality-of-life: auto-merging index, "this note is being edited by
  X" hints.

## Non-goals (for now)

- **Character-level realtime** (Google-Docs same-line co-typing) — needs CRDT +
  git checkpoints. Out of scope unless block-level editing proves insufficient.
- **Implicit/debounced save** — explicit save chosen on purpose (user controls
  when an edit lands on the shared remote).
