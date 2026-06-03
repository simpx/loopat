# dogfood — real-stack e2e

These tests boot a **real** loopat stack (isolated `LOOPAT_HOME`, real backend,
real podman sandbox, real fixture git origin over ssh) and drive it through a
real browser. No mocks. They catch integration bugs that the logic tests in
`e2e/` cannot — workdir gitdir paths, empty repos page, config-hash drift, ssh
key naming, real AI turns, real pushes to origin. If the stack can't actually
run, a dogfood test **fails — it never skips green**.

They cost a (small) real AI key spend, so they are organized into three tiers by
cost and intent.

## Tiers

### smoke — fast, run on every change
The shared-fixture suite presets an ALREADY-ONBOARDED user and reuses one
backend, so it's the cheapest way to know the critical path still works.

| Case | Answers |
|------|---------|
| `first-5-minutes` | Can a fresh user create a loop, get a real AI reply, and `git push` from the terminal to origin — in the first five minutes? |

Run: `bun run dogfood:smoke`

### journey — full cold-start, run before a release
The whole first-time-user flow from a TRULY EMPTY `LOOPAT_HOME`, driven entirely
through the browser (register → onboarding gate → personal repo + git-crypt →
ssh pubkey → context → loop → AI → terminal). Ends with BOTH an AI push and a
human push reaching origin, per the doctrine that origin is the source of truth.

| Case | Answers |
|------|---------|
| `first-run` | Does the complete cold-start onboarding work end to end, and do both "AI done" and "human done" really land in origin? |

Run: `bun run dogfood:journey`

### scenario — focused / regression, run when touching the relevant area
Each isolates one behavior on the shared-fixture stack.

| Case | Answers |
|------|---------|
| `repos-page` | Does the repos page render the user's roster from real provider state? |
| `second-loop-warm` | Is a second loop on the same repo fast (warm mirror, fetch + worktree, no re-clone)? |
| `attach-detach` | Does detaching/re-attaching a loop recreate the container on config-hash drift? |
| `context-notes-sync` | Does a loop push its notes worktree to origin? |
| `concurrent-push` | Do concurrent pushes from multiple loops converge on origin without loss? |
| `multi-turn-task` | Does a real multi-turn AI tool-use turn complete and verify against integration truth? |

Run the full scenario preset (the 7 shared-fixture cases): `bun run dogfood`

## Running

All tiers need a real AI key in the environment (never read from disk, never
committed):

```sh
export IDEALAB_API_KEY=$(cat ~/.loopat/personal/<you>/.loopat/vaults/default/envs/IDEALAB_API_KEY)
```

`dogfood:journey` (first-run) additionally needs the AI provider base url:

```sh
export FIRST_RUN_AI_BASE_URL=https://idealab.alibaba-inc.com/api/anthropic
```

Then:

```sh
bun run dogfood:smoke      # first-5-minutes (fast)
bun run dogfood            # the 7 shared-fixture scenario cases
bun run dogfood:journey    # first-run full cold-start (release)
```

Preconditions are enforced at config load (fail, never skip): `podman`,
`git-crypt` (journey only), and the required env vars must all be present.
