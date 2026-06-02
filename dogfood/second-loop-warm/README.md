# dogfood/second-loop-warm

Regresses the **image-reuse** fix (commit `82d8cf5` "content-hash image tag —
drop workspace prefix").

## What changed in product code

The sandbox image tag used to be per-workspace:

```
loopat-sandbox-<workspace>:latest          # base
loopat-sandbox-<workspace>-<hash>:latest   # per-loop (mise.toml) child
```

It is now **content-addressed** (no workspace prefix):

```
loopat-sandbox:latest          # base
loopat-sandbox-<hash>:latest   # per-loop child, hash = sha256(baseContainerfile + mise.toml)
```

So a second loop resolves the **same image name** the first loop already built
and podman reuses it instead of building a fresh per-workspace copy. Containers
stay workspace-scoped via the `loopat.workspace` label (runtime isolation); only
the *image* is shared.

## What this journey asserts (integration truth, no AI tokens)

1. Create **loop A** from `roster1`, open its terminal (→ `ensureContainer`),
   poll podman until A's sandbox container is **running**; record A's container
   image ID.
2. **Snapshot** every `loopat-sandbox*` image ID present *before* loop B starts.
3. Create **loop B** from `roster2`, open its terminal, poll until B is running;
   record B's container image ID.
4. Assert:
   - **(a) no rebuild for B** — B's container image ID was already in the
     pre-B snapshot, so B built no image of its own.
   - **(b) shared image** — B's image ID `===` A's image ID.

Both assertions fail under the old per-workspace tagging (B would resolve a
different tag → a fresh image → an ID not in the snapshot and `!==` A's).

We deliberately assert image-ID identity rather than timing (B faster than A),
because timing is flaky on a warm/cold layer cache; image-ID identity is a hard,
deterministic signal.

## Run

```sh
export IDEALAB_API_KEY=$(cat ~/.loopat/personal/simpx/.loopat/vaults/default/envs/IDEALAB_API_KEY)
bunx playwright test --config dogfood/playwright.config.ts dogfood/second-loop-warm/journey.spec.ts
```

Real podman + a real `IDEALAB_API_KEY` are required (the config fails, never
skips, without them) — though this case sends no chat turn and spends no tokens.
