# dogfood / first-5-minutes

A single highest-fidelity Playwright e2e that simulates a real user's **first five
minutes** with loopat — end to end, no mocks.

Where the other suite (`e2e/`) tests UI logic against a mocked/isolated backend,
this one boots a **real** stack and drives it through a real browser:

```
browser (Playwright)
   │  storageState = already logged in as `test`
   ▼
backend (isolated LOOPAT_HOME, preconfigured ALREADY-ONBOARDED:
         idealab provider + self-contained vault (fresh ssh key) + roster repo `roster1`)
   │
   ▼
podman                 ── real per-loop sandbox container
   │
   ▼
fixture sshd+git container (loopat-dogfood-sshd)   ── real git origin
```

The whole point: integration bugs that L1–L3 logic tests cannot catch (workdir
gitdir paths, empty repos page, renamed ssh key, config-hash drift) only show up
when a **real sandbox + real config + real git** are wired together. If the stack
can't actually run, this test **fails — it never skips green**.

See the design + plan:
- `docs/superpowers/specs/2026-06-02-critical-path-e2e-design.md`
- `docs/superpowers/plans/2026-06-02-dogfood-first-5-minutes.md`

## What the harness sets up (before any test runs)

Brought up by `dogfood/playwright.config.ts` + `dogfood/setup.ts`:

1. **fixture sshd git server** — a podman container (`loopat-dogfood-sshd`) running
   sshd + git, with bare repos `knowledge.git`, `notes.git`, `roster1.git`. The
   per-run fresh pubkey (see #3) is seeded into its `authorized_keys`.
2. **isolated backend** — its own temp `LOOPAT_HOME`, `knowledge` + `gitHost`
   pointing at the fixture sshd over an ssh `Host loopat-fixture` alias.
3. **already-onboarded user `test`** — personal config has the `idealab` provider
   and a roster repo `roster1` (`git@loopat-fixture:roster1.git`). The vault is
   **self-contained**: setup generates a FRESH `id_ed25519` keypair (never lifted
   from any real vault — a real key in the repo reads as a leaked credential),
   and the one secret a fixture can't fake — `IDEALAB_API_KEY` — is taken from
   the environment (never read from disk, never committed).
4. **login state** — saved to `dogfood/.auth.json` and loaded via `storageState`,
   so the spec opens already authenticated.

## The journey (`journey.spec.ts`)

This file covers Task 3 of the plan: **create a loop from a roster repo and
confirm its sandbox container actually comes up.** It does NOT send a chat
message (no AI key burned) — that is Task 4.

| Step | Action (through the real UI) | Assertion |
|------|------------------------------|-----------|
| 1 | `goto /loop` (setup-repo card dismissed via localStorage) | the always-present **+ New Loop** button is visible (a fresh account has no loops yet, so no `aside` sidebar) |
| 2 | click `+ New Loop`, pick `roster1` in the **Repo** select, name the loop, click **create** | the create request hits `POST /api/v1/loops` with `repo: "roster1"`, and the browser navigates to `/loop/<id>` |
| 3 | the new loop is in the sidebar | the sidebar (`aside`) shows the loop's title; podman has **no** container for it yet |
| 4 | open the **▷ terminal** panel | opens `/ws/loop/<id>/term`, which makes the backend `ensureContainer`: git-worktree the workdir off the roster1 mirror (cloned over real ssh with the fresh vault key) + start the sandbox. No chat message → no AI tokens spent |
| 5 | poll podman directly until the loop's sandbox is up | a container labelled `loopat.loop-id=<id>` reaches state **running**. This is the integration truth — the badge/WS can race, podman cannot lie. If the ssh clone of roster1 had failed, the worktree (and thus the container) never come up and this poll times out — exactly the signal we want |

Real container startup is slow (image pull on a cold cache + worktree). The test
timeout is generous (5 min, set in the config) and there are no retries (each run
is non-deterministic and may cost money once chat is added). The podman poll uses
a 4-minute budget within that.

## Running it

```sh
export IDEALAB_API_KEY=$(cat ~/.loopat/personal/simpx/.loopat/vaults/default/envs/IDEALAB_API_KEY)
bunx playwright test --config dogfood/playwright.config.ts
```

Preconditions enforced at config load (fail, never skip):
- `podman` must be installed.
- `IDEALAB_API_KEY` must be set in the environment (real AI needs a real key;
  it is never read from disk and never committed).

If those are missing the config throws immediately — a dogfood test that goes
green without running proves nothing.
