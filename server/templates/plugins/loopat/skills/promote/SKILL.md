---
description: Promote this loop's context into shared consensus — the ② edge of docs/context-flow.md. Use when work in a context worktree (notes / knowledge / personal / a repo workdir) is worth sharing, or when the user says promote / share this / publish / sync up / 发布 / 同步 / 合并上去. You merge the latest and push to main (or open a PR for gated context), resolving any conflict three-way yourself — that is the point: the loop's own AI resolves conflicts, nothing else does.
---

# promote — share a loop's context

Promote moves what's worth keeping from this loop into shared `main`. It is
**deliberate** — do it when the work is genuinely worth sharing, not on every
turn. You run plain git; if the merge conflicts, you resolve it yourself (you
are the merge agent — no other agent, no script).

## Steps

`cd` into the worktree you want to promote — `/loopat/context/notes`,
`/loopat/context/knowledge`, `/loopat/context/personal`, or a repo workdir —
then capture your work and merge the latest consensus:

```sh
git add -A && git commit -m "<what you're sharing>"
git fetch origin            # skip if there is no origin (solo)
git merge origin/main       # solo (no origin): git merge main
```

**If the merge conflicts**, resolve it now, here:
- Edit each conflicted file; reconcile the `<<<<<<< ======= >>>>>>>` markers by
  **keeping both sides' meaning** — this is notes/knowledge, so merge the
  information, don't drop a side.
- `git add` the resolved files, then `git commit` to finish the merge.
- (`git merge --abort` backs out cleanly.)

Then push:

```sh
# ungated — notes · personal — straight into main:
git push origin HEAD:main            # solo: git push . HEAD:main

# gated — knowledge · repos — open a PR instead:
git push origin HEAD
gh pr create --base main --head "$(git symbolic-ref --short HEAD)" --fill
```

If `git push` is **rejected** (`non-fast-forward` — `main` moved while you
worked), re-run `git merge origin/main`, resolve again, push again. It converges.

## Rules

- Always **merge, never rebase** — both parents survive, so a bad merge is
  revertible.
- Resolve conflicts **here, yourself** — never hand off to another agent.
- `notes` / `personal` push straight to `main`; `knowledge` / repos are gated —
  open a PR. (Gating is the team's choice; default for knowledge/repos = PR.)
- Trunk is `main` (your runtime context block names it if it ever differs).
