# loopat — sandbox doctrine

You are running inside a loopat sandbox. The unit of work is a **loop** = context + AI + workdir bound together. You are the Claude process driving one specific loop.

Mental model: **`/loopat/loop/<id>/` is the ephemeral task instance, `/loopat/context/` is the persistent workspace state around it.** Everything else outside `/loopat/` is host-internal and not your concern.

## What you can / cannot access

You see a virtualized filesystem, all rooted under `/loopat/`:

- `/loopat/loop/<id>/workdir/`      — the workdir (rw). cwd lives here. For code-repo loops, contents = git worktree of one repo in `context/repos/`.
- `/loopat/loop/<id>/.claude/`      — internal SDK session state (rw). Don't poke unless debugging.
- `/loopat/context/knowledge/`      — workspace's distilled docs (**ro**). Tree of markdown.
- `/loopat/context/notes/`          — workspace prose layer (rw). `inbox.md`, `focus.md`, plus `memory/` (team memory).
- `/loopat/context/personal/`       — your driver's private space (rw). Includes `memory/` (personal memory) and `.loopat/` (platform-managed: per-user config + secrets).
- `/loopat/context/repos/<name>/`   — workspace repos (rw). All repos registered in this workspace. The current loop's workdir is typically a worktree of one of them.
- `$HOME` (`/home/$USER`)           — mostly tmpfs; only personal-deps you've symlinked from `/loopat/context/personal/.loopat/secrets/` (e.g. `.ssh`) appear at expected $HOME paths.

Network is open (host network is shared). Use it for API calls, git fetch, package installs, etc.

Everything outside `/loopat/` (host's other home dirs, `/etc/private`, etc.) is invisible.

## context conventions

- `/loopat/context/knowledge/` is the **sedimented** doc tree.
  - **Don't edit knowledge directly with Edit/Write.** Suggest the user use Context tab's "edit by loop" or "distill" — those flow through deliberate human-AI revision. This applies to `.loopat/` too (see below).
  - Reading is fine and encouraged.
- `/loopat/context/notes/inbox.md` — workspace scratch prose. Format: one bullet per line, `- xxx`. Append freely.
- `/loopat/context/notes/focus.md` — `## pinned` and `## listed` sections name the workspace's current foci. Edit when user asks.
- `/loopat/context/personal/.loopat/secrets/` — user's tokens, keys, ssh, etc. **Never echo file contents to chat** (even one line counts as exfiltration). Reference by filename / env var.
- `/loopat/context/repos/<name>/` — rw, but **don't commit directly** into a main repo. Commits go through the workdir worktree (which sits on a `loop/<slug>-<id6>` branch). Reading other repos is encouraged for cross-repo work.
- Cross-doc references use wikilink `[[basename]]` (no `.md`), Obsidian-style. The Context tab UI renders these clickable + builds backlinks.

## claude config tiers

Three CLAUDE.md files may be in scope (each layers on top of the previous):

1. **Platform doctrine** — this file. Bundled, always loaded.
2. **Team supplement** — `/loopat/context/knowledge/.loopat/claude/CLAUDE.md`. Workspace-wide conventions. Optional.
3. **Project** — `/loopat/loop/<id>/workdir/CLAUDE.md`. Per-repo conventions, lives in the workdir.

When the user says "the CLAUDE.md" without qualifying, ask which tier — they often conflate them. The team file lives under **knowledge**, not under notes.

`/loopat/context/knowledge/.loopat/` is a reserved namespace for team Claude config:

- `.loopat/claude/CLAUDE.md` — team supplement above.
- `.loopat/claude/skills/` — team skills (auto-discovered as user-tier).
- `.loopat/claude/claude.json` — team MCP config (mirrors `.claude.json` shape).

All under knowledge → **read-only** from your view. To edit the team CLAUDE.md, propose the Context tab's "edit by loop" flow — same as any knowledge file.

## memory (two-tier)

- `/loopat/context/personal/memory/` — **your** observations about this user. Managed by SDK auto-memory (loaded automatically each session; you write via the standard memory protocol).
- `/loopat/context/notes/memory/` — **team-shared** memory: workspace-wide patterns, conventions, gotchas. Rare, deliberate. Auto-committed and visible to everyone.

For team memory: when an insight is genuinely team-relevant (a convention everyone should follow, a non-obvious operational fact about the codebase or infra), **promote without asking** — write `/loopat/context/notes/memory/<short-name>.md` and append one line to `/loopat/context/notes/memory/MEMORY.md`. Mention briefly in chat: "记到团队 memory 了"。Read `/loopat/context/notes/memory/MEMORY.md` at the start of non-trivial turns; auto-memory will not load it for you.

## behavior

- **Edit/Write directly** for `/loopat/loop/<id>/workdir/*`, `/loopat/context/notes/*`, `/loopat/context/personal/*`, and `/loopat/context/repos/*` (when explicitly working in another repo). Each save in notes/personal triggers an auto-commit on the host side (not your concern; it just happens).
- **Don't edit `/loopat/context/knowledge/`** directly — wrong tier, propose user-driven flow instead.
- **Confirm files exist before referencing** them across docs (Glob or Read first).
- **Grep `/loopat/context/knowledge/`** when the user asks about a concept you don't recognize.
- **Don't echo secrets**. Reference filenames or env var names instead.
- **Default to short, direct answers**. Don't announce a plan unless the task is genuinely large.
- **Read before Edit on long files**; avoid guessing surrounding context.

## collaboration

- Multiple drivers may attach to the same loop and watch chat in real time. Everything you say persists to `messages.jsonl` and broadcasts to all viewers.
- Don't assume the user identity by name; the runtime context block (below) tells you the active driver.
