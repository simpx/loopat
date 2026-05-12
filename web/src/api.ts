export type LoopMeta = {
  id: string
  title: string
  createdAt: string
  createdBy: string
  repo?: string
  branch?: string
  archived?: boolean
  archivedAt?: string
}

export type User = { id: string }

const apiFetch: typeof fetch = (input, init) =>
  fetch(input, { credentials: "include", ...init })

let _workspaceCache: Promise<string> | null = null
/** Server's current workspace name, fetched once and memoized. */
export function getServerWorkspace(): Promise<string> {
  if (!_workspaceCache) {
    _workspaceCache = apiFetch("/api/health")
      .then((r) => r.json())
      .then((d) => (typeof d?.workspace === "string" ? d.workspace : "loopat"))
      .catch(() => "loopat")
  }
  return _workspaceCache
}

// ── auth ──

export async function getMe(): Promise<User | null> {
  const r = await apiFetch("/api/auth/me")
  if (!r.ok) return null
  const j = await r.json()
  return (j.user as User) ?? null
}

export async function login(username: string, password: string): Promise<{ user?: User; error?: string }> {
  const r = await apiFetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { error: j.error ?? `login failed (${r.status})` }
  return { user: j.user as User }
}

export async function register(input: {
  username: string
  password: string
  personalRepo?: string
}): Promise<{ user?: User; error?: string }> {
  const r = await apiFetch("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { error: j.error ?? `register failed (${r.status})` }
  return { user: j.user as User }
}

export async function logout(): Promise<void> {
  await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {})
}

// ── loops ──

/** filter: "active" (default, archived hidden), "all", "archived" */
export async function listLoops(filter: "active" | "all" | "archived" = "active"): Promise<LoopMeta[]> {
  const q = filter === "all" ? "?archived=all" : filter === "archived" ? "?archived=true" : ""
  const r = await apiFetch("/api/loops" + q)
  if (!r.ok) return []
  const j = await r.json()
  return j.loops as LoopMeta[]
}

export async function createLoop(opts: { title: string; repo?: string }): Promise<LoopMeta> {
  const r = await apiFetch("/api/loops", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
  })
  return (await r.json()) as LoopMeta
}

export async function setLoopArchived(id: string, archived: boolean): Promise<LoopMeta | null> {
  const r = await apiFetch(`/api/loops/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived }),
  })
  if (!r.ok) return null
  return (await r.json()) as LoopMeta
}

/** Strip thinking/redacted_thinking blocks from SDK history. Used before
 *  swapping to a provider that can't validate existing thinking signatures. */
export async function stripThinkingBlocks(id: string): Promise<{ stripped: number; sessionsTouched: number }> {
  const r = await apiFetch(`/api/loops/${id}/strip-thinking`, { method: "POST" })
  if (!r.ok) return { stripped: 0, sessionsTouched: 0 }
  return (await r.json()) as { stripped: number; sessionsTouched: number }
}

export type FileEntry = {
  name: string
  path: string
  type: "file" | "dir"
  size?: number
}

export async function listFiles(loopId: string, path = ""): Promise<FileEntry[]> {
  const r = await apiFetch(`/api/loops/${loopId}/files?path=${encodeURIComponent(path)}`)
  const j = await r.json()
  return (j.entries ?? []) as FileEntry[]
}

export async function readFile(loopId: string, path: string): Promise<{ content: string; truncated: boolean; size: number } | null> {
  const r = await apiFetch(`/api/loops/${loopId}/file?path=${encodeURIComponent(path)}`)
  if (!r.ok) return null
  return (await r.json()) as { content: string; truncated: boolean; size: number }
}

export async function writeFile(loopId: string, path: string, content: string): Promise<boolean> {
  const r = await apiFetch(`/api/loops/${loopId}/file?path=${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  })
  return r.ok
}

export type ContextMount = { name: string; path: string }
export async function getContext(loopId: string): Promise<ContextMount[]> {
  const r = await apiFetch(`/api/loops/${loopId}/context`)
  if (!r.ok) return []
  const j = await r.json()
  return (j.mounts ?? []) as ContextMount[]
}

export type VaultId = "knowledge" | "notes" | "personal" | "repos"
export type VaultEntry = { name: string; path: string; type: "file" | "dir"; size?: number }

export async function vaultList(vault: VaultId, path = ""): Promise<VaultEntry[]> {
  const r = await apiFetch(`/api/workspace/files?vault=${vault}&path=${encodeURIComponent(path)}`)
  if (!r.ok) return []
  const j = await r.json()
  return (j.entries ?? []) as VaultEntry[]
}

export async function vaultFlatList(vault: VaultId): Promise<VaultEntry[]> {
  const r = await apiFetch(`/api/workspace/files?vault=${vault}&flat=1`)
  if (!r.ok) return []
  const j = await r.json()
  return (j.entries ?? []) as VaultEntry[]
}

export async function vaultRead(vault: VaultId, path: string): Promise<{ content: string; size: number; truncated: boolean } | null> {
  const r = await apiFetch(`/api/workspace/file?vault=${vault}&path=${encodeURIComponent(path)}`)
  if (!r.ok) return null
  return (await r.json()) as { content: string; size: number; truncated: boolean }
}

export async function vaultWrite(vault: VaultId, path: string, content: string): Promise<{ ok: boolean; commit?: string; error?: string }> {
  const r = await apiFetch(`/api/workspace/file?vault=${vault}&path=${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  })
  return (await r.json()) as { ok: boolean; commit?: string; error?: string }
}

export async function vaultCreateFile(vault: VaultId, path: string): Promise<{ ok: boolean; error?: string }> {
  const r = await apiFetch(`/api/workspace/file?vault=${vault}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  })
  return (await r.json()) as { ok: boolean; error?: string }
}

export type Backlink = { path: string; preview: string }
export async function vaultBacklinks(vault: VaultId, path: string): Promise<Backlink[]> {
  const r = await apiFetch(`/api/workspace/backlinks?vault=${vault}&path=${encodeURIComponent(path)}`)
  if (!r.ok) return []
  const j = await r.json()
  return (j.backlinks ?? []) as Backlink[]
}

export type RepoEntry = { name: string; path: string; remote?: string }
export async function listRepos(): Promise<RepoEntry[]> {
  const r = await apiFetch(`/api/workspace/repos`)
  if (!r.ok) return []
  const j = await r.json()
  return (j.repos ?? []) as RepoEntry[]
}

export type RepoDetail = RepoEntry & {
  branch?: string
  status: "online" | "offline"
  readme?: string
  recentLoops: LoopMeta[]
}

export async function getRepo(name: string): Promise<RepoDetail | null> {
  const r = await apiFetch(`/api/workspace/repo/${encodeURIComponent(name)}`)
  if (!r.ok) return null
  return (await r.json()) as RepoDetail
}

// ── focus + topics ──
//
// Storage in notes/focus/<name>.md, ccx-style markdown task tree. See
// server/src/workspace.ts for the parsing model.

export type FocusMeta = {
  name: string
  title: string
  pinned: boolean
  priority?: string
  topics: string[]
  doneCount: number
  totalCount: number
  mtimeMs: number
}

export async function listFocuses(): Promise<FocusMeta[]> {
  const r = await apiFetch("/api/focus")
  if (!r.ok) return []
  const j = await r.json()
  return j.focuses as FocusMeta[]
}

export async function readFocus(name: string): Promise<{ body: string; mtimeMs: number } | null> {
  const r = await apiFetch(`/api/focus/${encodeURIComponent(name)}`)
  if (!r.ok) return null
  const j = await r.json()
  return { body: j.body, mtimeMs: j.mtimeMs }
}

export async function writeFocus(name: string, body: string): Promise<boolean> {
  const r = await apiFetch(`/api/focus/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body }),
  })
  return r.ok
}

export type TopicAggregate = {
  name: string
  focuses: string[]
  loops: { id: string; title: string }[]
}

export async function listTopics(): Promise<TopicAggregate[]> {
  const r = await apiFetch("/api/topics")
  if (!r.ok) return []
  const j = await r.json()
  return j.topics as TopicAggregate[]
}

export type ProviderInfo = { model: string; baseUrl: string; source: "personal" | "workspace" }
export type ProvidersResponse = { providers: Record<string, ProviderInfo>; default: string }
export async function getProviders(): Promise<ProvidersResponse> {
  const r = await apiFetch("/api/providers")
  if (!r.ok) return { providers: {}, default: "" }
  return (await r.json()) as ProvidersResponse
}
