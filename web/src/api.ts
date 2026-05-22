export type LoopMeta = {
  id: string
  title: string
  createdAt: string
  createdBy: string
  /** Active driver. Use `loop.driver ?? loop.createdBy` everywhere "who is
   *  currently in charge" matters (filters, headers, button visibility).
   *  Non-drivers are read-only — server enforces the same way as `archived`. */
  driver?: string
  /** Chronological log of driver assignments. First entry = creation
   *  (driver = createdBy). Used by ChatInterface to splice "driving by X
   *  since <ts>" markers into the agent chat timeline. */
  driverHistory?: Array<{ driver: string; since: string }>
  /** RFD ("Request For Drive") state. When set, current driver released
   *  control: sandbox is torn down, and any authed user can claim via
   *  POST /api/loops/:id/drive. */
  rfdRequestedAt?: string
  rfdRequestedBy?: string
  repo?: string
  branch?: string
  archived?: boolean
  archivedAt?: string
  /** If true, /share/:id is publicly viewable. Toggle via setLoopPublic. */
  public?: boolean
  publicAt?: string
  shareEnabled?: boolean
  shareMode?: "static" | "port"
  shareAlias?: string
  sharePort?: number
  config?: {
    sandbox?: string
    vault?: string
    [k: string]: unknown
  }
}

export type UserRole = "admin" | "member"
export type UserStatus = "active" | "pending"

export type User = {
  id: string
  role: UserRole
  status: UserStatus
}

export type AdminUser = {
  id: string
  role: UserRole
  status: UserStatus
  personalRepo?: string
  createdAt: string
  activatedAt?: string
}

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

export async function exportPersonalCryptKey(
  password: string,
): Promise<
  { ok: true; cryptKey: string } | { ok: false; error: string; wrongPassword?: boolean }
> {
  const r = await apiFetch("/api/personal/crypt-key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return {
      ok: false,
      error: j.error ?? `request failed (${r.status})`,
      wrongPassword: r.status === 403,
    }
  }
  if (typeof j.cryptKey !== "string") return { ok: false, error: "missing cryptKey in response" }
  return { ok: true, cryptKey: j.cryptKey }
}

export async function deletePersonalVault(
  password: string,
  force: boolean = false,
): Promise<{
  ok: boolean
  error?: string
  wrongPassword?: boolean
  syncFailed?: boolean
  synced?: boolean
  dataLost?: boolean
  uncommitted?: number
  unpushed?: number
  hasRemote?: boolean
}> {
  const r = await apiFetch("/api/personal/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password, force }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return {
      ok: false,
      error: j.error ?? `delete failed (${r.status})`,
      wrongPassword: r.status === 403,
      syncFailed: j.syncFailed,
      uncommitted: j.uncommitted,
      unpushed: j.unpushed,
      hasRemote: j.hasRemote,
    }
  }
  return { ok: true, synced: j.synced, dataLost: j.dataLost }
}

export async function pullPersonalVault(): Promise<{
  ok: boolean
  error?: string
  conflicts?: string[]
  needsStash?: boolean
  message?: string
}> {
  const r = await apiFetch("/api/personal/pull", { method: "POST" })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return {
      ok: false,
      error: j.error ?? `pull failed (${r.status})`,
      conflicts: j.conflicts,
      needsStash: j.needsStash,
    }
  }
  return { ok: true, message: j.message }
}

export async function pushPersonalVault(): Promise<{
  ok: boolean
  error?: string
  needsPull?: boolean
  message?: string
}> {
  const r = await apiFetch("/api/personal/push", { method: "POST" })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return {
      ok: false,
      error: j.error ?? `push failed (${r.status})`,
      needsPull: j.needsPull,
    }
  }
  return { ok: true, message: j.message }
}

export async function importPersonal(
  repoUrl?: string,
  cryptKey?: string,
): Promise<{
  ok: boolean
  error?: string
  needsCryptKey?: boolean
  notClean?: boolean
  secretsExposed?: boolean
  exposedFiles?: string[]
  autoInitialized?: boolean
  cryptKey?: string | null
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
      notClean: !!j.notClean,
      secretsExposed: !!j.secretsExposed,
      exposedFiles: Array.isArray(j.exposedFiles) ? j.exposedFiles : [],
    }
  }
  return {
    ok: true,
    autoInitialized: !!j.autoInitialized,
    cryptKey: typeof j.cryptKey === "string" ? j.cryptKey : null,
  }
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

export async function createLoop(opts: { title: string; repo?: string; sandbox?: string; vault?: string; knowledgeRw?: boolean; mountAllLoops?: boolean }): Promise<LoopMeta> {
  const { knowledgeRw, mountAllLoops, ...rest } = opts
  const body: Record<string, unknown> = { ...rest }
  if (knowledgeRw) body.knowledge_rw = true
  if (mountAllLoops) body.mount_all_loops = true
  const r = await apiFetch("/api/loops", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return (await r.json()) as LoopMeta
}

export async function listVaults(): Promise<string[]> {
  const r = await apiFetch("/api/vaults")
  if (!r.ok) return []
  const j = await r.json()
  return Array.isArray(j.vaults) ? j.vaults : []
}

export async function markLoopViewed(id: string): Promise<boolean> {
  const r = await apiFetch(`/api/loops/${id}/viewed`, { method: "POST" })
  return r.ok
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

export async function setLoopPublic(id: string, isPublic: boolean): Promise<LoopMeta | null> {
  const r = await apiFetch(`/api/loops/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ public: isPublic }),
  })
  if (!r.ok) return null
  return (await r.json()) as LoopMeta
}

/** Rename the loop. Server allows only meta.createdBy to patch. */
export async function setLoopTitle(id: string, title: string): Promise<LoopMeta | null> {
  const r = await apiFetch(`/api/loops/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  })
  if (!r.ok) return null
  return (await r.json()) as LoopMeta
}

/** Current driver releases control. Sandbox + PTY are torn down server-side;
 *  any authed user can then claim via takeDrive(). */
export async function requestDrive(id: string): Promise<LoopMeta | null> {
  const r = await apiFetch(`/api/loops/${id}/request-drive`, { method: "POST" })
  if (!r.ok) return null
  return (await r.json()) as LoopMeta
}

/** Take over a loop in RFD state. Sandbox respawns lazily on next message
 *  using the new driver's personal config. */
export async function takeDrive(id: string): Promise<LoopMeta | null> {
  const r = await apiFetch(`/api/loops/${id}/drive`, { method: "POST" })
  if (!r.ok) return null
  return (await r.json()) as LoopMeta
}

/** Spawn a distill child loop from `id`. Server seeds the child's workdir
 *  with a snapshot of the source's conversation files plus a distill-kind
 *  CLAUDE.md. Returns the new loop meta. Any authed user may call. */
export async function distillLoop(id: string): Promise<LoopMeta | null> {
  const r = await apiFetch(`/api/loops/${id}/distill`, { method: "POST" })
  if (!r.ok) return null
  return (await r.json()) as LoopMeta
}

export async function getLoopMeta(id: string): Promise<LoopMeta | null> {
  const r = await apiFetch(`/api/loops/${id}`)
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

export async function deleteWorkdirFile(loopId: string, path: string): Promise<boolean> {
  const r = await apiFetch(`/api/loops/${loopId}/file?path=${encodeURIComponent(path)}`, {
    method: "DELETE",
  })
  return r.ok
}

export async function createWorkdirFolder(loopId: string, path: string): Promise<boolean> {
  const r = await apiFetch(`/api/loops/${loopId}/folder`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  })
  return r.ok
}

export async function uploadFile(loopId: string, file: File): Promise<{ ok: boolean; path?: string; error?: string }> {
  const formData = new FormData()
  formData.append("file", file)
  const r = await apiFetch(`/api/loops/${loopId}/upload`, {
    method: "POST",
    body: formData,
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: j.error ?? "upload failed" }
  return { ok: true, path: j.path }
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

export async function vaultRead(
  vault: VaultId,
  path: string,
): Promise<{ content: string; size: number; truncated: boolean; secret?: boolean } | null> {
  const r = await apiFetch(`/api/workspace/file?vault=${vault}&path=${encodeURIComponent(path)}`)
  if (!r.ok) return null
  return (await r.json()) as { content: string; size: number; truncated: boolean; secret?: boolean }
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

export async function vaultCreateFolder(vault: VaultId, path: string): Promise<{ ok: boolean; error?: string }> {
  const r = await apiFetch(`/api/workspace/folder?vault=${vault}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  })
  return (await r.json()) as { ok: boolean; error?: string }
}

export async function vaultDeleteFile(vault: VaultId, path: string): Promise<{ ok: boolean; error?: string }> {
  const r = await apiFetch(`/api/workspace/file?vault=${vault}&path=${encodeURIComponent(path)}`, {
    method: "DELETE",
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

export type SandboxEntry = { name: string }
export async function listSandboxes(): Promise<SandboxEntry[]> {
  const r = await apiFetch(`/api/sandboxes`)
  if (!r.ok) return []
  const j = await r.json()
  return (j.sandboxes ?? []) as SandboxEntry[]
}

/** Files inside a sandbox dir that the editor can address. Mirrors server SandboxFile. */
export type SandboxFile = "mise.toml" | "sandbox.json"

export async function readSandbox(name: string, file: SandboxFile = "mise.toml"): Promise<string | null> {
  const r = await apiFetch(`/api/sandboxes/${encodeURIComponent(name)}?file=${encodeURIComponent(file)}`)
  if (!r.ok) return null
  const j = await r.json()
  return typeof j.content === "string" ? j.content : null
}

export type LoopSandboxInfo = {
  name: string | null
  loopVersion?: string | null
  catalogVersion?: string | null
}
export async function getLoopSandbox(id: string): Promise<LoopSandboxInfo | null> {
  const r = await apiFetch(`/api/loops/${id}/sandbox`)
  if (!r.ok) return null
  return (await r.json()) as LoopSandboxInfo
}

export async function getChatHistory(loopId: string): Promise<string[]> {
  const r = await apiFetch(`/api/loops/${loopId}/chat-history`)
  if (!r.ok) return []
  const entries = await r.json()
  return entries.map((e: any) => e.text)
}

export async function appendChatHistory(loopId: string, text: string): Promise<void> {
  await apiFetch(`/api/loops/${loopId}/chat-history`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  })
}

export async function refreshLoopSandbox(id: string): Promise<{ ok: boolean; version?: string | null; error?: string }> {
  const r = await apiFetch(`/api/loops/${id}/sandbox/refresh`, { method: "POST" })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: j.error ?? `http ${r.status}` }
  return { ok: true, version: j.version }
}

export async function deleteSandbox(name: string): Promise<{ ok: boolean; error?: string }> {
  const r = await apiFetch(`/api/sandboxes/${encodeURIComponent(name)}`, { method: "DELETE" })
  if (!r.ok) {
    const j = await r.json().catch(() => ({}))
    return { ok: false, error: j.error ?? `http ${r.status}` }
  }
  return { ok: true }
}

export type WriteSandboxResult = {
  ok: boolean
  error?: string
  locked?: boolean
  lockError?: string
  committed?: boolean
  commitSha?: string
  commitError?: string
}
export async function writeSandbox(name: string, content: string, file: SandboxFile = "mise.toml"): Promise<WriteSandboxResult> {
  const r = await apiFetch(`/api/sandboxes/${encodeURIComponent(name)}?file=${encodeURIComponent(file)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  })
  if (!r.ok) {
    const j = await r.json().catch(() => ({}))
    return { ok: false, error: j.error ?? `http ${r.status}` }
  }
  const j = await r.json().catch(() => ({}))
  return {
    ok: true,
    locked: j.locked,
    lockError: j.lockError,
    committed: j.committed,
    commitSha: j.commitSha,
    commitError: j.commitError,
  }
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

export async function pullRepo(name: string): Promise<{ ok: boolean; output?: string; error?: string }> {
  const r = await apiFetch(`/api/workspace/repo/${encodeURIComponent(name)}/pull`, { method: "POST" })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: j.error ?? `http ${r.status}` }
  return { ok: true, output: j.output }
}

export async function addRepo(opts: { name: string; source: string }): Promise<{ ok: boolean; name?: string; kind?: "clone" | "symlink"; error?: string }> {
  const r = await apiFetch(`/api/workspace/repos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: j.error ?? `http ${r.status}` }
  return { ok: true, name: j.name, kind: j.kind }
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

export async function listKanbanColumns(board = "default"): Promise<KanbanColumn[]> {
  const r = await apiFetch(`/api/kanban/${encodeURIComponent(board)}`)
  if (!r.ok) return []
  const j = await r.json()
  return j.columns as KanbanColumn[]
}

export async function addKanbanCard(board: string, filename: string, opts: {
  text: string; assignee?: string; priority?: string; due?: string
  topics?: string[]; description?: string
}): Promise<{ cid?: string; error?: string }> {
  const r = await apiFetch(`/api/kanban/columns/${encodeURIComponent(board)}/${encodeURIComponent(filename)}/cards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { error: j.error ?? "add failed" }
  return { cid: j.cid }
}

export async function toggleKanbanCard(board: string, filename: string, cid: string): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/columns/${encodeURIComponent(board)}/${encodeURIComponent(filename)}/cards/${encodeURIComponent(cid)}/toggle`, {
    method: "PATCH",
  })
  return r.ok
}

export async function updateKanbanCard(board: string, filename: string, cid: string, patch: {
  text?: string; assignee?: string; priority?: string; due?: string
}): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/columns/${encodeURIComponent(board)}/${encodeURIComponent(filename)}/cards/${encodeURIComponent(cid)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  })
  return r.ok
}

export async function updateKanbanCardBlock(board: string, filename: string, cid: string, block: string): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/columns/${encodeURIComponent(board)}/${encodeURIComponent(filename)}/cards/${encodeURIComponent(cid)}/block`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ block }),
  })
  return r.ok
}

export async function deleteKanbanCard(board: string, filename: string, cid: string): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/columns/${encodeURIComponent(board)}/${encodeURIComponent(filename)}/cards/${encodeURIComponent(cid)}`, {
    method: "DELETE",
  })
  return r.ok
}

export async function moveKanbanCard(board: string, fromFile: string, cid: string, toFile: string, toIndex?: number): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/columns/${encodeURIComponent(board)}/${encodeURIComponent(fromFile)}/cards/${encodeURIComponent(cid)}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toFile, toIndex }),
  })
  return r.ok
}

export async function createKanbanColumn(board: string, filename: string, title?: string): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/columns/${encodeURIComponent(board)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename, title }),
  })
  return r.ok
}

// ── board management ──

export async function listBoards(): Promise<string[]> {
  const r = await apiFetch("/api/kanban/boards")
  if (!r.ok) return ["default"]
  const j = await r.json()
  return j.boards as string[]
}

export async function createBoard(name: string): Promise<boolean> {
  const r = await apiFetch("/api/kanban/boards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  })
  return r.ok
}

export async function renameBoard(oldName: string, newName: string): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/boards/${encodeURIComponent(oldName)}/rename`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: newName }),
  })
  return r.ok
}

// ── column config ──

export type KanbanColumnConfig = { file: string; color?: string }

export async function getKanbanConfig(board = "default"): Promise<KanbanColumnConfig[]> {
  const r = await apiFetch(`/api/kanban/config/${encodeURIComponent(board)}`)
  if (!r.ok) return []
  const j = await r.json()
  return j.columns as KanbanColumnConfig[]
}

export async function saveKanbanColumnOrder(board: string, orderedFiles: string[]): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/config/${encodeURIComponent(board)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ columns: orderedFiles }),
  })
  return r.ok
}

export async function renameKanbanColumn(board: string, fromFile: string, toFile: string): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/columns/${encodeURIComponent(board)}/${encodeURIComponent(fromFile)}/rename`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toFile }),
  })
  return r.ok
}

export async function deleteKanbanColumn(board: string, filename: string): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/columns/${encodeURIComponent(board)}/${encodeURIComponent(filename)}`, { method: "DELETE" })
  return r.ok
}

export async function setKanbanColumnColor(board: string, filename: string, color: string): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/columns/${encodeURIComponent(board)}/${encodeURIComponent(filename)}/color`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ color }),
  })
  return r.ok
}

export async function reorderKanbanCards(board: string, filename: string, cids: string[]): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/columns/${encodeURIComponent(board)}/${encodeURIComponent(filename)}/reorder`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cids }),
  })
  return r.ok
}

export async function assignKanbanDriver(board: string, filename: string, cid: string): Promise<{ ok: boolean; loopId?: string }> {
  const r = await apiFetch(`/api/kanban/columns/${encodeURIComponent(board)}/${encodeURIComponent(filename)}/cards/${encodeURIComponent(cid)}/assign-driver`, {
    method: "POST",
  })
  return r.ok ? await r.json() : { ok: false }
}

export async function createKanbanLoop(board: string, filename: string, cid: string): Promise<{ ok: boolean; loopId?: string }> {
  const r = await apiFetch(`/api/kanban/columns/${encodeURIComponent(board)}/${encodeURIComponent(filename)}/cards/${encodeURIComponent(cid)}/create-loop`, {
    method: "POST",
  })
  if (!r.ok) return { ok: false }
  return await r.json()
}

export async function linkKanbanLoop(board: string, filename: string, cid: string, loopId: string): Promise<boolean> {
  const r = await apiFetch(`/api/kanban/columns/${encodeURIComponent(board)}/${encodeURIComponent(filename)}/cards/${encodeURIComponent(cid)}/link-loop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loopId }),
  })
  return r.ok
}

export type TopicAggregate = {
  name: string
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

// ── git (workdir) ──

export type GitFileInfo = {
  path: string
  status: "A" | "M" | "D" | "R" | "?"
  additions: number
  deletions: number
  isBinary: boolean
}

export type GitStatus = {
  unstaged: GitFileInfo[]
  staged: GitFileInfo[]
}

export async function getGitStatus(loopId: string): Promise<GitStatus> {
  const r = await apiFetch(`/api/loops/${loopId}/git-status`)
  if (!r.ok) return { unstaged: [], staged: [] }
  return (await r.json()) as GitStatus
}

export async function getGitDiff(loopId: string, path: string, staged: boolean): Promise<string | null> {
  const r = await apiFetch(`/api/loops/${loopId}/git-diff?path=${encodeURIComponent(path)}&staged=${staged ? "1" : "0"}`)
  if (!r.ok) return null
  const j = await r.json()
  return j.diff as string ?? null
}

export async function gitStageFiles(loopId: string, files: string[], unstage: boolean = false): Promise<boolean> {
  const r = await apiFetch(`/api/loops/${loopId}/git-stage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files, unstage }),
  })
  return r.ok
}

export async function gitDiscardFile(loopId: string, file: string): Promise<boolean> {
  const r = await apiFetch(`/api/loops/${loopId}/git-discard`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file }),
  })
  return r.ok
}

export async function gitCommit(loopId: string, message: string): Promise<{ ok: boolean; error?: string }> {
  const r = await apiFetch(`/api/loops/${loopId}/git-commit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: j.error ?? "commit failed" }
  return { ok: true }
}

export type GitCommit = {
  hash: string
  shortHash: string
  subject: string
  author: string
  date: string
  parentHashes: string[]
  branch: string | null
  branches: string[]
  tags: string[]
}

export async function getGitLog(loopId: string, limit = 50): Promise<GitCommit[]> {
  const r = await apiFetch(`/api/loops/${loopId}/git-log?limit=${limit}`)
  if (!r.ok) return []
  const j = await r.json()
  return (j.commits ?? []) as GitCommit[]
}

// ── settings ──

export type SettingsProvider = {
  model: string
  baseUrl: string
  hasKey?: boolean
  maxContextTokens?: number
  apiKey?: string
}

export type TokenUsage = Record<string, { inputTokens: number; outputTokens: number }>

export type PersonalSettings = {
  providers: Record<string, SettingsProvider>
  default: string
  tokenUsage: TokenUsage
}

export type WorkspaceSettings = {
  providers: Record<string, { model: string; baseUrl: string; hasKey: boolean }>
  default: string
  tokenUsage: TokenUsage
}

export async function getPersonalSettings(): Promise<PersonalSettings> {
  const r = await apiFetch("/api/settings/personal")
  return (await r.json()) as PersonalSettings
}

export async function updatePersonalSettings(patch: {
  providers?: Record<string, { model: string; baseUrl: string; apiKey?: string; maxContextTokens?: number }>
  default?: string
}): Promise<boolean> {
  const r = await apiFetch("/api/settings/personal", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  })
  return r.ok
}

// ── disk-shape settings (rich Settings page) ──

/** `ConfigValue` mirror — used by both apiKey and envs values. */
export type ConfigValue = string | { vault: string } | { file: string }

/** `PathRef` mirror — used by mount.src. */
export type PathRef = string | { vault: string }

export type ProviderDisk = {
  model: string
  baseUrl: string
  apiKey?: ConfigValue
  maxContextTokens?: number
}

export type MountDisk = {
  src: PathRef
  dst: string
  rw?: boolean
}

export type PersonalConfigDisk = {
  /** Mixed map: "default" key carries a string; other keys carry ProviderDisk. */
  providers: Record<string, ProviderDisk | string>
  envs?: Record<string, ConfigValue>
  mounts?: MountDisk[]
  shell?: string
}

export type RefExistsMap = Record<string, { kind: string; exists: boolean }>

export async function getPersonalDisk(): Promise<{ disk: PersonalConfigDisk; refExists: RefExistsMap } | null> {
  const r = await apiFetch("/api/settings/personal/disk")
  if (!r.ok) return null
  return (await r.json()) as { disk: PersonalConfigDisk; refExists: RefExistsMap }
}

export async function savePersonalDisk(patch: Partial<PersonalConfigDisk>): Promise<{ ok: boolean; error?: string }> {
  const r = await apiFetch("/api/settings/personal/disk", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: j.error ?? `save failed (${r.status})` }
  return { ok: true }
}

export type PersonalEntry = { path: string; type: "file" | "dir" }
export async function listPersonalEntries(root: "personal" | "vault"): Promise<PersonalEntry[]> {
  const r = await apiFetch(`/api/settings/personal/entries?root=${root}`)
  if (!r.ok) return []
  const j = await r.json()
  return (j.entries as PersonalEntry[]) ?? []
}

export async function writePersonalValue(ref: ConfigValue, value: string): Promise<{ ok: boolean; error?: string }> {
  const r = await apiFetch("/api/settings/personal/value", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref, value }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: j.error ?? `write failed (${r.status})` }
  return { ok: true }
}

export async function getWorkspaceSettings(): Promise<WorkspaceSettings> {
  const r = await apiFetch("/api/settings/workspace")
  return (await r.json()) as WorkspaceSettings
}

export async function updateWorkspaceSettings(patch: {
  providers?: Record<string, { model: string; baseUrl: string; apiKey?: string }>
  default?: string
}): Promise<boolean> {
  const r = await apiFetch("/api/settings/workspace", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  })
  return r.ok
}

export type DailyUsage = Record<string, Record<string, { inputTokens: number; outputTokens: number }>>

export async function getDailyTokenUsage(): Promise<DailyUsage> {
  const r = await apiFetch("/api/settings/token-usage/daily")
  if (!r.ok) return {}
  return (await r.json()) as DailyUsage
}

// ── admin ──

export async function listAdminUsers(): Promise<AdminUser[]> {
  const r = await apiFetch("/api/admin/users")
  if (!r.ok) return []
  const j = await r.json()
  return (j.users as AdminUser[]) ?? []
}

export async function activateAdminUser(id: string): Promise<{ ok: boolean; error?: string }> {
  const r = await apiFetch(`/api/admin/users/${encodeURIComponent(id)}/activate`, { method: "POST" })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: j.error ?? `activate failed (${r.status})` }
  return { ok: true }
}

export async function setAdminUserRole(id: string, role: UserRole): Promise<{ ok: boolean; error?: string }> {
  const r = await apiFetch(`/api/admin/users/${encodeURIComponent(id)}/role`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: j.error ?? `role change failed (${r.status})` }
  return { ok: true }
}

export async function deleteAdminUser(id: string): Promise<{ ok: boolean; error?: string }> {
  const r = await apiFetch(`/api/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: j.error ?? `delete failed (${r.status})` }
  return { ok: true }
}

// ── workspace serve ──

export type ServeDomain = { domain: string; ip: string; baseUrl: string; withPort: boolean; https: boolean; displayPort: number }

export async function getServeDomain(): Promise<ServeDomain> {
  const r = await apiFetch("/api/serve/domain")
  if (!r.ok) return { domain: "nip.io", ip: "127.0.0.1", baseUrl: ".127.0.0.1.nip.io", withPort: false, https: false, displayPort: 7788 }
  return (await r.json()) as ServeDomain
}

export async function setServeDomain(data: { domain?: string; withPort?: boolean; https?: boolean; displayPort?: number }): Promise<boolean> {
  const r = await apiFetch("/api/serve/domain", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  })
  return r.ok
}

export async function checkAliasAvailable(alias: string, loopId?: string): Promise<{ available: boolean; reason?: string }> {
  const params = new URLSearchParams({ alias })
  if (loopId) params.set("loopId", loopId)
  const r = await apiFetch(`/api/serve/alias-check?${params}`)
  if (!r.ok) return { available: false, reason: "check failed" }
  return (await r.json()) as { available: boolean; reason?: string }
}

// ── chat ──

export type ChatConvKind = "channel" | "dm"

export type ChatConversation = {
  id: string
  kind: ChatConvKind
  name: string | null
  topic: string | null
  createdBy: string
  createdAt: number
  dmUserA: string | null
  dmUserB: string | null
  unread: number
  lastMessageTs: number | null
  peerUserId: string | null
}

export type ChatMessage = {
  id: number
  convId: string
  author: string
  text: string
  ts: number
  /** NULL = thread root; otherwise the root msg id this reply belongs to. */
  parentId: number | null
}

/** Thread root with denormalized reply stats. Returned by listChatMessages
 *  (main feed). UI uses replyCount to render the "💬 N replies" affordance. */
export type ChatThreadRoot = ChatMessage & {
  replyCount: number
  lastReplyTs: number | null
}

export type ChatWorkspaceUser = {
  id: string
  role: "admin" | "member"
  isMe: boolean
}

export async function listChatConversations(): Promise<ChatConversation[]> {
  const r = await apiFetch("/api/chat/conversations")
  if (!r.ok) return []
  const j = await r.json()
  return (j.conversations as ChatConversation[]) ?? []
}

export async function listChatUsers(): Promise<ChatWorkspaceUser[]> {
  const r = await apiFetch("/api/chat/users")
  if (!r.ok) return []
  const j = await r.json()
  return (j.users as ChatWorkspaceUser[]) ?? []
}

export async function createChatChannel(
  name: string,
  topic?: string,
): Promise<{ conv?: ChatConversation; error?: string }> {
  const r = await apiFetch("/api/chat/channels", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, topic }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { error: j.error ?? `create failed (${r.status})` }
  return { conv: j.conv as ChatConversation }
}

export async function deleteChatChannel(id: string): Promise<{ ok: boolean; error?: string }> {
  const r = await apiFetch(`/api/chat/channels/${encodeURIComponent(id)}`, { method: "DELETE" })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: j.error ?? `delete failed (${r.status})` }
  return { ok: true }
}

export async function openChatDm(username: string): Promise<{ conv?: ChatConversation; error?: string }> {
  const r = await apiFetch(`/api/chat/dm/${encodeURIComponent(username)}`, { method: "POST" })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { error: j.error ?? `open DM failed (${r.status})` }
  return { conv: j.conv as ChatConversation }
}

export async function listChatMessages(
  convId: string,
  opts: { before?: number; limit?: number } = {},
): Promise<ChatThreadRoot[]> {
  const q = new URLSearchParams()
  if (opts.before) q.set("before", String(opts.before))
  if (opts.limit) q.set("limit", String(opts.limit))
  const r = await apiFetch(`/api/chat/conversations/${encodeURIComponent(convId)}/messages?${q.toString()}`)
  if (!r.ok) return []
  const j = await r.json()
  return (j.messages as ChatThreadRoot[]) ?? []
}

/** Fetch a thread (root + replies). Used when opening the ThreadPanel. */
export async function getChatThread(
  rootId: number,
): Promise<{ root: ChatMessage; replies: ChatMessage[] } | null> {
  const r = await apiFetch(`/api/chat/threads/${rootId}`)
  if (!r.ok) return null
  return (await r.json()) as { root: ChatMessage; replies: ChatMessage[] }
}

export async function sendChatMessage(
  convId: string,
  text: string,
  parentId: number | null = null,
): Promise<{ message?: ChatMessage; error?: string }> {
  const r = await apiFetch(`/api/chat/conversations/${encodeURIComponent(convId)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(parentId != null ? { text, parentId } : { text }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { error: j.error ?? `send failed (${r.status})` }
  return { message: j.message as ChatMessage }
}

export async function markChatRead(convId: string, lastReadId: number): Promise<boolean> {
  const r = await apiFetch(`/api/chat/conversations/${encodeURIComponent(convId)}/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lastReadId }),
  })
  return r.ok
}

/** Spawn a loop seeded from a thread (root + replies). The thread is the
 *  natural semantic unit for AI seeding — works even for a brand-new top-
 *  level message with no replies (snapshot of 1 line). */
export async function spawnLoopFromThread(
  rootId: number,
  title?: string,
): Promise<{ loopId?: string; seedPrompt?: string; messageCount?: number; error?: string }> {
  const r = await apiFetch(`/api/chat/threads/${rootId}/spawn-loop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(title ? { title } : {}),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { error: j.error ?? `spawn failed (${r.status})` }
  return { loopId: j.loopId, seedPrompt: j.seedPrompt, messageCount: j.messageCount }
}

// ── onboarding ──

export type OnboardingStatus = { state: "fresh" | "started" | "done"; loopId?: string }

export async function getOnboarding(): Promise<OnboardingStatus> {
  const r = await apiFetch("/api/onboarding")
  if (!r.ok) return { state: "fresh" }
  return (await r.json()) as OnboardingStatus
}

export async function startOnboarding(): Promise<{ loopId?: string; error?: string }> {
  const r = await apiFetch("/api/onboarding/start", { method: "POST" })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { error: j.error ?? "start failed" }
  return { loopId: j.loopId }
}

export async function markOnboardingDone(): Promise<boolean> {
  const r = await apiFetch("/api/onboarding/done", { method: "POST" })
  return r.ok
}

// ── MCP auth ──

export type McpAuthStatus = Record<string, { connected: boolean; expiresAt?: number; scope?: string }>

/** List the user's MCP auth state for a given vault. */
export async function getMcpAuth(vault: string = "default"): Promise<McpAuthStatus> {
  const r = await apiFetch(`/api/mcp-auth?vault=${encodeURIComponent(vault)}`)
  if (!r.ok) return {}
  return (await r.json()) as McpAuthStatus
}

/** Begin OAuth flow. Returns the authorizationUrl the browser should navigate to. */
export async function startMcpAuth(
  serverName: string,
  vault: string = "default",
): Promise<{ authorizationUrl?: string; error?: string }> {
  const r = await apiFetch("/api/mcp-auth/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serverName, vault }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { error: j.error ?? "start failed" }
  return { authorizationUrl: j.authorizationUrl }
}

export async function deleteMcpAuth(serverName: string, vault: string = "default"): Promise<boolean> {
  const r = await apiFetch(`/api/mcp-auth/${encodeURIComponent(serverName)}?vault=${encodeURIComponent(vault)}`, {
    method: "DELETE",
  })
  return r.ok
}

/** Public-facing MCP server config (workspace-defined). Used by Settings → MCP Auth
 *  to know which servers are available to connect. */
export type McpServerEntry = {
  name: string
  type: "http" | "sse" | "stdio"
  url?: string
  /** Personal-tier only: this entry shadows a same-named workspace entry. */
  shadowsWorkspace?: boolean
}

export type McpServerTier = {
  id: "workspace" | "personal"
  label: string
  /** Filesystem path (relative to LOOPAT_HOME) where this tier is configured. */
  path: string
  servers: McpServerEntry[]
}

export type McpServerInventory = { tiers: McpServerTier[] }

export async function listMcpServers(): Promise<McpServerInventory> {
  const r = await apiFetch("/api/mcp-servers")
  if (!r.ok) return { tiers: [] }
  return (await r.json()) as McpServerInventory
}

/** Restart a loop's in-memory SDK session — interrupt the current query()
 *  so the next user message re-spawns CC and re-reads mcpServers + tokens.
 *  Used by the /mcp popover's "Reload" button after the user connects a new
 *  MCP server. Conversation history is preserved by the SDK. */
export async function restartLoopSession(loopId: string): Promise<{ restarted: boolean; error?: string }> {
  const r = await apiFetch(`/api/loops/${encodeURIComponent(loopId)}/restart-session`, {
    method: "POST",
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { restarted: false, error: j.error ?? `restart failed (${r.status})` }
  return { restarted: !!j.restarted }
}
