export type LoopMeta = {
  id: string
  title: string
  createdAt: string
  createdBy: string
  repo?: string
  branch?: string
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

export async function listLoops(): Promise<LoopMeta[]> {
  const r = await apiFetch("/api/loops")
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

export type FocusData = { pinned: string[]; listed: string[]; inbox: string[] }
export async function readFocusData(): Promise<FocusData> {
  const r = await apiFetch(`/api/workspace/focus`)
  if (!r.ok) return { pinned: [], listed: [], inbox: [] }
  return (await r.json()) as FocusData
}
