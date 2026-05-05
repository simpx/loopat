# Loopd — Context Handoff to Claude Code

> This document captures the design conversation between simpx and Claude (in Claude.ai) that led to the current Loopd MVP. It includes both **what we decided** and **what we explicitly rejected, and why**. Read this before suggesting designs — many "obvious" alternatives have already been ruled out for specific reasons.

---

## 1. One-line product description

**Loopd is a CLI tool that lets a person save the full state of a working directory as a "loop" snapshot, share it with a teammate, and have the teammate restore it locally to continue the work.**

That's it. Everything else (agent integration, IM, dashboard, real-time sync) is post-MVP.

---

## 2. The deeper philosophy (don't lose this)

The product was conceived around a specific observation:

> **AI has no autonomous desire. Desire can only be injected by a human.**

This means: in any human + AI workflow, the human is the source of intent ("driver"), and AI is an extension that executes injected intent. The hardest problem in human-AI-collaboration is not capability — it is **expressing, preserving, and transferring human intent reliably across people, agents, and time.**

Loopd's deepest purpose is to be **the container and conduit for intent**. Save/restore is the minimal mechanism to validate this — does the snapshot carry enough intent for someone else to continue the work?

If you forget everything else in this doc, remember this paragraph. All design choices below serve this philosophy.

---

## 3. The user (target persona)

- **Engineers**, comfortable with terminal, git, gh CLI
- Already use Claude Code or similar agent CLI tools
- Work in small teams (3–10 people)
- simpx himself is the first user
- simpx already built **ccx** — a bash-based Claude Code session manager. Loopd should NOT replace ccx, NOT integrate with ccx in MVP, just **coexist** alongside ccx

---

## 4. Current MVP scope

### Commands (THIS IS ALL)

```
loopd save --new <name>       # First time: snapshot current dir, create new loop
loopd save <id>               # Update an existing loop with new snapshot
loopd restore <id>            # Download latest snapshot, extract locally
loopd ls                      # List loops (optional, low priority for day 1)
```

**That's the entire MVP. 3 commands.** No handoff command, no driver command, no say/log command, no agent integration.

### What "save" does

1. Read current working directory
2. Apply default ignore list (target/, node_modules/, __pycache__/, .venv/, etc.)
3. tar + gzip into a snapshot tarball
4. Upload tarball to S3 (object storage)
5. Open `$EDITOR` for the user to write/edit a `meta.json` (or markdown that gets parsed) — fields: name, goal, status, current_state, next_steps, notes_for_next_driver
6. Upload meta.json to S3
7. Update a global index file (all-loops.json) so `ls` works

### What "restore" does

1. GET meta.json for the given loop id
2. Display a summary (goal, current state, who saved it last, when)
3. Download the latest snapshot tarball
4. Extract to `~/loopd/loops/<id>/`
5. Generate a `bootstrap.md` in the extracted dir that tells the next person how to get started (what to read, what external repos to set up, etc.)
6. Print the path so user can `cd` there

### What "save" does NOT do

- Does NOT touch ccx
- Does NOT manage cc sessions
- Does NOT do git commits
- Does NOT create PRs
- Does NOT update PR descriptions
- Does NOT do any handoff bookkeeping
- Does NOT track drivers
- Does NOT log "turns"

### Implicit handoff via save+restore

There's no handoff command. Handoff happens organically:
- Person A saves a loop
- Person A pings Person B in IM ("hey check loop 173")
- Person B restores
- Person B works on it, saves
- Person A restores when they want to see progress

This is sufficient for MVP. We are explicitly NOT building a handoff command yet.

---

## 5. Tech stack decisions (locked in)

| Component | Choice | Why |
|---|---|---|
| Language | **Rust** | simpx is fluent, single binary distribution, fits ccx ecosystem |
| Storage | **Object storage (S3-compatible)** | Simple GET/PUT, no database needed |
| Specific S3 | **TBD — see open questions** | Candidates: self-hosted nginx + SFTP, Cloudflare R2, AWS S3 |
| Tarball format | **tar.gz** | Standard, ubiquitous |
| Metadata format | **JSON** (meta.json) | Simple, parseable, debuggable |
| Index format | **JSON** (all-loops.json) | Same |
| Concurrency control | **Optimistic with etag/if-match** | S3 native, sufficient for low concurrency |
| ID assignment | **Sequential, allocated by reading max from index +1** | With etag retry on collision |

### Rust crate suggestions (not locked, just starting points)

- `clap` — CLI parsing
- `tar` + `flate2` — tarball
- `ignore` — gitignore-style file filtering
- `serde` + `serde_json` — JSON
- `rust-s3` or `aws-sdk-s3` — S3 client (S3 API)
- `reqwest` — if doing direct HTTP
- `dirs` — for `~/.loopd/` paths
- `anyhow` — error handling

---

## 6. THE EVOLUTION (read this so you don't suggest a rejected design)

The MVP went through ~7 progressive simplifications. Each step was a deliberate "step back" by simpx. Here is the trail, with rejection reasons:

### Step 1 (REJECTED): Full SaaS platform

Initial framing: a Slack-like multi-person + multi-agent collaboration platform, with channels, agents-as-first-class-citizens, presence indicators, etc. Too big for one person in 2-3 months.

### Step 2 (REJECTED): Loop OS / collaboration platform with web UI

Pivoted to "loop" as the core primitive. Designed loop / turn / handoff / driver / participant data models, web UI mockups, multi-tenant database, agent connection protocol. Still too big.

### Step 3 (REJECTED): Owner + Driver split

Originally I (Claude) proposed having both `owner` (intent source, must be human) and `driver` (current pusher, can be human or agent). simpx cut this — said only `driver` matters, and driver must always be human, agents are tools the driver uses. **Don't reintroduce owner.**

### Step 4 (REJECTED): Web-first MVP with Next.js + Supabase

I proposed Next.js + Supabase + Clerk. simpx rejected because:
- Web frontend for a non-designer engineer would be "工程师味儿" (engineer-flavored), low quality
- CLI is the right form factor for the target user
- Frontend should be forked from an existing open-source product later, not built from scratch

### Step 5 (REJECTED): Fork OpenCode / Claudia / etc

Considered forking an existing open-source Claude Code UI (OpenCode 95k stars, Opcode/Claudia 21k, claudecodeui). Decided NOT to fork because:
- Forking 95k LOC project means most time spent reverse-engineering someone else's code
- Loopd's core is the data model, not the chat UI
- Build CLI from scratch first, fork only later if doing web

### Step 6 (REJECTED): Git-native with branches as loops

Designed: each loop = a branch in a shared loops repo, LOOP.md is the source of truth, all coordination via git. simpx loved the idea initially, but then questioned why we even need git when each "save" is essentially a snapshot.

### Step 7 (REJECTED variant): GitHub PR as loop

Considered using GitHub PR description + comments as the loop's "shell" — driver = PR assignee, log = comments, handoff = changing assignee. Pretty good but:
- PR lifecycle (opens → merges) doesn't match all loop lifecycles
- GitHub-locked
- LOOP.md as actual file vs PR description had sync issues
- Needed gh CLI, layered on top of git CLI

### Step 8 (CURRENT): Pure tarball + S3

simpx's own insight: "If everything is a tarball, why do I even need git?"
Result: just upload/download tarballs to S3, with a json metadata index. No git, no GitHub, no PRs.

This is the MVP. **Don't suggest reintroducing git or GitHub PRs unless simpx asks.**

---

## 7. Things that were CONSIDERED but consciously REJECTED

When in doubt, do NOT add these to MVP:

- ❌ **Database** — meta.json + index file is the database
- ❌ **Backend service** — CLI talks directly to S3, no server in between
- ❌ **Web UI** — CLI-only for MVP. If web is ever added, it's a thin viewer for the same S3 data
- ❌ **Authentication system** — use S3 credentials, no user accounts
- ❌ **Git integration** — no git operations in save/restore
- ❌ **GitHub PR integration** — none
- ❌ **Agent SDK / agent connection protocol** — agents don't connect to Loopd in MVP
- ❌ **ccx integration** — Loopd and ccx coexist but don't talk to each other
- ❌ **Real-time sync / WebSocket / SSE** — polling-style is fine, even manual refresh is fine
- ❌ **Notifications** — out-of-band (IM) is fine
- ❌ **Driver/owner split** — only driver, must be human
- ❌ **Handoff command** — implicit via save+restore
- ❌ **Turn / log granular events** — just snapshots and meta.json updates
- ❌ **Knowledge management features** — out of MVP entirely
- ❌ **Workspace/Room hierarchy** — flat list of loops for now
- ❌ **Persona / agent identity registration** — not needed
- ❌ **Permissions / RBAC** — everyone in the team can access everything
- ❌ **Search** — `ls` is enough
- ❌ **Mobile app** — never
- ❌ **Cloud-hosted agent runtime** — out of scope

---

## 8. Things that ARE in MVP scope but underdesigned (open questions)

These were intentionally left for implementation time:

### Q1: Where to host S3?

Three candidates considered:

a. **Self-hosted nginx + SFTP** on a server simpx has access to.
- Pro: zero external dependency, full control
- Con: requires running a server, dealing with SSH keys for team

b. **Cloudflare R2**
- Pro: S3-compatible, no egress fees, fast globally
- Con: external service, need account setup

c. **AWS S3**
- Pro: fast in China (simpx is in China), simpx might have existing access
- Con: vendor-specific

**Recommendation when starting**: ask simpx which one he wants to use. If he doesn't care, default to whichever has the lowest setup friction in his current environment.

### Q2: Tarball includes external repo code or not?

When working on a feature, the user's working dir is often a checkout of an existing repo (e.g., `~/work/anyserve/`). Two options:

a. **Include**: tar everything including the full `.git/` and source tree. Self-contained snapshot. Easy to restore. But tarball is large (hundreds of MB).

b. **Exclude**: ignore the external repo, only save loopd-specific files (notes, artifacts, ccx session data). meta.json records "External: anyserve @ feat/x @ commit-abc". Smaller tarball but next driver needs to set up external repo themselves.

**Default for MVP**: include. Optimize later if tarballs are too big.

### Q3: meta.json format

Minimal proposed schema:

```json
{
  "id": 173,
  "name": "Add per-loop token budget",
  "status": "running",                   // running / paused / done / abandoned
  "driver": "simpx",                   // who saved it last
  "goal": "...",                         // markdown allowed
  "current_state": "...",                // markdown
  "next_steps": "...",                   // markdown
  "notes_for_next_driver": "...",        // optional, markdown
  "created_at": "ISO8601",
  "created_by": "simpx",
  "snapshots": [
    {
      "id": "snap-001",
      "uri": "loops/173/snapshot-001.tar.gz",
      "size_bytes": 145000000,
      "created_at": "ISO8601",
      "created_by": "simpx",
      "saver_notes": "initial save"
    }
  ],
  "external_refs": {                     // optional
    "anyserve": "feat/token-budget @ a3f9c1"
  }
}
```

This schema is a starting point — refine as needed during implementation.

### Q4: Default ignore list

Suggested defaults to put in `.loopdignore` (built into binary):

```
target/
node_modules/
__pycache__/
*.pyc
.venv/
venv/
build/
dist/
.DS_Store
*.log
.cache/
```

Users can add their own `.loopdignore` in working dir to extend this.

### Q5: bootstrap.md template

When restore extracts a tarball, drop a `bootstrap.md` in the dir like:

```markdown
# Welcome to Loop #{id}: {name}

You restored this loop on {date}.

## Quick read
- See LOOP.md / meta.json for full context
- Goal: {goal}
- Current state: {current_state}
- Next steps: {next_steps}
- Note from previous driver: {notes_for_next_driver}

## To continue
1. Read the files in this directory
2. (If external repo) cd to your local checkout of {external_repo}, fetch and checkout {branch}
3. Start your own ccx session: `ccx new` (your session, not theirs)
4. When you've made progress: `loopd save {id}`
```

### Q6: Editor integration for save

When `loopd save --new` is called, it should open `$EDITOR` (vim/nano/etc.) with a pre-filled markdown template. User edits, saves, exits. Loopd parses the markdown back into meta.json fields.

Or: skip editor, just take `--name` as flag and prompt for other fields. Probably simpler for MVP.

### Q7: Concurrency on the index

If two people save at the same time, both try to update `index/all-loops.json`. Simple solution: use S3 conditional PUT (if-match etag). On conflict, retry: re-fetch index, re-apply local change, retry PUT. Acceptable for low-concurrency teams.

If etag isn't supported (rare for S3-compatible S3), fallback: per-user index files (`index/by-user/simpx.json`), aggregate on read.

---

## 9. First-week plan

### Day 1 — Save command

- Set up Rust project, `cargo new loopd`
- Add `clap`, `tar`, `flate2`, `serde_json`, `ignore`, S3 client
- Implement `loopd save --new <name>`:
  - Parse args
  - Walk current dir, apply ignores, build tarball in memory or temp file
  - Open editor for meta.json fields (or skip, take from CLI flags for v0)
  - PUT tarball to S3
  - PUT meta.json to S3
  - Update index
- Test: save simpx's actual current working dir

### Day 2 — Restore command

- Implement `loopd restore <id>`:
  - GET meta.json
  - Display summary
  - GET tarball
  - Extract to `~/loopd/loops/<id>/`
  - Write bootstrap.md
- Implement `loopd ls`:
  - GET index, format as table
- End-to-end test: simpx saves, teammate restores

### Days 3–7 — Real use

simpx and at least one teammate use loopd for real work. Save when stopping work, restore when continuing or when teammate hands over. **Do not add features in week 1**. Just collect pain points.

### After week 1

If real usage felt valuable, prioritize the most painful gap (e.g., "I want to see my list of loops faster" → polish `ls`, "save asks too many questions" → simplify prompts). If it didn't feel valuable, kill the project — simpx explicitly said "if it sucks, I'll abandon it."

---

## 10. Notes on style and working with simpx

Things to know about how simpx works (drawn from the design conversation):

- simpx cuts aggressively. When in doubt, simplify, don't add. Almost every "elaborate design" Claude proposed got cut down.
- simpx has strong intuitions but verbalizes them gradually. When he says "我感觉..." or "我有点纠结..." he's usually onto something important — explore the intuition before pushing back.
- simpx pushes back hard on overengineering. If you find yourself proposing "let's add X to handle case Y", first ask: does the current MVP scope require this?
- simpx reads carefully. Don't write unnecessarily long responses. He explicitly said at one point "你说的东西太多了我跟不上" (you're saying too much, I can't keep up).
- simpx likes Chinese for casual conversation, mixes English for technical terms. Either is fine.
- simpx is a strong systems engineer (Rust, LLM inference, KV cache, etc.). Don't over-explain Rust idioms or basic engineering concepts. Do explain when veering into product/UX territory.
- simpx runs ccx, a bash + tmux + Eternal Terminal Claude Code session manager. He thinks in terms of git worktrees, shell scripts, and CLI ergonomics. Designs that don't fit this aesthetic are likely wrong for him.
- simpx has a project called **mockup.md** (Markdown for slides), uses Obsidian, has explored MAORPG game design, organizational theory ("1001人公司"). Broad interests, but for this MVP stay focused.

---

## 11. What "done" looks like for week 1

- [ ] simpx can run `loopd save --new "test"` in any directory and it produces a tarball + meta.json on S3
- [ ] simpx can run `loopd restore <id>` on another machine (or a fresh dir) and recover the directory
- [ ] At least one teammate has used `loopd restore` to pick up work from simpx
- [ ] simpx has tried it for real work for at least 3 days
- [ ] simpx has a list of pain points (whether to fix them is week 2's question)

---

## 12. If something here contradicts what simpx says now

**simpx wins.** This document is a snapshot. He is the source of intent (literally — see philosophy section). If he changes his mind, update the design — don't argue from this doc.

But also: **don't proactively suggest reintroducing things this doc says were rejected, unless he asks.** Many of the "obvious next steps" (add a database! add git! add a web UI! add agent integration!) were already considered and consciously deferred. Re-suggesting them wastes everyone's time.

---

## End of handoff

Good luck. Build the smallest thing that works. Then have simpx actually use it for a week. Decide what to do next based on real use, not on what looked good in design.

