# Installation guide

The README's **Quick start** is enough for a solo dev on Linux. This page
covers everything else: system dependencies in detail, team setups with
shared knowledge/notes git repos, environment variables, and what the
bootstrap actually does on first run.

## System dependencies

```sh
sudo apt install bubblewrap openssh-client
curl -fsSL https://bun.sh/install | bash
curl -fsSL https://mise.run | sh
```

| Tool | Role | Notes |
|---|---|---|
| **bubblewrap** | per-loop sandbox (Linux only) | required; on macOS/Windows use Docker |
| **openssh-client** | deploy-key flow for `personal/` import | required if you bind external git repos into vaults |
| **bun** | runtime + bundler | required |
| **mise** | per-loop toolchain manager | required only for loops that select a sandbox |

### About `mise`

When a loop selects a sandbox (defined under
`$LOOPAT_HOME/context/knowledge/.loopat/sandboxes/<name>/`), the server runs
`mise install` on the host and binds the tool installs into the sandbox.
Without `mise` on PATH, loops that select a sandbox fail at spawn; loops
with no sandbox still work normally.

mise data lives at `~/.local/share/mise/installs/`. loopat binds that path
read-only into each loop's sandbox, so tool installs are shared across loops
(install once, every loop sees it).

If `https://mise.run` isn't reachable:

- macOS: `brew install mise`
- Rust: `cargo install mise`
- Manual: grab a release from <https://github.com/jdx/mise/releases> and drop it on PATH

## Clone and install

```sh
git clone https://github.com/simpx/loopat.git
cd loopat
bun install                          # also pulls the platform-specific claude binary
```

## First run

```sh
bun run dev                # listens on 127.0.0.1
bun run dev:host           # listens on 0.0.0.0 (accessible from LAN)
```

On the very first run the server populates `LOOPAT_HOME` (default
`~/.loopat`) with:

- `config.json` — self-describing manifest (apiKey + optional remote git URLs for `knowledge` / `notes`)
- `context/knowledge/` — cloned from `config.knowledge.git` if set, else empty dir
- `context/knowledge/loopat/CLAUDE.md` — sandbox doctrine, seeded from `server/templates/` if absent
- `context/notes/` — cloned from `config.notes.git` if set, else `git init`'d locally for auto-commit
- `context/repos/`, `personal/<user>/` — empty skeletons
- `personal/<user>/` gets `git init`'d so vault writes auto-commit

It prints a checklist banner. The only thing you have to do manually is set
your API key:

```
✗  apiKey (<provider>)
   → edit ~/.loopat/config.json  →  set providers.<provider>.apiKey
```

Open `config.json`, fill in your key, optionally set `knowledge.git` /
`notes.git` to your team's remote, then `bun run dev` again. Hand this
`config.json` to a clean machine and bootstrap reconstructs the same
workspace.

When the banner ends with `ready.`, open <http://localhost:7787> and create
your first loop.

## Team setup — shared knowledge and notes

For a team that wants a shared `knowledge/` and `notes/` git repo, set
`knowledge.git` and `notes.git` in `config.json`:

```json
{
  "knowledge": { "git": "git@github.com:your-team/loopat-knowledge.git" },
  "notes":     { "git": "git@github.com:your-team/loopat-notes.git" },
  "providers": { "anthropic": { "apiKey": "sk-…" } }
}
```

The first run on each member's machine will clone these repos into
`$LOOPAT_HOME/context/`. Edits and commits made by loops auto-push to the
shared remote — every member sees the same evolving knowledge.

Per-user credentials live in `personal/<user>/` and are **never** committed
to the shared repos (separate `personal/` git initialized locally).

## Environment variables

| var | default | use |
|---|---|---|
| `LOOPAT_HOME` | `~/.loopat` | workspace directory. Single workspace per loopat instance — to run a second workspace, start another loopat with a different `LOOPAT_HOME`. URL/display name = basename minus leading dots (`~/.loopat` → `loopat`). |
| `LOOPAT_USER` | `$USER` | active driver name; also where `personal/` lives |
| `HOST` | `127.0.0.1` | server bind address. Set to `0.0.0.0` to accept connections from LAN / ngrok. Also passed to Vite dev server. |
| `PORT` | `7787` | server port |

## Verifying it works

1. Banner ends with `ready.`
2. <http://localhost:7787> loads
3. Create a loop, send a message, see the agent respond
4. Check `$LOOPAT_HOME/context/repos/<name>/` — the loop's branch should
   exist with auto-commits

If any of these fail, see [troubleshoot.md](troubleshoot.md).
