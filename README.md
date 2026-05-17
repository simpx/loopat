# loopat

> **Self-hosted AI collaboration workspace built around context management**
> — your data, your keys, git-based, multi-user.
>
> *loop at context, distill into knowledge.*

<p align="center">
  <img src="docs/overview.svg" alt="loopat architecture" width="100%">
</p>

A web app on `localhost:7787`. Every chat is a **loop** — a persistent,
sandboxed session paired with a credential vault and a slice of shared
team knowledge. Teams share tools and knowledge; members keep their own
credentials and identity. The agent runs the [Claude Agent SDK][sdk] —
*agents are commodity*. The **context architecture around the agent** is
what loopat actually is.

[sdk]: https://github.com/anthropics/claude-agent-sdk

⭐ [Star on GitHub](https://github.com/simpx/loopat) ·
🚀 [Quick start](#quick-start) ·
📖 [Architecture](docs/architecture.md)

<!-- TODO: add docs/screenshot.png — a single product screenshot showing
     a loop view with chat on one side and workdir/git on the other. -->

---

## What makes loopat different

It's not about the agent — Claude Agent SDK does that. It's about **how
context is organized, isolated, and distilled** so a team can collaborate
on AI work without stepping on each other.

- **Sandbox × Vault.** Capability (tools the loop can use) and identity
  (credentials it runs as) are orthogonal. *alice × dev*, *alice × prod*,
  *bob × dev*, *carol × prod* — four cells of the same matrix, one engine.
- **Layered context.** System doctrine + team conventions + per-project
  rules + cross-session **memory**, all assembled per turn, all distillable
  upward into shared knowledge.
- **Git-based.** Every artifact is a file, every change a commit on the
  loop's branch. `ls` and `cat` reveal full state. No DB.
- **Your data, your keys.** Self-hosted, BYO API key, per-vault credential
  isolation. Nothing leaves your machine except the model API call itself.

## How loopat compares

| | Claude Code | opencode | Codex | **loopat** |
|---|---|---|---|---|
| Form factor | CLI | TUI | Web (hosted) | **Web (self-hosted)** |
| Data location | local files | local files | OpenAI servers | **local git repos** |
| API key | BYO | BYO | OpenAI account | **BYO + per-vault isolation** |
| Multi-user | ❌ | ❌ | account-based | **shared workspace** |
| Sandbox isolation | process-level | process-level | OpenAI-managed | **bwrap (lightweight, default) · Docker (planned)** |
| Context layers | `CLAUDE.md` | `AGENTS.md` | in-session | **doctrine + team + project + memory** |
| Cross-session knowledge | none | none | none | **memory + knowledge + auto distillation** |
| Credential storage | env vars | env vars | platform-managed | **filesystem vault overlay** |
| Parallel sessions | many terminals | many terminals | tabs | **loops as first-class objects** |
| Agent engine | proprietary | pluggable | proprietary | **Claude Agent SDK (we don't pretend otherwise)** |

---

## Quick start

```sh
git clone https://github.com/simpx/loopat.git
cd loopat && bun install
bun run dev
```

Open <http://localhost:7787>. The first run bootstraps `~/.loopat/`,
prints a checklist, and prompts you to set your API key in
`~/.loopat/config.json`. Restart — done.

> Needs Linux + [bubblewrap][bwrap] + [mise][mise] + [bun][bun] on the
> host. macOS / Windows support is via Docker (see below). For team
> setups with shared `knowledge/` and `notes/` git repos, see
> [Detailed bootstrap](#detailed-bootstrap).

[bwrap]: https://github.com/containers/bubblewrap
[mise]: https://mise.jdx.dev/
[bun]: https://bun.sh/

## Production

### Docker (easiest, cross-platform)

```sh
docker compose up -d
```

Exposes `17787:7787`, persists the workspace in the `loopat-data` volume.
The image bundles bubblewrap, openssh-client, and git. Needs `SYS_ADMIN`
+ unconfined AppArmor for bwrap mount namespaces — see
[`docker-compose.yml`](docker-compose.yml).

### From source (Linux)

```sh
cd web && bun run build           # → web/dist/
PORT=7787 bun run server/src/index.ts
```

Single Hono process serves API + static SPA + websocket on one port.
Put a reverse proxy in front and proxy `/api` + `/ws` to the server;
everything else falls back to `index.html` for SPA routing.

---

## Detailed bootstrap

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
git clone https://github.com/simpx/loopat.git
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

---

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

## Contributing

Issues and PRs welcome at <https://github.com/simpx/loopat>. Before opening
a non-trivial PR, please skim [`docs/architecture.md`](docs/architecture.md)
so the change lands in the right layer (sandbox / vault / loop / chat).

Contributors are asked to sign the [Contributor License Agreement](CLA.md)
on their first PR — the [CLA Assistant][cla-assistant] bot will prompt you
with a one-click link. This grants the project the right to relicense
in the future (e.g. for a hosted commercial offering) without re-collecting
permission from every contributor.

[cla-assistant]: https://cla-assistant.io/

## License

[Apache License 2.0](LICENSE). See [`NOTICE`](NOTICE) for required
attributions and [`CLA.md`](CLA.md) for contribution terms.
