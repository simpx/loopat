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
  /** Context-setup problems captured at loop creation (e.g. the per-user
   *  knowledge/notes clone failed). Shown as a warning banner in the loop view
   *  so a silently-empty context doesn't go unnoticed. */
  contextWarnings?: string[]
  archived?: boolean
  archivedAt?: string
  /** If true, /share/:id is publicly viewable. Toggle via setLoopPublic. */
  public?: boolean
  publicAt?: string
  shareEnabled?: boolean
  shareMode?: "static" | "port" | "ephemeral"
  shareAlias?: string
  sharePort?: number
  shareExternalPort?: number
  shareProtocol?: "tcp" | "udp" | "static"
  config?: {
    profiles?: string[]
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
  /** Deploy key (host-secrets) — for the personal repo only. */
  publicKey: string | null
  /** Per-vault SSH public keys — the keys a loop uses for TEAM repos
   *  (knowledge / notes / repos). One per vault; this is what to register on
   *  the team git host. */
  vaultKeys?: { vault: string; publicKey: string }[]
  imported: boolean
  gitHost?: { provider: string; baseUrl: string | null; defaultRepo?: string; tokenHelp?: string | null }
}

// List the user's repos for the onboarding picker ("personal"-named first).
// `ok: false` means the token was rejected (or the request failed) — surface
// `error` instead of treating it as an empty list.
export async function listPersonalRepos(
  token: string,
): Promise<{ ok: boolean; repos: { name: string; path: string }[]; login?: string; error?: string }> {
  const r = await apiFetch("/api/personal/repos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  })
  const j = await r.json().catch(() => ({}) as any)
  if (!r.ok) return { ok: false, repos: [], error: j?.error ?? "request failed" }
  return { ok: j.ok !== false, repos: Array.isArray(j.repos) ? j.repos : [], login: j.login, error: j.error }
}

export async function getPersonalStatus(): Promise<PersonalStatus | null> {
  const r = await apiFetch("/api/personal/status")
  if (!r.ok) return null
  return (await r.json()) as PersonalStatus
}

// Provider-driven onboarding gate. `gated:false` → no gate (the main UI shows
// normally). Otherwise the app blocks on the onboarding screen until `done`.
export type OnboardingMissing = { id: string; label: string; help?: string }
export type OnboardingStatus = {
  gated: boolean
  done: boolean
  needsPersonalRepo: boolean
  missing: OnboardingMissing[]
}
export async function getOnboarding(): Promise<OnboardingStatus | null> {
  const r = await apiFetch("/api/onboarding")
  if (!r.ok) return null
  return (await r.json()) as OnboardingStatus
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

export async function pullPersonalVault(opts?: { force?: boolean }): Promise<{
  ok: boolean
  error?: string
  conflict?: boolean
  files?: string[]
  needsStash?: boolean
  message?: string
}> {
  const r = await apiFetch("/api/personal/pull", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ force: opts?.force ?? false }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return {
      ok: false,
      error: j.error ?? `pull failed (${r.status})`,
      conflict: j.conflict,
      files: j.files,
      needsStash: j.needsStash,
    }
  }
  return { ok: true, message: j.message }
}

export async function pushPersonalVault(): Promise<{
  ok: boolean
  error?: string
  conflict?: boolean
  files?: string[]
  needsPull?: boolean
  message?: string
}> {
  const r = await apiFetch("/api/personal/push", { method: "POST" })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return {
      ok: false,
      error: j.error ?? `push failed (${r.status})`,
      conflict: j.conflict,
      files: j.files,
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

// Onboard personal via a GitHub PAT: loopat creates the repo, registers the
// deploy key, clones + handles git-crypt. The token is used host-side only.
export async function setupPersonalGithub(
  token: string,
  repoName?: string,
  cryptKey?: string,
  baseUrl?: string,
): Promise<{
  ok: boolean
  error?: string
  needsCryptKey?: boolean
  repo?: string
  created?: boolean
  autoInitialized?: boolean
  cryptKey?: string | null
}> {
  const payload: Record<string, string> = { token }
  if (repoName) payload.repoName = repoName
  if (cryptKey) payload.cryptKey = cryptKey
  if (baseUrl) payload.baseUrl = baseUrl
  const r = await apiFetch("/api/personal/github", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    return { ok: false, error: j.error ?? `github setup failed (${r.status})`, needsCryptKey: !!j.needsCryptKey }
  }
  return {
    ok: true,
    repo: typeof j.repo === "string" ? j.repo : undefined,
    created: !!j.created,
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

export async function createLoop(opts: {
  title: string
  repo?: string
  /** Active profiles for this loop. Base is auto-included server-side.
   *  Empty/undefined = base + personal CLAUDE.md only, no plugins. */
  profiles?: string[]
  vault?: string
  /** Admin-only flags — still go via the internal `/api/loops` endpoint;
   *  v1 doesn't surface them. */
  knowledgeRw?: boolean
  mountAllLoops?: boolean
}): Promise<LoopMeta> {
  // Admin-flag path keeps using the internal endpoint (those flags aren't in v1).
  if (opts.knowledgeRw || opts.mountAllLoops) {
    const body: Record<string, unknown> = {
      title: opts.title,
      repo: opts.repo,
      profiles: opts.profiles,
      vault: opts.vault,
    }
    if (opts.knowledgeRw) body.knowledge_rw = true
    if (opts.mountAllLoops) body.mount_all_loops = true
    const r = await apiFetch("/api/loops", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    return (await r.json()) as LoopMeta
  }
  // Normal create → v1 API. Translate snake_case + loop_ prefix back to the
  // web's LoopMeta shape so existing callers don't change.
  const r = await apiFetch("/api/v1/loops", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: opts.title,
      profiles: opts.profiles,
      vault: opts.vault,
      repo: opts.repo,
    }),
  })
  if (!r.ok) throw new Error(`createLoop failed (${r.status})`)
  const v1 = await r.json() as {
    id: string
    title: string
    created_at: string
    created_by: string
    archived: boolean
    profiles: string[]
    vault: string
    repo: string | null
  }
  const rawId = v1.id.startsWith("loop_") ? v1.id.slice("loop_".length) : v1.id
  return {
    id: rawId,
    title: v1.title,
    createdAt: v1.created_at,
    createdBy: v1.created_by,
    archived: v1.archived,
    repo: v1.repo ?? undefined,
    config: {
      profiles: v1.profiles,
      vault: v1.vault,
    },
  } as LoopMeta
}

export type ProfileEntry = { name: string; description?: string }
export async function listProfiles(): Promise<ProfileEntry[]> {
  const r = await apiFetch(`/api/profiles`)
  if (!r.ok) return []
  const j = await r.json()
  return (j.profiles ?? []) as ProfileEntry[]
}

/** Current user's default_profiles from personal config (the diff baseline
 *  NewLoopDialog pre-checks). Empty array if config missing or field absent. */
export async function getDefaultProfiles(): Promise<string[]> {
  const r = await apiFetch(`/api/personal/default-profiles`)
  if (!r.ok) return []
  const j = await r.json()
  return Array.isArray(j.default_profiles) ? j.default_profiles : []
}

export type LoopStats = {
  plugins: number
  skills: number
  agents: number
  hooks: number
  mcpServers: number
  /** Toolchain tools (mise.toml [tools] entries) deduped across all tiers. */
  toolchain: number
}
/** Preview of what a loop with the given profile selection will contain.
 *  Team layer is always implicit. */
export async function getLoopStats(profiles: string[]): Promise<LoopStats | null> {
  const r = await apiFetch(`/api/loop-stats?profiles=${encodeURIComponent(profiles.join(","))}`)
  if (!r.ok) return null
  return (await r.json()) as LoopStats
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

/** Recursively list all files under a path in one call. */
export async function listFilesTree(loopId: string, path = ""): Promise<FileEntry[]> {
  const r = await apiFetch(`/api/loops/${loopId}/files/tree?path=${encodeURIComponent(path)}`)
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

// Save notes to the shared remote (the no-AI UI loop): commit + rebase onto
// origin/main + ff-push. A real conflict is held back (local edit kept).
export async function saveNotes(): Promise<{
  ok: boolean
  conflict?: boolean
  files?: string[]
  needsPull?: boolean
  error?: string
  message?: string
}> {
  const r = await apiFetch("/api/notes/save", { method: "POST" })
  const j = await r.json().catch(() => ({}) as any)
  if (!r.ok) return { ok: false, conflict: j.conflict, files: j.files, needsPull: j.needsPull, error: j.error ?? `save failed (${r.status})` }
  return { ok: true, message: j.message }
}

// How many commits notes is behind origin (drives the "remote updated" hint).
export async function notesBehind(): Promise<number> {
  const r = await apiFetch("/api/notes/behind")
  const j = await r.json().catch(() => ({}) as any)
  return typeof j.behind === "number" ? j.behind : 0
}

// Refresh = ff-pull origin into the notes worktree. `diverged` means you have
// unsaved local edits — the client keeps its draft and just re-reads.
export async function refreshNotes(): Promise<{ ok: boolean; diverged?: boolean; error?: string }> {
  const r = await apiFetch("/api/notes/refresh", { method: "POST" })
  const j = await r.json().catch(() => ({}) as any)
  return { ok: !!j.ok, diverged: j.diverged, error: j.error }
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

// Context repos roster — DECLARATIVE, lives in the knowledge repo's
// .loopat/config.json (notes remote + repos[]). Physical clones stay
// on-demand at loop creation. Edited via the /context/repos page.
export type ContextRepoSpec = { name: string; git: string }
export type ContextRepoRoster = { notes: { git: string } | null; repos: ContextRepoSpec[] }

export async function getContextRepos(): Promise<ContextRepoRoster> {
  const r = await apiFetch(`/api/context/repos`)
  if (!r.ok) return { notes: null, repos: [] }
  const j = await r.json()
  return { notes: j.notes ?? null, repos: (j.repos ?? []) as ContextRepoSpec[] }
}

export async function putContextRepos(roster: ContextRepoRoster): Promise<{ ok: boolean; error?: string; savedLocally?: boolean }> {
  const r = await apiFetch(`/api/context/repos`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(roster),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: j.error ?? `http ${r.status}`, savedLocally: j.savedLocally }
  return { ok: true }
}

// Sandbox API client removed — sandbox concept replaced by profiles
// (composition model). Profile editing now happens via filesystem edits to
// knowledge/.loopat/profiles/<n>/.claude/; the matching backend endpoints
// were deleted in the profile refactor.

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

// ── Unified workspace-resource sync (knowledge / notes / repos) ──

export type SyncResource = "knowledge" | "notes" | { repo: string }

export type RepoSyncStatus = {
  isGitRepo: boolean
  hasRemote: boolean
  branch: string
  ahead: number
  behind: number
  uncommitted: number
}

function syncBase(r: SyncResource): string {
  if (typeof r === "string") return `/api/sync/${r}`
  return `/api/sync/repos/${encodeURIComponent(r.repo)}`
}

export async function syncStatus(r: SyncResource): Promise<RepoSyncStatus | null> {
  const res = await apiFetch(`${syncBase(r)}/status`)
  if (!res.ok) return null
  return (await res.json()) as RepoSyncStatus
}

export async function syncPull(r: SyncResource): Promise<{ ok: boolean; message?: string; error?: string }> {
  const res = await apiFetch(`${syncBase(r)}/pull`, { method: "POST" })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) return { ok: false, error: j.error ?? `http ${res.status}` }
  return { ok: true, message: j.message }
}

export async function syncPush(r: SyncResource): Promise<{ ok: boolean; message?: string; error?: string }> {
  const res = await apiFetch(`${syncBase(r)}/push`, { method: "POST" })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) return { ok: false, error: j.error ?? `http ${res.status}` }
  return { ok: true, message: j.message }
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

export type ModelEntry = { id: string; enabled?: boolean; maxContextTokens?: number }
export type ProviderInfo = { model?: string; models: ModelEntry[]; baseUrl: string; source: "personal" | "workspace"; enabled: boolean; hasKey: boolean }
export type ProvidersResponse = { providers: Record<string, ProviderInfo>; default: string }
export async function getProviders(): Promise<ProvidersResponse> {
  const r = await apiFetch("/api/providers")
  if (!r.ok) return { providers: {}, default: "" }
  return (await r.json()) as ProvidersResponse
}

export async function testProviderConnection(
  baseUrl: string,
  apiKey: string,
  model: string,
  provider?: string,
  source?: "personal" | "workspace",
): Promise<{ ok: boolean; error?: string }> {
  const body: Record<string, string> = { baseUrl, model }
  if (apiKey) {
    body.apiKey = apiKey
  } else if (provider && source) {
    body.provider = provider
    body.source = source
  }
  const r = await apiFetch("/api/providers/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: j.error ?? `test failed (${r.status})` }
  return j as { ok: boolean; error?: string }
}

export type VersionInfo = { branch: string; commit: string }
export async function getVersion(): Promise<VersionInfo> {
  const r = await apiFetch("/api/version")
  if (!r.ok) return { branch: "unknown", commit: "unknown" }
  return (await r.json()) as VersionInfo
}

// ── admin platform (/admin/system) ──

export type AdminActiveLoop = {
  id: string
  title: string
  driver: string
  wsCount: number
  generating: boolean
  /** Seconds since last user message; -1 if no messages.jsonl. */
  lastMsgAgeSec: number
}

export type AdminSystemInfo = {
  version: {
    branch: string
    commit: string
    behindBy: number
    latestCommit: string | null
    latestMessage: string | null
  }
  activity: {
    activeLoops: number
    activeUsers: number
    totalWs: number
    totalGenerating: number
    loops: AdminActiveLoop[]
  }
}

export async function getAdminSystem(): Promise<AdminSystemInfo | null> {
  const r = await apiFetch("/api/admin/system")
  if (!r.ok) return null
  return (await r.json()) as AdminSystemInfo
}

export async function adminCheckForUpdates(): Promise<{ ok: boolean; error?: string }> {
  const r = await apiFetch("/api/admin/system/check", { method: "POST" })
  return (await r.json()) as { ok: boolean; error?: string }
}

export async function adminPull(): Promise<{
  ok: boolean
  pulled?: boolean
  oldHead?: string
  newHead?: string
  message?: string
  error?: string
}> {
  const r = await apiFetch("/api/admin/system/pull", { method: "POST" })
  return (await r.json()) as any
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
  model?: string
  models: ModelEntry[]
  baseUrl: string
  hasKey?: boolean
  enabled: boolean
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
  providers: Record<string, { models: ModelEntry[]; baseUrl: string; hasKey: boolean; enabled: boolean }>
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

export type ProviderDisk = {
  model?: string
  models?: ModelEntry[]
  baseUrl: string
  /** Plain string; may contain `${VAR}` references resolved against vault envs/ at load. */
  apiKey?: string
  maxContextTokens?: number
  enabled?: boolean
}

export type PersonalConfigDisk = {
  /** Mixed map: "default" key carries a string; other keys carry ProviderDisk. */
  providers: Record<string, ProviderDisk | string>
  shell?: string
}

/**
 * For each `providers.<name>.apiKey` ref the backend reports:
 *   - kind: "literal" | "var" | "mixed" | "empty"
 *   - exists: whether the vault env file referenced by `${VAR}` exists
 *   - varName: the `${VAR}` name (only when kind === "var")
 */
export type RefExistsMap = Record<string, { kind: string; exists: boolean; varName?: string }>

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

/**
 * Write a value to a vault env file. `name` is the env var name (e.g.
 * "ANTHROPIC_API_KEY"); `vault` defaults to "default". The next personal
 * config load picks up the new value via `${VAR}` substitution in apiKey.
 */
export async function writeVaultEnv(name: string, value: string, vault: string = "default"): Promise<{ ok: boolean; error?: string }> {
  const r = await apiFetch("/api/settings/personal/value", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, value, vault }),
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
  providers?: Record<string, { model?: string; models?: ModelEntry[]; baseUrl: string; apiKey?: string; enabled?: boolean }>
  default?: string
}): Promise<boolean> {
  const r = await apiFetch("/api/settings/workspace", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  })
  return r.ok
}

export type DailyUsage = Record<string, Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>>

export async function getDailyTokenUsage(): Promise<DailyUsage> {
  const r = await apiFetch("/api/settings/token-usage/daily")
  if (!r.ok) return {}
  return (await r.json()) as DailyUsage
}

export type LoopTokenUsage = {
  loopId: string
  title: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  lastActivity: string
}

export async function getLoopTokenUsage(): Promise<LoopTokenUsage[]> {
  const r = await apiFetch("/api/settings/token-usage/loops")
  if (!r.ok) return []
  return (await r.json()) as LoopTokenUsage[]
}

// ── admin presets ──

export type ProviderPreset = {
  name: string
  baseUrl: string
  models: string[]
}

export type MiseToolPreset = {
  name: string
  suggestedVersion: string
  description?: string
  backend?: string
}

export type PresetsData = {
  providerPresets: ProviderPreset[]
  miseToolPresets: MiseToolPreset[]
}

export async function getAdminPresets(): Promise<PresetsData> {
  const r = await apiFetch("/api/admin/presets")
  if (!r.ok) return { providerPresets: [], miseToolPresets: [] }
  return (await r.json()) as PresetsData
}

export async function updateAdminPresets(presets: PresetsData): Promise<boolean> {
  const r = await apiFetch("/api/admin/presets", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(presets),
  })
  return r.ok
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

export type ServeConfig = {
  // Standard serve
  serveEnabled: boolean
  domain: string
  ip: string
  baseUrl: string
  withPort: boolean
  https: boolean
  displayPort: number
  // Dynamic port
  serveDynamicEnabled: boolean
  serveDynamicDomain: string
  serveDynamicPortRange: string
  serveDynamicUdpEnabled: boolean
  serveDynamicStaticEnabled: boolean
  // Ephemeral port
  serveEphemeralEnabled: boolean
  serveEphemeralDomain: string
}

export async function getServeConfig(): Promise<ServeConfig> {
  const r = await apiFetch("/api/serve/config")
  if (!r.ok) return {
    serveEnabled: true, domain: "nip.io", ip: "127.0.0.1", baseUrl: ".127.0.0.1.nip.io",
    withPort: false, https: false, displayPort: 7788,
    serveDynamicEnabled: false, serveDynamicDomain: "", serveDynamicPortRange: "10000-20000",
    serveDynamicUdpEnabled: false, serveDynamicStaticEnabled: false,
    serveEphemeralEnabled: false, serveEphemeralDomain: "",
  }
  return (await r.json()) as ServeConfig
}

/** Read the live host port for a loop's ephemeral share. Returns null if
 *  the loop isn't in ephemeral mode, or the container isn't running yet. */
export async function getCurrentSharePort(loopId: string): Promise<{ port: number | null; internalPort?: number; protocol?: "tcp" | "udp" }> {
  const r = await apiFetch(`/api/loops/${loopId}/share/current-port`)
  if (!r.ok) return { port: null }
  return (await r.json()) as { port: number | null; internalPort?: number; protocol?: "tcp" | "udp" }
}

export async function setServeConfig(data: Record<string, unknown>): Promise<boolean> {
  const r = await apiFetch("/api/serve/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  })
  return r.ok
}

export async function getAvailablePort(): Promise<{ port: number | null; error?: string }> {
  const r = await apiFetch("/api/serve/available-port")
  if (!r.ok) return { port: null, error: "request failed" }
  return (await r.json()) as { port: number | null; error?: string }
}

export async function checkPortAvailable(port: number, loopId?: string): Promise<{ available: boolean; reason?: string }> {
  const r = await apiFetch(`/api/serve/check-port?port=${port}&loopId=${loopId || ""}`)
  if (!r.ok) return { available: false, reason: "request failed" }
  return (await r.json()) as { available: boolean; reason?: string }
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

// ── MCP servers ──

/**
 * MCP server, as returned by /api/mcp-servers. The list is derived from the
 * loop's merged settings.json (team + profile + personal + plugin defaults).
 *
 * `authed` is a pure existence check on the env file named by `authTokenEnv`
 * in the user's personal default vault — it does NOT validate the token
 * (no expiry check, no probe). Click "Re-authorize" anytime to refresh it.
 */
export type McpServerEntry = {
  name: string
  type: "http" | "sse" | "stdio"
  url?: string
  /** Env var name parsed from `Authorization: Bearer ${VAR}` in headers.
   *  null when the server doesn't use a Bearer-template (stdio servers,
   *  static-keyed servers, non-Bearer auth schemes). */
  authTokenEnv: string | null
  /** True iff a non-empty env file exists at `<personal default vault>/envs/<authTokenEnv>`. */
  authed: boolean
  /** OAuth capability probe result. dcr=loopat can auto-auth; manual=admin
   *  must register an app (loopat can't); none=no OAuth (server is public or
   *  uses non-OAuth auth); unreachable=probe failed. */
  oauthSupport?: "dcr" | "manual" | "none" | "unreachable"
}

export type McpServerInventory = { servers: McpServerEntry[] }

export async function reprobeMcpServers(url?: string): Promise<void> {
  await apiFetch("/api/mcp-servers/reprobe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(url ? { url } : {}),
  })
}

export async function listMcpServers(loopId?: string): Promise<McpServerInventory> {
  const q = loopId ? `?loopId=${encodeURIComponent(loopId)}` : ""
  const r = await apiFetch(`/api/mcp-servers${q}`)
  if (!r.ok) return { servers: [] }
  return (await r.json()) as McpServerInventory
}

/** Begin OAuth flow for an MCP server visible in the loop's merged settings.
 *  Returns the authorizationUrl the browser should navigate to. */
export async function startMcpAuth(
  serverName: string,
  loopId: string,
): Promise<{ authorizationUrl?: string; error?: string }> {
  const r = await apiFetch("/api/mcp-auth/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serverName, loopId }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { error: j.error ?? "start failed" }
  return { authorizationUrl: j.authorizationUrl }
}

/** Forget an MCP token — deletes the env file from the user's personal
 *  default vault. This is the inverse of OAuth: subsequent /api/mcp-servers
 *  responses will show `authed: false` for any server keyed on this env. */
export async function deleteEnv(name: string): Promise<boolean> {
  const r = await apiFetch(`/api/envs/${encodeURIComponent(name)}`, { method: "DELETE" })
  return r.ok
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

// ── composition model: tiers ──

export type TierId = "team" | "personal" | "project" | "local" | (string & {})

export type TierInfo = {
  id: TierId
  label: string
  path: string
  exists: boolean
  editable: boolean
  managedBy: "admin" | "user" | "sdk"
  settings: Record<string, any> | null
  claudeMd: string | null
  pluginCount: number
  mcpServerCount: number
  marketplaceCount: number
  hookCount: number
  skillCount: number
  agentCount: number
  /** Toolchain tools declared in this tier's mise.toml. */
  toolchainCount: number
  overrides: Record<string, { overrides: string; value: any }>
}

export type TiersResponse = {
  tiers: TierInfo[]
  mergedSettings: Record<string, any>
  isAdmin: boolean
}

export async function getTiers(): Promise<TiersResponse | null> {
  const r = await apiFetch("/api/tiers")
  if (!r.ok) return null
  return (await r.json()) as TiersResponse
}

export async function getTierSettings(tierId: string): Promise<Record<string, any> | null> {
  const r = await apiFetch(`/api/tiers/${encodeURIComponent(tierId)}/settings`)
  if (!r.ok) return null
  return (await r.json()) as Record<string, any>
}

export async function saveTierSettings(tierId: string, settings: Record<string, any>): Promise<{ ok: boolean; error?: string }> {
  const r = await apiFetch(`/api/tiers/${encodeURIComponent(tierId)}/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: j.error ?? `save failed (${r.status})` }
  return { ok: true }
}

// ── mise.toml config per tier ──

export type MiseConfigResponse = {
  content: string
  exists: boolean
  error?: string
}

export async function getTierMiseConfig(tierId: string): Promise<MiseConfigResponse> {
  const r = await apiFetch(`/api/tiers/${encodeURIComponent(tierId)}/mise-config`)
  if (!r.ok) return { content: "", exists: false, error: `fetch failed (${r.status})` }
  return (await r.json()) as MiseConfigResponse
}

export async function saveTierMiseConfig(tierId: string, content: string): Promise<{ ok: boolean; error?: string }> {
  const r = await apiFetch(`/api/tiers/${encodeURIComponent(tierId)}/mise-config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: j.error ?? `save failed (${r.status})` }
  return { ok: true }
}

// ── plugin inventory ──

export type PluginEntry = {
  name: string
  marketplace: string
  displayName: string
  description?: string
}

export type PluginWithStatus = PluginEntry & {
  installed: boolean
  marketplaceName: string
}

export type MarketplaceSource = {
  name: string
  source: any
  installLocation?: string
}

export async function listAvailablePlugins(): Promise<PluginEntry[]> {
  const r = await apiFetch("/api/plugins/available")
  if (!r.ok) return []
  const j = await r.json()
  return (j.plugins as PluginEntry[]) ?? []
}

export async function browseMarketplacePlugins(): Promise<PluginWithStatus[]> {
  const r = await apiFetch("/api/plugins/browse")
  if (!r.ok) return []
  const j = await r.json()
  return (j.plugins as PluginWithStatus[]) ?? []
}

export async function listMarketplaces(): Promise<MarketplaceSource[]> {
  const r = await apiFetch("/api/marketplaces")
  if (!r.ok) return []
  const j = await r.json()
  return (j.marketplaces as MarketplaceSource[]) ?? []
}

export async function refreshMarketplaces(): Promise<{ ok: boolean; added?: string[]; error?: string }> {
  const r = await apiFetch("/api/plugins/refresh", { method: "POST" })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: j.error ?? `refresh failed (${r.status})` }
  return { ok: true, added: j.added }
}

// ── profile CRUD (admin) ──

export type ProfileDetail = {
  name: string
  path: string
  description: string | null
  settings: Record<string, any> | null
  claudeMd: string | null
  pluginCount: number
  mcpServerCount: number
  marketplaceCount: number
  hookCount: number
  skillCount: number
  agentCount: number
  /** Toolchain tools declared in this profile's mise.toml. */
  toolchainCount: number
}

export async function listProfilesRich(): Promise<ProfileDetail[]> {
  const r = await apiFetch("/api/admin/profiles")
  if (!r.ok) return []
  const j = await r.json()
  return (j.profiles as ProfileDetail[]) ?? []
}

export async function createProfile(name: string): Promise<{ ok: boolean; error?: string }> {
  const r = await apiFetch("/api/admin/profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: j.error ?? `create failed (${r.status})` }
  return { ok: true }
}

export async function getProfileDetail(name: string): Promise<ProfileDetail | null> {
  const r = await apiFetch(`/api/admin/profiles/${encodeURIComponent(name)}`)
  if (!r.ok) return null
  return (await r.json()) as ProfileDetail
}

export async function updateProfile(name: string, data: { settings?: Record<string, any>; claudeMd?: string }): Promise<{ ok: boolean; error?: string }> {
  const r = await apiFetch(`/api/admin/profiles/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: j.error ?? `update failed (${r.status})` }
  return { ok: true }
}

export async function deleteProfile(name: string): Promise<{ ok: boolean; error?: string }> {
  const r = await apiFetch(`/api/admin/profiles/${encodeURIComponent(name)}`, { method: "DELETE" })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: j.error ?? `delete failed (${r.status})` }
  return { ok: true }
}

// ── personal default profiles ──

export async function saveDefaultProfiles(profiles: string[]): Promise<{ ok: boolean; error?: string }> {
  const r = await apiFetch("/api/personal/default-profiles", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ default_profiles: profiles }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: j.error ?? `save failed (${r.status})` }
  return { ok: true }
}

// ── API tokens (v1 /me/tokens) ──

export type ApiTokenEntry = {
  tokenId: string
  label: string
  createdAt: string
  lastUsedAt?: string
}

export async function listApiTokens(): Promise<ApiTokenEntry[]> {
  const r = await apiFetch("/api/v1/me/tokens")
  if (!r.ok) return []
  const j = await r.json().catch(() => ({ tokens: [] }))
  return j.tokens ?? []
}

export async function createApiToken(label: string): Promise<{ tokenId: string; token: string; label: string; createdAt: string } | null> {
  const r = await apiFetch("/api/v1/me/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label }),
  })
  if (!r.ok) return null
  return await r.json().catch(() => null)
}

export async function revokeApiToken(tokenId: string): Promise<boolean> {
  const r = await apiFetch(`/api/v1/me/tokens/${encodeURIComponent(tokenId)}`, {
    method: "DELETE",
  })
  return r.ok
}
