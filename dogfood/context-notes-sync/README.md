# context-notes-sync — a loop syncs its notes context back to origin

A highest-fidelity e2e journey (real browser → real backend → podman sshd git
fixture → real sandbox container). It exercises **context sync** — the
`docs/context-flow.md` model in the flesh: a loop edits its **notes** context
worktree and pushes back to the team notes origin.

It spends **~no AI tokens** — there is no chat turn. The edit / commit / push is
driven through the loop's **terminal**, and the result is verified by
**integration truth** (`podman exec` into the fixture notes origin), never the
DOM.

## What it regresses

The per-loop `/loopat/context/notes` mount (`V_CONTEXT_NOTES`) is a **git
worktree** whose `origin` is the team notes repo. That repo is cloned **per
user** by the backend's `ensureUserContext`, with the **vault** ssh key — a
different credential/url path than the roster workdir:

- roster repos clone from absolute `ssh://git@<ip>:<port>/…` urls;
- the **notes** url comes from the **knowledge** repo's `.loopat/config.json`
  (seeded in `dogfood/setup.ts` → `seed.sh`) in the **Host-alias** form
  `git@loopat-fixture:notes.git`.

For context sync to work, that Host alias must resolve in **both** places:

1. **host-side** — the clone in `ensureUserContext`, which runs git with
   `GIT_SSH_COMMAND = ssh -F <vault>/.../.ssh/config -i <vault key>`
   (`sshCommandForUser`), so the `loopat-fixture` alias (HostName/Port/Identity)
   applies; and
2. **inside the sandbox** — the `git push` from the worktree, which authenticates
   with the vault's `.ssh` (key + config) mounted at `$HOME/.ssh`.

The bugs this catches:
- the per-user notes clone **failing** (wrong url, missing vault key, host-key
  prompt) → `/loopat/context/notes` is an **empty dir** (see
  `ensurePerUserContextWorktree`) instead of a worktree, and the push has no
  origin to reach;
- the worktree's `origin` push **not reaching** the fixture notes.git (alias
  doesn't resolve in the sandbox, or wrong branch).

## Flow

1. Create a loop from `roster1` through the real UI; open the terminal →
   backend `ensureContainer`. On loop create, `ensureUserContext` has already
   cloned the per-user notes repo (vault key) and `ensureContextMounts`
   worktree'd it into `/loopat/context/notes`. Poll `podman` until the sandbox
   container is RUNNING.
2. In the terminal, `cd /loopat/context/notes` and confirm it's a real git
   worktree (`git rev-parse --is-inside-work-tree`, SOFT check via a sentinel).
3. Write a new file, `git add`, `git commit`, `git push origin HEAD:master`.
4. **Integration truth**: `podman exec <fixtureContainer> git -C
   /srv/git/notes.git log --oneline --all` must show the new commit — it reached
   the fixture notes origin.

## Assertions

Behavioral + integration truth, never screenshots:
- a sandbox container comes up for the loop (the per-user notes clone + worktree
  succeeded, or the container wouldn't be usable);
- (soft) `/loopat/context/notes` reads as a git worktree, not an empty dir;
- the loop's notes commit **reaches the fixture notes.git** — the hard proof
  the worktree's vault-key origin is wired end to end, host-side AND in-sandbox.

## Findings

- **No product bug surfaced for the per-user notes path.** The landmine we
  feared — the per-user notes clone failing against the fixture — does **not**
  reproduce: `ensureUserContext`/`sshCommandForUser` already pass
  `-F <vault ssh config>`, so the `git@loopat-fixture:notes.git` Host alias
  resolves host-side, and the same vault ssh config mounted at `$HOME/.ssh`
  makes it resolve in the sandbox for the push. Both `cloned per-user context
  git@loopat-fixture:notes.git` (setup) and the commit reaching `notes.git`
  (assertion) are observed green.
- **Pre-existing, harmless gap (NOT this case's path):** the **workspace-default**
  clone in `ensureWorkspaceDirs` uses the host's default ssh (no vault key) and
  fails against the fixture (`Permission denied (publickey)`), then falls back to
  a local origin. Loops never use the workspace-default context — they use the
  per-user path — so this does not affect context sync. Left as-is (it's a
  bootstrap display mirror only).

## Run

```sh
export IDEALAB_API_KEY=$(cat ~/.loopat/personal/simpx/.loopat/vaults/default/envs/IDEALAB_API_KEY)
bunx playwright test --config dogfood/playwright.config.ts dogfood/context-notes-sync/journey.spec.ts
```
