/**
 * Fixture git-host provider — a 1:1-shaped mirror of the real internal
 * git-host provider (../../code.ts), but operating against the dogfood FIXTURE
 * sshd container instead of any real platform. Dropped into
 * LOOPAT_HOME/extensions/providers/ by the first-run setup, so loopat loads it
 * as the active provider and runs the SAME onboarding gate code.ts drives.
 *
 * Duck-typed GitHostProvider. It does NOT import loopat and contains NO internal
 * hostnames / endpoints / keys — everything it needs comes from the environment:
 *
 *   FIXTURE_CONTAINER   podman container id of the fixture sshd (for `podman exec`
 *                       git-init / authorized_keys ops — the fixture's "platform API")
 *   FIXTURE_GIT_HOST    host:port reachable for ssh git urls (e.g. 10.0.0.1:22003)
 *   FIXTURE_TOKEN       the (fake) token the onboarding UI submits; authenticate
 *                       validates the submitted token equals this marker
 *   FIXTURE_LOGIN       the login authenticate returns (the user's name on the host)
 *   FIXTURE_AI_BASE_URL the AI provider base url seeded into config.json (env ref;
 *                       the real value is never committed)
 *
 * gitAuthMode "ssh-deploy-key": loopat generates the host deploy key, this
 * provider registers it on the fixture (appends to authorized_keys), and the
 * personal repo is cloned/pushed over ssh — exactly the GitHub path. The vault's
 * own id_ed25519 (generated in seedDefaults) is what reaches the team repos
 * (knowledge / notes); the test seeds THAT pubkey into authorized_keys in step 7.
 */
const env = (k: string): string => {
  const v = process.env[k]
  if (!v || !v.trim()) throw new Error(`fixture-provider: missing env ${k}`)
  return v.trim()
}

// podman exec into the fixture sshd container — the fixture's "platform API".
// Uses execFile (no shell at the podman layer); the inner `sh -c` strings are
// built only from fixture-internal constants, never user input.
async function podmanExec(args: string[]): Promise<string> {
  const cp = await import("node:child_process")
  const { promisify } = await import("node:util")
  const run = promisify(cp.execFile)
  const { stdout } = await run("podman", ["exec", env("FIXTURE_CONTAINER"), ...args], { timeout: 30000 })
  return stdout.toString()
}

// ssh git url for a bare repo on the fixture (absolute host:port — no internal
// hostname; the host comes from env).
const repoUrl = (name: string) => `ssh://git@${env("FIXTURE_GIT_HOST")}/srv/git/${name}.git`

export default {
  id: "fixture",
  label: "Fixture (dogfood)",
  tokenHelp: "Paste the fixture token (any value the test provides).",
  gitAuthMode: "ssh-deploy-key" as const,

  // ── (1) authenticate — validate the submitted token against the env marker. ──
  async authenticate(cred: any) {
    if ((cred?.token ?? "").trim() !== env("FIXTURE_TOKEN")) {
      throw new Error("fixture auth failed: bad token")
    }
    return { login: env("FIXTURE_LOGIN"), email: env("FIXTURE_LOGIN") + "@fixture.local" }
  },

  // ── listRepos — EMPTY on a first run (no personal repo yet). ──
  async listRepos(_cred: any) {
    let out = ""
    try { out = await podmanExec(["sh", "-c", "ls /srv/git 2>/dev/null || true"]) } catch { return [] }
    const personal = out
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.endsWith(".git"))
      .map((s) => s.replace(/\.git$/, ""))
      .filter((n) => !["knowledge", "notes", "roster1", "roster2"].includes(n))
    return personal.map((name) => ({ name, path: env("FIXTURE_LOGIN") + "/" + name }))
  },

  // ── (2) ensureRepo — git init --bare the personal repo on the fixture. ──
  async ensureRepo(_cred: any, name: string, _opts: any) {
    const exists = (await podmanExec(["sh", "-c", "test -d /srv/git/" + name + ".git && echo yes || echo no"])).trim()
    if (exists === "yes") return { url: repoUrl(name), created: false }
    await podmanExec(["sh", "-c",
      "git init --bare -q /srv/git/" + name + ".git && " +
      "git -C /srv/git/" + name + ".git config receive.denyCurrentBranch updateInstead && " +
      "chown -R git:git /srv/git/" + name + ".git && " +
      "ln -sfn /srv/git/" + name + ".git /home/git/" + name + ".git && chown -h git:git /home/git/" + name + ".git",
    ])
    return { url: repoUrl(name), created: true }
  },

  // ── (3) registerDeployKey — append the deploy PUBLIC key to authorized_keys so
  //      loopat can clone/push the personal repo over ssh. ──
  async registerDeployKey(_cred: any, _repo: any, _title: string, pubkey: string, _readOnly: boolean) {
    const key = pubkey.trim().replace(/'/g, "")
    await podmanExec(["sh", "-c",
      "grep -qxF '" + key + "' /home/git/.ssh/authorized_keys 2>/dev/null || " +
      "echo '" + key + "' >> /home/git/.ssh/authorized_keys; " +
      "chown git:git /home/git/.ssh/authorized_keys && chmod 600 /home/git/.ssh/authorized_keys",
    ])
  },

  // grantAccess — no-op on the fixture (single `git` account owns every repo).
  async grantAccess(_cred: any, _repo: any, _user: string, _level: string) {},

  // ── seedDefaults — bake team defaults into the fresh personal repo (mirrors
  //      code.ts): config.json (AI provider, env-ref apiKey; knowledge pointer)
  //      + a vault id_ed25519 (git-crypt encrypted). ──
  async seedDefaults(ctx: any) {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const cp = await import("node:child_process")
    const { promisify } = await import("node:util")
    const run = promisify(cp.execFile)

    // 1. config.json — PLAINTEXT in git, so apiKey is an env-var ref; the real
    //    value lands in the encrypted vault env (filled by the AI-key onboarding
    //    step). baseUrl comes from env (no internal endpoint committed).
    const config = {
      providers: {
        default: "idealab",
        idealab: {
          model: "claude-opus-4-7",
          baseUrl: env("FIXTURE_AI_BASE_URL"),
          apiKey: "${IDEALAB_API_KEY}",
          maxContextTokens: 1000000,
          models: [{ id: "claude-opus-4-7", enabled: true }],
          enabled: true,
        },
      },
      knowledge: { git: repoUrl("knowledge") },
      repos: [
        { name: "roster1", git: repoUrl("roster1") },
        { name: "roster2", git: repoUrl("roster2") },
      ],
    }
    await fs.mkdir(path.join(ctx.repoDir, ".loopat"), { recursive: true })
    await fs.writeFile(
      path.join(ctx.repoDir, ".loopat", "config.json"),
      JSON.stringify(config, null, 2) + "\n",
    )

    // 2. vault ssh keypair — STANDARD name id_ed25519 so ssh auto-resolves it.
    //    Lives under the vault, so git-crypt encrypts it. This is the key that
    //    reaches the team repos; its pubkey is seeded into authorized_keys by the
    //    test in step 7 (mirrors "add the key on the platform").
    const sshDir = path.join(ctx.vaultDir, "mounts", "home", ".ssh")
    await fs.mkdir(sshDir, { recursive: true })
    const keyPath = path.join(sshDir, "id_ed25519")
    await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-C", "loopat:" + ctx.login, "-f", keyPath])

    // 3. ssh config — accept new host keys non-interactively (no host-key prompt).
    await fs.writeFile(
      path.join(sshDir, "config"),
      ["Host *", "    StrictHostKeyChecking accept-new", ""].join("\n"),
    )
  },

  // ── onboarding(ctx) — 1:1 with code.ts: 3 gated steps. ──
  async onboarding(ctx: any) {
    // 1) personal repo missing → send the user to the real setup page.
    if (!ctx.personalRepoImported) {
      return {
        done: false,
        show: {
          kind: "route",
          path: "/settings/personal-repo",
          title: "Set up your personal repo",
          description:
            "loopat doesn't store your data — set up a personal repo first; your key / ssh / memory live encrypted inside it. We'll continue automatically once it's done.",
        },
      }
    }

    // 2) no usable AI provider key yet → ask for one (stored in the vault).
    const has = (k: string) => typeof ctx.vaultEnvs?.[k] === "string" && ctx.vaultEnvs[k].trim().length > 0
    const providers = (ctx.config?.providers ?? {}) as Record<string, any>
    const hasProviderKey = Object.values(providers).some(
      (p) => p && typeof p.apiKey === "string" && p.apiKey.trim().length > 0,
    )
    if (!hasProviderKey && !has("IDEALAB_API_KEY")) {
      return {
        done: false,
        show: {
          kind: "form",
          title: "Set your AI API key",
          description: "Stored in your own encrypted vault, never on the server.",
          submitLabel: "Save",
          require: "any",
          fields: [
            { name: "IDEALAB_API_KEY", label: "IdeaLab API Key", type: "password", action: "vault-env" },
          ],
        },
      }
    }

    // 3) team-repo ssh access: the vault key must reach knowledge + notes. Probe
    //    with `git ls-remote`; cache success in a marker so we only pay once.
    if (ctx.repoDir) {
      const fs = await import("node:fs/promises")
      const path = await import("node:path")
      const cp = await import("node:child_process")
      const { promisify } = await import("node:util")
      const run = promisify(cp.execFile)

      const sshDir = path.join(ctx.repoDir, ".loopat", "vaults", "default", "mounts", "home", ".ssh")
      const keyPath = path.join(sshDir, "id_ed25519")
      const configPath = path.join(sshDir, "config")
      const marker = path.join(ctx.repoDir, ".loopat", ".team-access-ok")
      const haveMarker = await fs.stat(marker).then(() => true).catch(() => false)
      const haveKey = await fs.stat(keyPath).then(() => true).catch(() => false)

      if (!haveMarker && haveKey) {
        await fs.chmod(keyPath, 0o600).catch(() => {})
        const sshCmd =
          "ssh -F " + configPath + " -i " + keyPath +
          " -o IdentitiesOnly=yes -o IdentityAgent=none" +
          " -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null"
        const teamRepos = [repoUrl("knowledge"), repoUrl("notes")]
        const canAccess = async (url: string) => {
          try {
            await run("git", ["ls-remote", "--exit-code", url, "HEAD"], {
              env: { ...process.env, GIT_SSH_COMMAND: sshCmd }, timeout: 25000,
            })
            return true
          } catch { return false }
        }
        const ok = (await Promise.all(teamRepos.map(canAccess))).every(Boolean)
        if (ok) {
          await fs.writeFile(marker, "ok\n").catch(() => {})
        } else {
          const pub = (await fs.readFile(keyPath + ".pub", "utf8").catch(() => "")).trim()
          return {
            done: false,
            show: {
              kind: "info",
              title: "Authorize access to the team repos (knowledge / notes)",
              description:
                "Your SSH key can't reach the knowledge / notes repos yet. Add the public key below to the platform's SSH Keys, then click re-check.",
              values: pub ? [{ label: "Your SSH public key (id.pub)", value: pub }] : [],
            },
          }
        }
      }
    }

    return { done: true }
  },
}
