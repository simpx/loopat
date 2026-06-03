# concurrent-push — git push CONFLICT RESOLUTION, head-on

This journey proves the part of concurrency that actually matters: not *avoiding*
a conflict, but **resolving** one. Two writers race the same branch (`master`)
of the same origin (the fixture `roster1.git`); the loop is the *second* writer,
so its first push is rejected non-fast-forward, and it must fetch + rebase +
re-push to land its work on top of the other writer's. "Last one resolves."

This is the legitimacy test for shared loops: a loop's workdir is a git worktree
off a roster mirror, `origin` is the real fixture bare repo, and nothing
serializes pushes. So the loop has to handle a moved origin the standard git way.

## Flow

1. Create a loop from `roster1` through the real UI; open the terminal; wait for
   the sandbox container to be RUNNING and the PreparingOverlay to clear.
2. In the loop's UI terminal (xterm, **fish** shell), set git identity and make a
   commit **Z-base** state on top of origin's current tip. This is the loop's
   honest starting point — it is *not* yet behind.
3. **Advance origin from OUTSIDE the loop.** Via `podman exec <fixtureContainer>`,
   clone `roster1.git` to a temp dir, commit **Y** on `master`, and push it back
   into the bare repo. Now `origin/master` has Y that the loop's local ref does
   not — the loop is genuinely behind.
4. In the loop terminal, make a new commit **Z** on the (now-stale) base and
   `git push origin HEAD:master` → it is **REJECTED non-fast-forward**, because
   origin moved. This is the real conflict.
5. In the loop terminal, resolve it the standard way:
   `git pull --rebase origin master`, then `git push origin HEAD:master` again →
   succeeds. (We use the explicit `origin master` pull-rebase rather than
   `git rebase origin/master`: the loop workdir is a worktree off a bare mirror
   whose fetch refspec maps origin's `master` into the LOCAL `refs/heads/master`,
   not a `refs/remotes/origin/master` tracking ref — so the explicit pull-rebase
   is the layout-independent, canonical "resolve a non-ff" move.)

## How we assert it — by STATE, never by scraping the xterm

xterm output is flaky to read (WebGL renderer, async PTY), so we drive the
commands through the real UI terminal but verify every outcome via **integration
truth**: `podman exec <fixtureContainer> git -C /srv/git/roster1.git ...`.

- **Conflict happened / first push rejected (step 4):** after the loop's first
  `git push`, the fixture origin's `master` tip must STILL be **Y** — commit Z
  did NOT land. Z is absent from `roster1.git`. That stale tip is the
  deterministic proof the non-ff push was rejected (a *successful* push would
  have moved the tip to Z).
- **Conflict resolved / both land (step 5+6):** after fetch+rebase+re-push,
  `git -C /srv/git/roster1.git log --oneline` contains BOTH the outside commit Y
  AND the loop's commit Z — the second writer rebased on top of the first and
  both are in origin's history.

## No AI tokens

No chat message is ever sent. The whole journey is driven through the real UI
terminal, so this case spends zero provider tokens.
