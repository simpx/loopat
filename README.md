# loopat

Single-binary collaborative AI coding workspace. Loop = context + AI + workdir, sandboxed per-loop with bwrap, served as a web app on `localhost:7787`.

## Bootstrap on a clean machine

### 1. system deps

```sh
sudo apt install bubblewrap openssh-client  # bubblewrap: sandbox (Linux only) · openssh-client: deploy-key flow for personal/ import
curl -fsSL https://bun.sh/install | bash
curl -fsSL https://mise.run | sh           # mise: per-loop sandbox activation
```

`mise` is loopat's runtime/toolchain manager. When a loop selects a sandbox
(see `knowledge/.loopat/sandboxes/<name>/`), the server runs `mise install`
on the host and binds the tool installs into the sandbox. Without `mise` on
PATH, loops that select a sandbox fail at spawn; loops with no sandbox
still work normally.

Alternatives if `https://mise.run` isn't reachable:

- macOS: `brew install mise`
- Rust users: `cargo install mise`
- Manual: grab a release from <https://github.com/jdx/mise/releases> and drop it on PATH

mise data lives at `~/.local/share/mise/installs/`. loopat binds that path
read-only into each loop's sandbox, so tool installs are shared across loops
(install once, every loop sees it).

### 2. clone + install

```sh
git clone git@github.com:simpx/loopat.git
cd loopat
bun install                          # also pulls the platform-specific claude binary
```

### 3. first run — bootstraps the workspace

```sh
bun run dev                # listens on localhost
bun run dev:host           # listens on 0.0.0.0 (accessible from LAN)
```

On the very first run the server populates `LOOPAT_HOME` (default `~/.loopat`) with:

- `config.json`            — self-describing manifest (apiKey + optional remote git URLs for `knowledge` / `notes`)
- `context/knowledge/`     — cloned from `config.knowledge.git` if set, else empty dir
- `context/knowledge/loopat/CLAUDE.md` — sandbox doctrine, seeded from `server/templates/` if absent
- `context/notes/`         — cloned from `config.notes.git` if set, else `git init`'d locally for auto-commit
- `context/repos/`, `personal/<user>/` — empty skeletons
- `personal/<user>/` gets `git init`'d so vault writes auto-commit

It prints a checklist banner. The only thing you have to do manually:

```
✗  apiKey (bailian)
   → edit ~/.loopat/config.json  →  set providers.bailian.apiKey
```

Open `config.json`, fill in your key, optionally set `knowledge.git` / `notes.git` to your team's remote, then `bun run dev` again. Hand this `config.json` to a clean machine and bootstrap reconstructs the same workspace.

### 4. it should now work

Open <http://localhost:7787> → the banner ends with `ready.` → create a loop, chat with it.

## Production

```sh
# 1. Build the frontend
cd web && bun run build         # → web/dist/

# 2. Start (single process — Hono serves API + static assets)
PORT=7787 bun run server/src/index.ts
```

Open `http://localhost:7787`. The server serves static files from `web/dist/`. `/api/*` and `/ws/*` go to the API; everything else falls back to `index.html` for SPA routing.

To put a reverse proxy in front, point `/` to `web/dist/` (or `localhost:7787`) and proxy `/api` + `/ws` to the server.

## Env knobs

| var | default | use |
|---|---|---|
| `LOOPAT_HOME` | `~/.loopat` | the workspace directory itself. Single workspace per loopat instance — to run a second workspace, start another loopat with a different `LOOPAT_HOME`. URL/display name = basename minus leading dots (`~/.loopat` → `loopat`). |
| `LOOPAT_USER` | `$USER` | active driver name; also where `personal/` lives |
| `HOST` | `127.0.0.1` | server bind address. Set to `0.0.0.0` to accept connections from LAN / ngrok. Also passed to Vite dev server. |
| `PORT` | `7787` | server port |

## Layout

- **server/** — Hono + ws + Claude Agent SDK. Single port (REST + ws).
- **web/** — Vite + React + assistant-ui. In dev, served from the same port via Vite middleware.
- **server/templates/** — files copied into a fresh workspace on first run.
- **`$LOOPAT_HOME`** (default `~/.loopat`) — the workspace itself, per-machine.

## Sandbox

Each loop runs in a bwrap mount namespace with a virtualized fs view (`/loop/<id>`, `/context/*`, `/personal/`). See [docs/sandbox.md](docs/sandbox.md) and `$LOOPAT_HOME/context/knowledge/loopat/CLAUDE.md`.

## Troubleshooting

If chat doesn't start or you see "Claude code process exited with code 1", see [docs/troubleshoot.md](docs/troubleshoot.md).
