/**
 * GitHub integration — the five-capability contract from docs/identity.md,
 * implemented against the GitHub REST API. It only ever consumes a *token*;
 * how that token was obtained (a user-pasted PAT today, an OAuth grant later)
 * is not its concern. Swapping the token source never touches this client.
 *
 * `baseUrl` is configurable so the same client works against github.com
 * (https://api.github.com) or a GitHub Enterprise / internal host
 * (https://<host>/api/v3).
 */
import { registerProvider, type GitHostProvider } from "./git-host"

export type GithubClient = {
  baseUrl: string
  token: string
}

export function githubClient(token: string, baseUrl = "https://api.github.com"): GithubClient {
  return { token, baseUrl: baseUrl.replace(/\/+$/, "") }
}

async function gh<T = any>(
  c: GithubClient,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${c.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${c.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data: any = null
  const text = await res.text()
  if (text) {
    try { data = JSON.parse(text) } catch { data = text }
  }
  return { status: res.status, data }
}

function fail(op: string, r: { status: number; data: any }): never {
  const msg = r.data?.message ?? (typeof r.data === "string" ? r.data : "")
  throw new Error(`github ${op} failed (${r.status})${msg ? `: ${msg}` : ""}`)
}

/**
 * OAuth Device Flow — login on localhost/cloud/any deployment without a per-user
 * app or a callback URL. One public client_id (NOT a secret — like gh CLI) is
 * baked in, overridable via LOOPAT_GITHUB_CLIENT_ID for self-hosters with their
 * own app. Scope: `repo` only — list/create/clone/push private repos; git is
 * over https-token so no ssh-key scope is needed. The token lands in the vault;
 * from there onboarding is identical to a pasted PAT.
 */
export const GITHUB_DEVICE_CLIENT_ID = process.env.LOOPAT_GITHUB_CLIENT_ID || "Ov23lijopFG81cPZXsI2"
export const GITHUB_DEVICE_SCOPE = "repo"

/** Step 1: request a device code. Returns the code to show + how long to poll. */
export async function requestDeviceCode(): Promise<{
  device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number
}> {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: GITHUB_DEVICE_CLIENT_ID, scope: GITHUB_DEVICE_SCOPE }),
  })
  const d = await res.json().catch(() => null)
  if (!res.ok || !d?.device_code) throw new Error(`github device code request failed (${res.status})`)
  return { device_code: d.device_code, user_code: d.user_code, verification_uri: d.verification_uri, interval: d.interval ?? 5, expires_in: d.expires_in ?? 900 }
}

/** Step 2: poll once for the token. `pending` until the user approves; `slow_down`
 *  asks us to back off; any other error is fatal. Returns the token on success. */
export async function pollDeviceToken(deviceCode: string): Promise<
  { status: "ok"; token: string } | { status: "pending" } | { status: "slow_down" } | { status: "error"; error: string }
> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: GITHUB_DEVICE_CLIENT_ID, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
  })
  const d = await res.json().catch(() => null)
  if (d?.access_token) return { status: "ok", token: d.access_token }
  if (d?.error === "authorization_pending") return { status: "pending" }
  if (d?.error === "slow_down") return { status: "slow_down" }
  return { status: "error", error: d?.error_description ?? d?.error ?? `poll failed (${res.status})` }
}

/** Capability 1 — authenticate: turn a token into the user's login. */
export async function getViewer(c: GithubClient): Promise<{ login: string; id: number }> {
  const r = await gh(c, "GET", "/user")
  if (r.status !== 200) fail("authenticate", r)
  return { login: r.data.login, id: r.data.id }
}

/**
 * Capability 2 — create a private repo in the viewer's namespace if missing.
 * Returns the clone URLs; idempotent (existing repo → returned as-is).
 */
export async function ensureUserRepo(
  c: GithubClient,
  name: string,
  opts: { private?: boolean; description?: string } = {},
): Promise<{ created: boolean; sshUrl: string; httpUrl: string; fullName: string }> {
  const me = await getViewer(c)
  const existing = await gh(c, "GET", `/repos/${me.login}/${name}`)
  if (existing.status === 200) {
    return {
      created: false,
      sshUrl: existing.data.ssh_url,
      httpUrl: existing.data.clone_url,
      fullName: existing.data.full_name,
    }
  }
  if (existing.status !== 404) fail("get repo", existing)
  const r = await gh(c, "POST", "/user/repos", {
    name,
    private: opts.private ?? true,
    description: opts.description ?? "loopat",
    auto_init: false,
  })
  if (r.status !== 201) fail("create repo", r)
  return { created: true, sshUrl: r.data.ssh_url, httpUrl: r.data.clone_url, fullName: r.data.full_name }
}

/** Capability 3 — register a deploy key on a repo (bootstrap clone of personal). */
export async function ensureDeployKey(
  c: GithubClient,
  owner: string,
  repo: string,
  title: string,
  publicKey: string,
  readOnly = true,
): Promise<void> {
  const list = await gh(c, "GET", `/repos/${owner}/${repo}/keys`)
  if (list.status === 200 && Array.isArray(list.data) && list.data.some((k: any) => k.key?.trim() === publicKey.trim())) {
    return
  }
  const r = await gh(c, "POST", `/repos/${owner}/${repo}/keys`, { title, key: publicKey, read_only: readOnly })
  if (r.status !== 201 && r.status !== 422 /* already exists */) fail("add deploy key", r)
}

/** Capability 4 — register an account-level key (the runtime key in the vault). */
export async function ensureUserKey(c: GithubClient, title: string, publicKey: string): Promise<void> {
  const list = await gh(c, "GET", "/user/keys")
  if (list.status === 200 && Array.isArray(list.data) && list.data.some((k: any) => k.key?.trim() === publicKey.trim())) {
    return
  }
  const r = await gh(c, "POST", "/user/keys", { title, key: publicKey })
  if (r.status !== 201 && r.status !== 422) fail("add user key", r)
}

/**
 * Capability 5 — grant a member access to a repo. Admin-gated by GitHub:
 * `c` must be a token with admin on `owner/repo` (e.g. an org-admin token at
 * team-setup time), not the joining user's own token.
 */
export async function ensureCollaborator(
  c: GithubClient,
  owner: string,
  repo: string,
  username: string,
  permission: "pull" | "push" | "admin" = "push",
): Promise<void> {
  const r = await gh(c, "PUT", `/repos/${owner}/${repo}/collaborators/${username}`, { permission })
  // 201 = invitation created, 204 = already a collaborator
  if (r.status !== 201 && r.status !== 204) fail("add collaborator", r)
}

/** The built-in GitHub provider — adapts the functions above onto GitHostProvider. */
export const githubProvider: GitHostProvider = {
  id: "github",
  label: "GitHub",
  // https-token: the device-flow OAuth token (scope `repo`) does both API and
  // git over https://<login>:<token>@github.com/… — one credential for every
  // repo, no per-repo deploy key. (OAuth-App tokens don't expire by default.)
  gitAuthMode: "https-token",
  // Onboarding step 1: no personal repo yet → device-flow login. loopat drives
  // the device dance (start/poll) and, on token, provisions the repo. Once the
  // repo is imported there's nothing left to gate on, so we're done.
  async onboarding(ctx) {
    if (!ctx.personalRepoImported) {
      return {
        done: false,
        show: {
          kind: "device",
          title: "用 GitHub 登录",
          description: "loopat 不存你的数据 —— 登录后会自动建一个私有个人仓库,你的 key / ssh / memory 都加密存在里面。",
        },
      }
    }
    return { done: true }
  },
  async authenticate(cred) {
    return await getViewer(githubClient(cred.token, cred.baseUrl))
  },
  async ensureRepo(cred, name, opts) {
    const r = await ensureUserRepo(githubClient(cred.token, cred.baseUrl), name, { private: opts?.private })
    return { url: r.httpUrl, created: r.created }
  },
  async registerDeployKey(cred, repo, title, pubkey, readOnly) {
    await ensureDeployKey(githubClient(cred.token, cred.baseUrl), repo.owner, repo.name, title, pubkey, readOnly)
  },
  async registerUserKey(cred, title, pubkey) {
    await ensureUserKey(githubClient(cred.token, cred.baseUrl), title, pubkey)
  },
  async listRepos(cred) {
    const c = githubClient(cred.token, cred.baseUrl)
    const r = await gh(c, "GET", "/user/repos?per_page=100&affiliation=owner&sort=updated")
    const items = Array.isArray(r.data) ? r.data : []
    return items.map((p: any) => ({ name: p.name, path: p.full_name }))
  },
  async grantAccess(cred, repo, login, level) {
    await ensureCollaborator(
      githubClient(cred.token, cred.baseUrl),
      repo.owner,
      repo.name,
      login,
      level === "write" ? "push" : "pull",
    )
  },

  // Seed a freshly-created personal repo: one provider default (key goes in the
  // vault later) and an ssh keypair (standard id_ed25519, git-crypt-encrypted)
  // so loops can clone repos with zero config.
  async seedDefaults(ctx) {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const run = promisify(execFile)

    const config = {
      providers: {
        default: "anthropic",
        anthropic: {
          model: "claude-opus-4-7",
          baseUrl: "https://api.anthropic.com",
          apiKey: "${ANTHROPIC_API_KEY}",
          maxContextTokens: 200000,
          models: [{ id: "claude-opus-4-7", enabled: true }],
          enabled: true,
        },
      },
    }
    await fs.mkdir(path.join(ctx.repoDir, ".loopat"), { recursive: true })
    await fs.writeFile(path.join(ctx.repoDir, ".loopat", "config.json"), JSON.stringify(config, null, 2) + "\n")

    const sshDir = path.join(ctx.vaultDir, "mounts", "home", ".ssh")
    await fs.mkdir(sshDir, { recursive: true })
    await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `loopat:${ctx.login}`, "-f", path.join(sshDir, "id_ed25519")])
    await fs.writeFile(path.join(sshDir, "config"), "Host *\n    StrictHostKeyChecking accept-new\n")
  },
}

registerProvider(githubProvider)
