# dogfood/attach-detach — the config-hash-drift regression

## What this guards

A loop's sandbox container is created once (lazily, on first terminal/SDK
attach) and is meant to **persist** across every later attach/detach. The
backend decides whether to reuse-or-recreate a container by comparing a
per-loop **config hash** (`hashCreateArgs` in `server/src/podman.ts`,
stamped onto the container as the `loopat.config-hash` label) plus the
resolved image ID against what `ensureContainer` computes on each call.

The danger this test pins:

> If `hashCreateArgs` produced a **different** value between two `ensureContainer`
> calls for the *same loop+vault* — e.g. because a different caller
> (`term.ts` PTY vs `session.ts` SDK) or a different lifecycle moment
> (open → close → reopen) fed it drifting inputs — `ensureContainer` would
> hit its "config hash drift — recreating" branch:
>
> ```
> running, hash drift → stop + rm + create + start
> ```
>
> That tears the container down and **SIGKILLs (137)** every in-flight
> `podman exec` process: the user's PTY shell, an active claude CLI turn,
> any `nohup`'d server. Symptom users report: *"my terminal disconnected
> the moment a chat started"* / *"my dev server died when I reopened the
> loop."*

`hashCreateArgs` deliberately **excludes** the env map (PTY and SDK pass
different `extraEnv`, which must NOT force a recreate) and **includes** the
mounts + loop-scoped opts (vault, knowledgeRw, mountAllLoops, ephemeral
ports). This test proves that opening/closing the loop and its terminal
repeatedly keeps the hash — and therefore the container — **stable**.

## Flow (NO chat message → zero AI tokens)

1. Create a loop from roster1 through the real UI.
2. Open the terminal panel → backend `ensureContainer` → poll podman until
   the sandbox container is **running**. Record its container **ID** and its
   **`StartedAt`** (and `CreatedAt`) via `podman inspect`.
3. **Detach**: navigate back to the `/loop` list (unmounts the loop page +
   terminal, closing the `/ws/loop/:id/term` socket).
4. **Re-attach**: navigate back to the loop and reopen the terminal — this
   calls `ensureContainer` a second time for the same loop+vault.
5. **Integration truth** (`podman inspect`, not the DOM): the container is
   the **SAME ID** and was **NOT recreated** — its `StartedAt` and
   `CreatedAt` are byte-for-byte identical across detach→reattach. A
   teardown+recreate (the drift bug) would change the ID and reset
   `StartedAt`/`CreatedAt`; an unchanged `StartedAt` is the hard,
   deterministic signal that no drift fired.

We repeat the detach→reattach cycle twice to make a single lucky no-op
unconvincing.

## Why `StartedAt`, not just the ID

A bare ID check could pass if podman happened to reuse a name with a fresh
container in a tight window. `StartedAt` only stays constant if the *exact
same container process* kept running — it is reset by any `rm + create +
start`. Same ID **and** unchanged `StartedAt` together cannot be faked by a
recreate.
