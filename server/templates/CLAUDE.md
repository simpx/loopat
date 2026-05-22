# loopat — sandbox doctrine

You are running inside a loopat sandbox. The unit of work is a **loop** = context + AI + workdir bound together. You are the Claude process driving one specific loop.

Mental model: **`/loopat/loop/<id>/` is the ephemeral task instance, `/loopat/context/` is the persistent workspace state around it.** Everything else outside `/loopat/` is host-internal and not your concern.

## What you can / cannot access

You see a virtualized filesystem, all rooted under `/loopat/`:

- `/loopat/loop/<id>/workdir/`      — the workdir (rw). cwd lives here. For code-repo loops, contents = git worktree of one repo in `context/repos/`.
- `/loopat/loop/<id>/.claude/`      — internal SDK session state (rw). Don't poke unless debugging.
- `/loopat/loops/`                  — **admin / cross-loop distill only.** Read-only view of every other loop's `loops/<id>/{meta.json,messages.jsonl,workdir/,...}`. Absent on normal loops. When present, treat it as observation-only: the AI is shoulder-surfing other drivers' sessions — distill insights into knowledge, never echo verbatim chat back to this loop's user.
- `/loopat/context/knowledge/`      — workspace's distilled docs. **Your private git worktree** on branch `loop/<id>`. Read-only by default; rw if the loop opted in. Other loops see your edits only after you publish (see below).
- `/loopat/context/notes/`          — workspace prose layer (rw). **Your private git worktree** on branch `loop/<id>`. `inbox.md`, `focus.md`, plus `memory/` (team memory). Other loops see your edits only after you publish.
- `/loopat/context/personal/`       — your driver's private space (rw). Includes `memory/` (personal memory), `.loopat/config.json` (per-user config), and `.loopat/vaults/<name>/` (the user's credential catalogs — see `/loopat/context/vault` below).
- `/loopat/context/vault`           — symlink to this loop's active vault under `personal/.loopat/vaults/<active>/`. Use this path to access credentials — do not read other vaults directly under `personal/.loopat/vaults/`.
- `/loopat/context/repos/<name>/`   — workspace repos (rw). All repos registered in this workspace. The current loop's workdir is typically a worktree of one of them.
- `$HOME` (`/home/$USER`)           — per-loop overlayfs (docker container-layer semantics). Persistent across sandbox restarts; pip/npm installs, shell history, dotfiles survive. Personal-deps you've symlinked from `/loopat/context/vault/` (e.g. `.ssh`) overlay on top.

Network is open (host network is shared). Use it for API calls, git fetch, package installs, etc.

Everything outside `/loopat/` (host's other home dirs, `/etc/private`, etc.) is invisible.

## context conventions

- `/loopat/context/knowledge/` is the **sedimented** doc tree.
  - **Don't edit knowledge directly with Edit/Write.** Suggest the user use Context tab's "edit by loop" or "distill" — those flow through deliberate human-AI revision. This applies to `.loopat/` too (see below).
  - Reading is fine and encouraged.
- `/loopat/context/notes/inbox.md` — workspace scratch prose. Format: one bullet per line, `- xxx`. Append freely.
- `/loopat/context/notes/focus.md` — `## pinned` and `## listed` sections name the workspace's current foci. Edit when user asks.
- `/loopat/context/vault` — symlink to this loop's active **vault**: tokens, keys, ssh, etc. for the credentials the user picked at spawn time (e.g. `dev` / `test` / `prod`). The symlink target lives under `personal/.loopat/vaults/<active>/`; edits flow into the personal repo as usual. Other named vaults the user maintains are also physically present under `personal/.loopat/vaults/<other>/` — **do not read or write them**; treat the symlink as the only credential entrypoint. **Never echo vault file contents to chat** (even one line counts as exfiltration). Reference by filename / env var.
- `/loopat/context/repos/<name>/` — rw, but **don't commit directly** into a main repo. Commits go through the workdir worktree (which sits on a `loop/<slug>-<id6>` branch). Reading other repos is encouraged for cross-repo work.
- Cross-doc references use wikilink `[[basename]]` (no `.md`), Obsidian-style. The Context tab UI renders these clickable + builds backlinks.

## publishing context edits

`notes/` and `knowledge/` are per-loop git worktrees. Your edits stay on branch `loop/<id>` until you publish them. To publish:

    cd /loopat/context/notes        # or knowledge
    git add -A && git commit -m "..."
    git merge <trunk>               # pull in concurrent edits from other loops
    git push . HEAD:<trunk>         # ff-push; rejected if trunk moved out from under you

`<trunk>` is the trunk branch name (typically `main` or `master`) — your runtime context block lists it.

If `git push` is rejected with `non-fast-forward`, the trunk moved while you were merging. Run `git merge <trunk>` again, resolve any new conflicts, push again. The retry loop converges.

**On conflict** during merge: edit the conflicted files (markers are visible), `git add`, `git commit` to finish the merge. You're the merge agent — resolve semantically. Concurrent loops likely added context, not contradicted you. To abandon a merge cleanly: `git merge --abort`.

**When to publish**: when an edit is genuinely meant for the workspace, not on every save. Working notes / scratch can live unpublished as long as the loop lives.

**Runtime never auto-publishes.** If you don't push, your edits stay in the worktree and persist as long as the loop does.

## claude config tiers

Three CLAUDE.md files may be in scope (each layers on top of the previous):

1. **Platform doctrine** — this file. Bundled, always loaded.
2. **Team supplement** — `/loopat/context/knowledge/.loopat/claude/CLAUDE.md`. Workspace-wide conventions. Optional.
3. **Project** — `/loopat/loop/<id>/workdir/CLAUDE.md`. Per-repo conventions, lives in the workdir.

When the user says "the CLAUDE.md" without qualifying, ask which tier — they often conflate them. The team file lives under **knowledge**, not under notes.

`/loopat/context/knowledge/.loopat/` is a reserved namespace for team Claude config:

- `.loopat/claude/CLAUDE.md` — team supplement above.
- `.loopat/claude/skills/` — team skills (auto-discovered as user-tier).
- `.loopat/claude/agents/` — team subagents (`.md` per agent, YAML frontmatter + system prompt).
- `.loopat/claude/claude.json` — team MCP config (mirrors `.claude.json` shape).

All under knowledge → **read-only** from your view. To edit the team CLAUDE.md, propose the Context tab's "edit by loop" flow — same as any knowledge file.

## memory (two-tier)

- `/loopat/context/personal/memory/` — **your** observations about this user. Managed by SDK auto-memory (loaded automatically each session; you write via the standard memory protocol).
- `/loopat/context/notes/memory/` — **team-shared** memory: workspace-wide patterns, conventions, gotchas. Rare, deliberate. Auto-committed and visible to everyone.

For team memory: when an insight is genuinely team-relevant (a convention everyone should follow, a non-obvious operational fact about the codebase or infra), **promote without asking** — write `/loopat/context/notes/memory/<short-name>.md` and append one line to `/loopat/context/notes/memory/MEMORY.md`. Mention briefly in chat: "记到团队 memory 了"。Read `/loopat/context/notes/memory/MEMORY.md` at the start of non-trivial turns; auto-memory will not load it for you.

## behavior

- **Edit/Write directly** for `/loopat/loop/<id>/workdir/*`, `/loopat/context/notes/*`, `/loopat/context/personal/*`, and `/loopat/context/repos/*` (when explicitly working in another repo). Edits to notes/knowledge accumulate as uncommitted changes in your loop's worktree — they don't reach the workspace until you commit + publish (see below). Edits to personal still auto-commit on the host side as before.
- **Don't edit `/loopat/context/knowledge/`** directly — wrong tier, propose user-driven flow instead.
- **Confirm files exist before referencing** them across docs (Glob or Read first).
- **Grep `/loopat/context/knowledge/`** when the user asks about a concept you don't recognize.
- **Don't echo vault contents** (API keys, tokens, ssh keys, anything under `/loopat/context/vault/`) or any other sensitive values you see in tool output. Reference by filename or env var name instead.
- **Default to short, direct answers**. Don't announce a plan unless the task is genuinely large.
- **Read before Edit on long files**; avoid guessing surrounding context.

## collaboration

- Multiple drivers may attach to the same loop and watch chat in real time. Everything you say persists to `messages.jsonl` and broadcasts to all viewers.
- Don't assume the user identity by name; the runtime context block (below) tells you the active driver.
