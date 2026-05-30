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
