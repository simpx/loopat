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

export type RegisterResult = {
  user?: User
  /** ed25519 public key for the loopat-managed deploy keypair (server-generated).
   *  Null if ssh-keygen was missing on the host — register still succeeds, but
   *  the deploy-key import flow is unavailable until the host installs it. */
  publicKey?: string | null
  /** Repo URL the user wants imported into personal/. Null if not provided. */
  personalRepo?: string | null
  /** True iff user supplied a personalRepo AND publicKey was generated. The
   *  UI should walk them through the deploy-key + import step. */
  needsImport?: boolean
  error?: string
}

export async function register(input: {
  username: string
  password: string
  personalRepo?: string
}): Promise<RegisterResult> {
  const r = await apiFetch("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { error: j.error ?? `register failed (${r.status})` }
  return {
    user: j.user as User,
    publicKey: j.publicKey,
    personalRepo: j.personalRepo ?? null,
    needsImport: !!j.needsImport,
  }
}

// ── personal repo bootstrap ──

export type PersonalStatus = {
  userId: string
  personalRepo: string | null
  publicKey: string | null
  imported: boolean
}

export async function getPersonalStatus(): Promise<PersonalStatus | null> {
  const r = await apiFetch("/api/personal/status")
  if (!r.ok) return null
  return (await r.json()) as PersonalStatus
}

export async function importPersonal(
  repoUrl?: string,
  cryptKey?: string,
): Promise<{
  ok: boolean
  error?: string
  needsCryptKey?: boolean
  secretsExposed?: boolean
  exposedFiles?: string[]
}> {
  const payload: Record<string, string> = {}
  if (repoUrl) payload.repoUrl = repoUrl
  if (cryptKey) payload.cryptKey = cryptKey
  const r = await apiFetch("/api/personal/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return {
      ok: false,
      error: j.error ?? `import failed (${r.status})`,
      needsCryptKey: !!j.needsCryptKey,
      secretsExposed: !!j.secretsExposed,
      exposedFiles: Array.isArray(j.exposedFiles) ? j.exposedFiles : [],
    }
  }
  return { ok: true }
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

// ── kanban ──
// Storage in notes/todo/<filename>.md, one file per column.
// Cards are top-level - [ ] bullet items within each file.
// See server/src/kanban.ts for the parsing model.

export type KanbanCard = {
  cid: string
  text: string
  done: boolean
  assignee?: string
  priority?: string
  due?: string
  loopId?: string
  topics: string[]
  description: string
  subtasks: { text: string; done: boolean }[]
}

export type KanbanColumn = {
  filename: string
  title: string
  cards: KanbanCard[]
}

export async function listKanbanColumns(): Promise<KanbanColumn[]> {
  const r = await apiFetch("/api/kanban")
  if (!r.ok) return []
  const j = await r.json()
  return j.columns as KanbanColumn[]
}

export async function addKanbanCard(filename: string, opts: {
  text: string; assignee?: string; priority?: string; due?: string
  topics?: string[]; description?: string
}): Promise<{ cid?: string; error?: string }> {
  const r = await apiFetch(`/api/kanban/${encodeURIComponent(filename)}/cards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { error: j.error ?? "add failed" }
  return { cid: j.cid }
}

export async function toggleKanbanCard(filename: string, cid: string): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/${encodeURIComponent(filename)}/cards/${encodeURIComponent(cid)}/toggle`, {
    method: "PATCH",
  })
  return r.ok
}

export async function updateKanbanCard(filename: string, cid: string, patch: {
  text?: string; assignee?: string; priority?: string; due?: string
}): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/${encodeURIComponent(filename)}/cards/${encodeURIComponent(cid)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  })
  return r.ok
}

export async function updateKanbanCardBlock(filename: string, cid: string, block: string): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/${encodeURIComponent(filename)}/cards/${encodeURIComponent(cid)}/block`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ block }),
  })
  return r.ok
}

export async function deleteKanbanCard(filename: string, cid: string): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/${encodeURIComponent(filename)}/cards/${encodeURIComponent(cid)}`, {
    method: "DELETE",
  })
  return r.ok
}

export async function moveKanbanCard(fromFile: string, cid: string, toFile: string, toIndex?: number): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/${encodeURIComponent(fromFile)}/cards/${encodeURIComponent(cid)}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toFile, toIndex }),
  })
  return r.ok
}

export async function createKanbanColumn(filename: string, title?: string): Promise<boolean> {
  const r = await apiFetch("/api/kanban/columns", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename, title }),
  })
  return r.ok
}

export type KanbanColumnConfig = { file: string; color?: string }

export async function getKanbanConfig(): Promise<KanbanColumnConfig[]> {
  const r = await apiFetch("/api/kanban/config")
  if (!r.ok) return []
  const j = await r.json()
  return j.columns as KanbanColumnConfig[]
}

export async function saveKanbanColumnOrder(orderedFiles: string[]): Promise<boolean> {
  const r = await apiFetch("/api/kanban/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ columns: orderedFiles }),
  })
  return r.ok
}

export async function renameKanbanColumn(fromFile: string, toFile: string): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/${encodeURIComponent(fromFile)}/rename`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toFile }),
  })
  return r.ok
}

export async function deleteKanbanColumn(filename: string): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/${encodeURIComponent(filename)}`, { method: "DELETE" })
  return r.ok
}

export async function setKanbanColumnColor(filename: string, color: string): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/${encodeURIComponent(filename)}/color`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ color }),
  })
  return r.ok
}

export async function reorderKanbanCards(filename: string, cids: string[]): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/${encodeURIComponent(filename)}/reorder`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cids }),
  })
  return r.ok
}

export async function assignKanbanDriver(filename: string, cid: string): Promise<{ ok: boolean; loopId?: string }> {
  const r = await apiFetch(`/api/kanban/${encodeURIComponent(filename)}/cards/${encodeURIComponent(cid)}/assign-driver`, {
    method: "POST",
  })
  return r.ok ? await r.json() : { ok: false }
}

export async function createKanbanLoop(filename: string, cid: string): Promise<{ ok: boolean; loopId?: string }> {
  const r = await apiFetch(`/api/kanban/${encodeURIComponent(filename)}/cards/${encodeURIComponent(cid)}/create-loop`, {
    method: "POST",
  })
  if (!r.ok) return { ok: false }
  return await r.json()
}

export async function linkKanbanLoop(filename: string, cid: string, loopId: string): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/${encodeURIComponent(filename)}/cards/${encodeURIComponent(cid)}/link-loop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loopId }),
  })
  return r.ok
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

export type VersionInfo = { branch: string; commit: string }
export async function getVersion(): Promise<VersionInfo> {
  const r = await apiFetch("/api/version")
  if (!r.ok) return { branch: "unknown", commit: "unknown" }
  return (await r.json()) as VersionInfo
}

declare const __BUILD_COMMIT__: string
declare const __BUILD_TIME__: string
export function getBuildInfo() {
  return { commit: __BUILD_COMMIT__, time: __BUILD_TIME__ }
}
