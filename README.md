# loopat

Single-binary collaborative AI coding workspace. Loop = context + AI + workdir, sandboxed per-loop with bwrap, served as a web app on `localhost:7787`.

## Bootstrap on a clean machine

### 1. system deps

```sh
sudo apt install bubblewrap          # Linux only — required for the sandbox
curl -fsSL https://bun.sh/install | bash
```

### 2. clone + install

```sh
git clone git@github.com:simpx/loopat.git
cd loopat
bun install                          # also pulls the platform-specific claude binary
```

### 3. first run — bootstraps the workspace

```sh
bun run dev
```

On the very first run the server creates `~/.loopat/<workspace>/` with:

- `CLAUDE.md`         — sandbox doctrine (copied from `server/templates/CLAUDE.md`)
- `config.json`       — provider template (apiKey is empty)
- `context/{knowledge,notes,repos}/`, `personal/<user>/` — empty skeletons
- `notes/` and `personal/<user>/` get `git init`'d so writes auto-commit locally

It prints a checklist banner. The only thing you need to do manually:

```
✗  apiKey (bailian)
   → edit /home/<user>/.loopat/1001/config.json  →  set providers.bailian.apiKey
```

Open `config.json`, fill in your key (or pick a different provider as `default`), then `bun run dev` again.

### 4. it should now work

Open <http://localhost:7787> → the banner ends with `ready.` → create a loop, chat with it.

## Env knobs

| var | default | use |
|---|---|---|
| `LOOPAT_HOME` | `~/.loopat` | data root (per-machine) |
| `LOOPAT_WORKSPACE` | `1001` | workspace name (subdir of `LOOPAT_HOME`) |
| `LOOPAT_USER` | `$USER` | active driver name; also where `personal/` lives |
| `PORT` | `7787` | server port |

## Layout

- **server/** — Hono + ws + Claude Agent SDK. Single port (REST + ws).
- **web/** — Vite + React + assistant-ui. In dev, served from the same port via Vite middleware.
- **server/templates/** — files copied into a fresh workspace on first run.
- **`~/.loopat/<workspace>/`** — runtime data root. Per-machine.

## Sandbox

Each loop runs in a bwrap mount namespace with a virtualized fs view (`/loop/<id>`, `/context/*`, `/personal/`). See [docs/sandbox.md](docs/sandbox.md) and `~/.loopat/<workspace>/CLAUDE.md`.
