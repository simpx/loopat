# multi-turn-task — a real multi-step AI tool-use turn

Sibling of `first-5-minutes`, but where that case only proves the AI can *reply*,
this one proves the AI can actually *do a multi-step task with tool use* and that
the work lands on disk — verified by INTEGRATION TRUTH, never by the AI's words.

## What it does

1. Create a loop from the roster repo `roster1` through the real UI; open the
   terminal panel (→ backend `ensureContainer`); poll podman until the loop's
   sandbox container is RUNNING; wait for the `PreparingOverlay` to clear.
2. Send ONE chat instruction that forces several distinct tool actions:
   > Read `README.md` in the workdir, then create `SUMMARY.md` whose first line is
   > the word `DOGFOOD` followed by a space and the README's first line, then
   > `git add` and `git commit` it with message `add summary`.
3. Wait for the AI turn to finish (a non-empty assistant reply arrives; no `⚠️`
   error event). A real AI + tool turn is slow → generous 180s timeout.
4. INTEGRATION TRUTH — assert the AI actually DID the work, not that it *said* it
   did. The roster1 fixture's `README.md` is the single line `hello`, so the
   deterministic artifact is `SUMMARY.md` whose first line is exactly
   `DOGFOOD hello`. We `podman exec` into the loop's sandbox container and:
     - read `/loopat/loop/<id>/workdir/SUMMARY.md` → assert it starts with
       `DOGFOOD hello`, and
     - read `git log --oneline -1` in the workdir → assert the latest commit
       subject is `add summary`.

## Why a fixed sentinel

The AI is non-deterministic in wording and formatting. Pinning the artifact to a
fixed sentinel (`DOGFOOD`) + the fixture's known README line (`hello`) + a fixed
commit message (`add summary`) makes the assertion stable across runs while still
requiring the AI to have read the file, written a new file, and committed it.

## Why podman exec into the sandbox (not the workdir on the host)

The workdir is bind-mounted into the sandbox at `V_LOOP_WORKDIR =
/loopat/loop/<id>/workdir` (podman.ts), and that is exactly where the AI's tools
operate and where the shell lands. Reading it back through `podman exec` is the
container's own truth — it cannot lie about what the AI produced. The container is
labelled `loopat.loop-id=<id>`, the same id the loop URL carries.

## Cost

This case spends REAL idealab tokens (one multi-step AI turn). Keep iterations
lean. The instruction is crisp and deterministic so the AI completes the tool use
reliably on the first green run.
