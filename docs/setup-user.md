# User setup — join a workspace

> Audience: an admin already stood up the workspace. Your job is to
> get your own loops working — register, set up your private credential
> repo, plug in an AI provider, link your dotfiles into the sandbox.

If you're the admin standing up loopat, start with
[setup-admin.md](setup-admin.md) first.

---

## TL;DR

| Step | What | Where |
|---|---|---|
| 1 | Register | open the UI, click **Register** |
| 2 | Get activated | wait for admin (first user is auto-admin) |
| 3 | Personal repo | Settings → Personal Repo (gates everything) |
| 4 | AI provider | Settings → AI Providers |
| 5 | Credentials → vault | drop ssh / gh / etc. into your vault |
| 6 | Sandbox mounts | Settings → Sandbox Mounts |
| 7 | Spawn a loop | Loops → New loop |

---

## 1. Register

Open `http://<workspace-host>:7787` and click **Register**:

- **Username** — lowercase, `[a-z0-9_-]`, 1–32 chars
- **Password**
- **Personal repo** — *optional but recommended*. A **fresh, empty
  private** git repo (GitHub / GitLab / Gitea, all work). You can
  skip this and fill it in later from the Settings page.

The first account to register on a workspace auto-promotes to admin
+ active. Every other account starts `pending` and waits for an admin
to activate it. If you see a yellow "pending" notice on login, ping
your admin.

---

## 2. Personal repo — the credential vault

Everything else in Settings is **gated** behind setting up your
personal repo. This is by design: provider apiKey values, MCP OAuth
tokens, SSH keys, CLI dotfiles all live in your personal repo's vault,
encrypted with git-crypt. No personal repo, nowhere to put your keys.

### Why a separate repo?

`personal/<you>/` carries your secrets — API keys, ssh private keys,
gh tokens, dotfiles. It is **never** pushed to the shared knowledge /
notes repos. Instead, each member gets their own private repo that
loopat manages:

- you create an empty git repo (private!)
- loopat clones it on your machine, runs `git-crypt init`, generates
  a fresh symmetric key, pushes a scaffold
- every write under `personal/<you>/.loopat/` is auto-committed and
  pushed; secrets are transparently encrypted by git-crypt

You **don't need git-crypt installed**. Loopat handles it.

### The flow

Go to **Settings → Personal Repo**:

1. **Copy the deploy key** loopat shows you. This is an ssh public
   key generated for your account, stored on the host outside
   `personal/` (so the sandbox can't read the private half).

2. **Create an empty private repo** on GitHub / GitLab. Add the
   deploy key under *Settings → Deploy keys* (or equivalent on
   your provider). **Tick "Allow write access".**

3. **Paste the repo URL** (`git@…:you/loopat-personal.git`) into the
   panel and click **Continue**.

4. Loopat clones, runs `git-crypt init`, and **shows you a
   git-crypt key** once. **Save it somewhere safe** (password
   manager). If you ever set up loopat on a new machine, you'll
   paste this key into the "I already have a git-crypt key"
   recovery box.

5. Tick "I've saved it" → done. Settings unlocks.

### "It says my repo isn't clean"

Loopat refuses to import a repo that already has git-crypt set up or
that has tracked files matching the secret patterns. Rotate any
exposed secrets and either delete + recreate the repo, or use the
recovery flow with your existing git-crypt key.

---

## 3. AI provider + API key

**Settings → AI Providers**.

Add a provider entry — pick a name (`anthropic`, `bailian`,
`openrouter`, whatever you want), fill in `model`, `baseUrl`,
`API key`. The API key gets written to your vault at
`personal/<you>/.loopat/vaults/default/envs/<NAME>_API_KEY` (where
`<NAME>` is the uppercase provider name) and encrypted by git-crypt
on commit. config.json carries a `"${<NAME>_API_KEY}"` reference,
never the literal value.

Example for direct Anthropic:

| Field | Value |
|---|---|
| Name | `anthropic` |
| Model | `claude-opus-4-7` |
| Base URL | `https://api.anthropic.com` |
| API key | (paste your `sk-…`) |

Set this as the **default** provider. The banner now shows
`✓ apiKey (anthropic)` for your loops — chat will actually work.

You can add as many providers as you want and switch the default; the
UI gives a dropdown per loop too.

---

## 4. Stock your vault

The **vault** is where every credential lives. There's no config
file — the vault uses two **filesystem conventions** to drive
automatic sandbox delivery:

```
~/.loopat/personal/<you>/.loopat/vaults/default/
├── envs/                          ← auto-injected as env vars
│   ├── ANTHROPIC_API_KEY          ← created by step 3
│   ├── MCP_GITHUB_TOKEN           ← MCP OAuth callback writes here
│   ├── SENTRY_AUTH_TOKEN          ← any custom env
│   └── …
└── mounts/home/                   ← auto-bound to sandbox $HOME
    ├── .ssh/                      ← drop your ssh keys here
    │   ├── id_ed25519
    │   ├── id_ed25519.pub
    │   └── config
    ├── .config/gh/                ← gh CLI auth
    ├── .gitconfig                 ← git identity
    ├── .vimrc
    └── .secrets/                  ← optional: ad-hoc per-service keys
        ├── sls/AK_ID
        └── …
```

**Rules**:

- `envs/<NAME>` — filename is the env var name, file content (with
  trailing newline stripped) is the value. The spawn process injects
  every entry as `$NAME`; provider apiKey can reference them as
  `"${NAME}"`; workspace MCP configs can reference them as
  `"Authorization": "Bearer ${MCP_<SERVER>_TOKEN}"`.
- `mounts/home/<entry>` — each top-level entry (file or directory) is
  `--bind`'d at sandbox `$HOME/<entry>`. No config, no declaration —
  putting a file there IS the configuration.
- Everything under `vaults/**` is auto-encrypted by git-crypt before
  push — committed to your private repo as ciphertext, decrypted on
  clone.

**Multi-vault** is supported but optional: create a sibling dir
(`vaults/prod/`, `vaults/test/`) and loops can pick which vault to
activate. Cross-vault symlinks are fine as long as `realpath` stays
inside your `personal/<you>/` tree. See
[sandbox.md §Vault](sandbox.md#vault凭据隔离) for the model.

Once stocked, sandbox CLIs Just Work: `ssh git@github.com` /
`gh auth status` / `git push` all use the credentials you dropped in.

---

## 5. Terminal shell (optional)

**Settings → Terminal Shell**.

PTY shell binary for loop terminals. Default is `/bin/bash`.

Set to `/usr/bin/zsh` etc. if you've also exposed it via
`vaults/<active>/mounts/home/...` or via a profile's `mise.toml`.

---

## 6. Spawn your first loop

**Loops → New loop**. Pick:

- A **repo** (if you want to work in code) — one of `repos[]` from
  the workspace config
- A **sandbox** (if the repo needs a toolchain) — one of the named
  sandboxes the admin provisioned
- A **vault** — defaults to `default`

Click Create. The server forks a worktree on `loop/<slug>-<id>`,
spawns a sandboxed Claude session, and drops you into chat.

Things to sanity-check on a fresh loop:

```sh
# in the loop's terminal pane
echo $ANTHROPIC_API_KEY    # … or your provider's env var (set if envs injected)
cat ~/.ssh/id_ed25519.pub  # works iff §5 mount is set
git ls-remote              # works iff §5 .gitconfig + ssh are set
```

If chat returns a red error or terminal is empty / shell missing,
walk [troubleshoot.md](troubleshoot.md) — most issues fall under
"API key wrong" or "broken symlink in mounts".

---

## Recovery: setting up on a new machine

Your personal repo + the git-crypt key are sufficient to recreate
everything. On the new host:

1. Install loopat ([install.md](install.md)), register with the
   **same username**.
2. Settings → Personal Repo → paste repo URL + open the recovery
   panel → paste your git-crypt key.
3. Loopat clones, unlocks, and your providers / mounts / envs /
   vault contents are all back.

This is the entire backup story: **personal repo + crypt key**.

---

## See also

- [setup-admin.md](setup-admin.md) — workspace-side companion
- [architecture.md](architecture.md) — what context layers exist
- [sandbox.md §Vault](sandbox.md#vault凭据隔离) — multi-vault model
- [claude-config.md](claude-config.md) — how team CLAUDE.md / skills
  / MCP reach your loops
- [troubleshoot.md](troubleshoot.md) — when chat doesn't work
