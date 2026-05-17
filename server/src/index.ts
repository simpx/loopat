import { Hono } from "hono"
import { cors } from "hono/cors"
import { createBunWebSocket } from "hono/bun"
import { existsSync } from "node:fs"
import { execSync, execFile } from "node:child_process"
import { promisify } from "node:util"
import { listLoops, createLoop, getLoop, loopExists, patchLoopMeta, backfillAllMounts, ensureWorkspaceDirs, provisionUserPersonal, importPersonalFromRepo, isPersonalFresh, refreshLoopSandbox, inspectPersonalDirty, syncPersonalToRemote, deletePersonalVault, pullPersonalFromRemote, pushPersonalToRemote } from "./loops"
import {
  initChat,
  listChannels,
  createChannel,
  deleteChannel,
  getOrCreateDm,
  getConv,
  userCanAccess,
  listConversationsForUser,
  listMessages,
  listThread,
  postMessage,
  markRead,
  snapshotThreadToJsonl,
} from "./chat"
import { loopContextChatDir } from "./paths"
import { join as pathJoin } from "node:path"
import { ensurePersonalKeypair, getPublicKey } from "./personal-keys"
// `destroySession` here clashes with auth's session-token destroyer; alias to
// keep both callable without import-order-dependent shadowing.
import { getSession, destroySession as destroyLoopSession } from "./session"
import { listDir, readWorkdirFile, writeWorkdirFile, deleteWorkdirFile, createWorkdirFolder } from "./files"
import { vaultList, vaultFlatList, vaultRead, vaultWrite, vaultCreateFile, vaultCreateFolder, vaultDelete, vaultBacklinks, listRepos, readRepoDetail, listFocuses, readFocus, writeFocus, listTopics, type VaultId } from "./workspace"
import { commitSandboxChange, deleteSandbox, getSandboxVersion, isValidSandboxFile, isValidSandboxName, listSandboxes, lockSandbox, readSandboxFile, writeSandboxFile } from "./sandboxes"
import { attachTerm, detachTerm, writeTerm, resizeTerm, killTerm } from "./term"
import {
  LOOPAT_HOME,
  WORKSPACE,
  loopContextKnowledge,
  loopContextNotes,
  loopContextPersonal,
  loopContextRepos,
  loopWorkdir,
  loopHistoryPath,
} from "./paths"
import { loadConfig, loadPersonalConfig, savePersonalConfig, saveWorkspaceConfig, loadTokenUsage, getActiveProvider, type ProviderConfig } from "./config"
import { listKanbanColumns, addCard, toggleCard, deleteCard, moveCard, updateCardMeta, updateCardBlock, reorderCards, createColumn, deleteColumn, readKanbanConfig, saveColumnOrder, setColumnColor, renameColumn, assignDriverForCard, createLoopFromCard, linkLoopToCard } from "./kanban"
import { printBootstrapBanner } from "./bootstrap"
import {
  createUser,
  findUser,
  setPersonalRepo,
  verifyPassword,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  getRequestUserId,
  requireAuth,
  requireAdmin,
  COOKIE_NAME,
  isValidUsername,
  listUsers,
  activateUser,
  setUserRole,
  deleteUser,
} from "./auth"
import { getCookie } from "hono/cookie"

const execFileP = promisify(execFile)

const { upgradeWebSocket, websocket } = createBunWebSocket()

// ── Kanban real-time hub ──

type KanbanSubscriber = { ws: any; userId: string }
const kanbanSubscribers = new Set<KanbanSubscriber>()

function kanbanBroadcast(msg: object) {
  const payload = JSON.stringify(msg)
  for (const sub of kanbanSubscribers) {
    try { sub.ws.send(payload) } catch {}
  }
}

function kanbanNotify() {
  kanbanBroadcast({ type: "kanban_update" })
}

type Variables = { userId: string }
const app = new Hono<{ Variables: Variables }>()

app.use("/api/*", cors({ origin: (o) => o ?? "*", credentials: true }))

// public routes
app.get("/api/health", (c) => c.json({ ok: true, loopatHome: LOOPAT_HOME, workspace: WORKSPACE }))

app.get("/api/version", (c) => {
  let branch = "unknown", commit = "unknown"
  try { branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim() } catch {}
  try { commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim() } catch {}
  return c.json({ branch, commit })
})

// ── workspace serve config ──

function getLocalIp(): string {
  const nets = networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (!net.internal && net.family === "IPv4") return net.address
    }
  }
  return "127.0.0.1"
}

app.get("/api/serve/domain", requireAdmin, async (c) => {
  const cfg = await loadConfig()
  const domain = cfg.serveDomain ?? "nip.io"
  const ip = getLocalIp()
  const isNip = domain === "nip.io"
  return c.json({
    domain,
    ip,
    baseUrl: isNip ? `.${ip}.${domain}` : `.${domain}`,
    withPort: cfg.serveWithPort ?? false,
    https: cfg.serveHttps ?? false,
    displayPort: cfg.serveDisplayPort ?? 7788,
  })
})

app.put("/api/serve/domain", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const patch: Record<string, unknown> = {}
  if (typeof body.domain === "string" && body.domain.trim()) patch.serveDomain = body.domain.trim()
  if (typeof body.withPort === "boolean") patch.serveWithPort = body.withPort
  if (typeof body.https === "boolean") patch.serveHttps = body.https
  if (typeof body.displayPort === "number") patch.serveDisplayPort = body.displayPort
  if (Object.keys(patch).length === 0) return c.json({ error: "no fields to update" }, 400)
  await saveWorkspaceConfig(patch)
  return c.json({ ok: true })
})

app.get("/api/serve/alias-check", requireAuth, async (c) => {
  const alias = (c.req.query("alias") ?? "").trim().toLowerCase()
  const loopId = (c.req.query("loopId") ?? "").trim()
  if (!alias) return c.json({ available: false, reason: "alias required" })
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(alias)) {
    return c.json({ available: false, reason: "Only lowercase letters, numbers, and hyphens allowed" })
  }
  const allLoops = await listLoops()
  for (const loop of allLoops) {
    if (loop.id === loopId) continue
    if (loop.id.slice(0, 8) === alias || loop.shareAlias === alias) {
      return c.json({ available: false, reason: "Already in use" })
    }
  }
  return c.json({ available: true })
})

// ── providers (auth required) ──
// Merges personal + workspace configs. Personal providers take precedence
// (they carry per-user apiKeys via secrets/). Source field indicates origin.
app.get("/api/providers", requireAuth, async (c) => {
  const wCfg = await loadConfig()
  const providers: Record<string, { model: string; baseUrl: string; source: "personal" | "workspace" }> = {}
  if (wCfg.providers) {
    for (const [name, p] of Object.entries(wCfg.providers)) {
      providers[name] = { model: p.model, baseUrl: p.baseUrl, source: "workspace" }
    }
  }
  // Overlay personal providers (they take precedence)
  let active = wCfg.default ?? ""
  const userId = c.get("userId") as string
  try {
    const pCfg = await loadPersonalConfig(userId)
    for (const [name, p] of Object.entries(pCfg.providers)) {
      providers[name] = { model: p.model, baseUrl: p.baseUrl, source: "personal" }
    }
    active = pCfg.default || active
  } catch {}
  return c.json({ providers, default: active })
})

// ── auth (public) ──
app.post("/api/auth/register", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : ""
  const password = typeof body.password === "string" ? body.password : ""
  const personalRepo = typeof body.personalRepo === "string" && body.personalRepo.trim()
    ? body.personalRepo.trim()
    : undefined
  if (!isValidUsername(username)) return c.json({ error: "invalid username" }, 400)
  if (!password) return c.json({ error: "password required" }, 400)
  try {
    const user = await createUser({ id: username, password, personalRepo })
    // Scaffold personal/<user>/ (empty git init + memory stub) and generate a
    // loopat-managed deploy keypair. NO clone here — server has no creds to
    // pull a private repo. The UI shows publicKey + asks user to register it
    // as a deploy key on `personalRepo`, then calls /api/personal/import.
    const { publicKey } = await provisionUserPersonal(user.id)
    // Only auto-login active accounts (the first-ever user). Pending accounts
    // must wait for an admin to activate before they can log in.
    if (user.status === "active") {
      const token = createSession(user.id)
      setSessionCookie(c, token)
    }
    return c.json({
      user: { id: user.id, role: user.role, status: user.status },
      publicKey,
      personalRepo: user.personalRepo ?? null,
      needsImport: user.status === "active" && !!user.personalRepo && !!publicKey,
    })
  } catch (e: any) {
    return c.json({ error: e?.message ?? "register failed" }, 400)
  }
})

app.post("/api/auth/login", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : ""
  const password = typeof body.password === "string" ? body.password : ""
  if (!username || !password) return c.json({ error: "username + password required" }, 400)
  const user = await findUser(username)
  if (!user) return c.json({ error: "invalid credentials" }, 401)
  const ok = await verifyPassword(password, user.salt, user.hash)
  if (!ok) return c.json({ error: "invalid credentials" }, 401)
  if (user.status !== "active") {
    return c.json({ error: "account pending activation by an admin", status: user.status }, 403)
  }
  const token = createSession(user.id)
  setSessionCookie(c, token)
  return c.json({ user: { id: user.id, role: user.role, status: user.status } })
})

app.post("/api/auth/logout", async (c) => {
  const token = getCookie(c, COOKIE_NAME)
  if (token) destroySession(token)
  clearSessionCookie(c)
  return c.json({ ok: true })
})

app.get("/api/auth/me", async (c) => {
  const userId = getRequestUserId(c)
  if (!userId) return c.json({ error: "unauthorized" }, 401)
  const user = await findUser(userId)
  if (!user) return c.json({ error: "unauthorized" }, 401)
  return c.json({ user: { id: user.id, role: user.role, status: user.status } })
})

// ── admin (requireAdmin) ──

app.get("/api/admin/users", requireAdmin, async (c) => {
  const users = await listUsers()
  return c.json({ users })
})

app.post("/api/admin/users/:id/activate", requireAdmin, async (c) => {
  const id = c.req.param("id") ?? ""
  const updated = await activateUser(id)
  if (!updated) return c.json({ error: "not found" }, 404)
  return c.json({ user: { id: updated.id, role: updated.role, status: updated.status } })
})

app.post("/api/admin/users/:id/role", requireAdmin, async (c) => {
  const id = c.req.param("id") ?? ""
  const body = await c.req.json().catch(() => ({}))
  const role = body.role
  if (role !== "admin" && role !== "member") return c.json({ error: "role must be admin or member" }, 400)
  try {
    const updated = await setUserRole(id, role)
    if (!updated) return c.json({ error: "not found" }, 404)
    return c.json({ user: { id: updated.id, role: updated.role, status: updated.status } })
  } catch (e: any) {
    return c.json({ error: e?.message ?? "role change failed" }, 400)
  }
})

app.delete("/api/admin/users/:id", requireAdmin, async (c) => {
  const id = c.req.param("id") ?? ""
  const me = c.get("userId") as string
  if (id === me) return c.json({ error: "cannot delete yourself" }, 400)
  try {
    const ok = await deleteUser(id)
    if (!ok) return c.json({ error: "not found" }, 404)
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e?.message ?? "delete failed" }, 400)
  }
})

// ── settings (auth required) ──

app.get("/api/settings/personal", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const cfg = await loadPersonalConfig(userId)
  // Recompute token usage from persisted message histories (modelUsage in result messages)
  const tokenUsage = await recomputeTokenUsage(userId)
  const providers: Record<string, { model: string; baseUrl: string; hasKey: boolean; maxContextTokens?: number }> = {}
  for (const [name, p] of Object.entries(cfg.providers)) {
    providers[name] = {
      model: p.model,
      baseUrl: p.baseUrl,
      hasKey: !!p.apiKey,
      ...(p.maxContextTokens ? { maxContextTokens: p.maxContextTokens } : {}),
    }
  }
  return c.json({
    providers,
    default: cfg.default,
    tokenUsage,
  })
})

app.put("/api/settings/personal", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const body = await c.req.json().catch(() => ({}))
  try {
    await savePersonalConfig(userId, {
      default: typeof body.default === "string" ? body.default : undefined,
      providers: body.providers,
    })
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e?.message ?? "save failed" }, 500)
  }
})

app.get("/api/settings/workspace", requireAuth, async (c) => {
  const cfg = await loadConfig()
  const providers: Record<string, { model: string; baseUrl: string; hasKey: boolean }> = {}
  if (cfg.providers) {
    for (const [name, p] of Object.entries(cfg.providers)) {
      providers[name] = { model: p.model, baseUrl: p.baseUrl, hasKey: !!(p as any).apiKey }
    }
  }
  const tokenUsage = await recomputeWorkspaceTokenUsage()
  return c.json({
    providers,
    default: cfg.default ?? "",
    tokenUsage,
  })
})

app.put("/api/settings/workspace", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  try {
    await saveWorkspaceConfig({
      providers: body.providers,
      default: typeof body.default === "string" ? body.default : undefined,
    })
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e?.message ?? "save failed" }, 500)
  }
})

app.get("/api/settings/token-usage/daily", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const daily = await recomputeDailyTokenUsage(userId)
  return c.json(daily)
})

// ── token usage recompute helpers ──

import { readFile } from "node:fs/promises"

async function recomputeTokenUsage(userId: string): Promise<Record<string, { inputTokens: number; outputTokens: number }>> {
  const usage: Record<string, { inputTokens: number; outputTokens: number }> = {}
  try {
    const allLoops = await listLoops()
    const userLoops = allLoops.filter((l) => l.createdBy === userId)
    for (const loop of userLoops) {
      const hp = loopHistoryPath(loop.id)
      if (!existsSync(hp)) continue
      let raw: string
      try { raw = await readFile(hp, "utf8") } catch { continue }
      for (const line of raw.split("\n")) {
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.type === "result" && msg.modelUsage) {
            for (const [model, u] of Object.entries(msg.modelUsage)) {
              const mu = u as any
              const entry = usage[model] ?? { inputTokens: 0, outputTokens: 0 }
              entry.inputTokens += mu.inputTokens ?? 0
              entry.outputTokens += mu.outputTokens ?? 0
              usage[model] = entry
            }
          }
        } catch {}
      }
    }
  } catch {}
  return usage
}

async function recomputeWorkspaceTokenUsage(): Promise<Record<string, { inputTokens: number; outputTokens: number }>> {
  const usage: Record<string, { inputTokens: number; outputTokens: number }> = {}
  try {
    const allLoops = await listLoops()
    for (const loop of allLoops) {
      const hp = loopHistoryPath(loop.id)
      if (!existsSync(hp)) continue
      let raw: string
      try { raw = await readFile(hp, "utf8") } catch { continue }
      for (const line of raw.split("\n")) {
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.type === "result" && msg.modelUsage) {
            for (const [model, u] of Object.entries(msg.modelUsage)) {
              const mu = u as any
              const entry = usage[model] ?? { inputTokens: 0, outputTokens: 0 }
              entry.inputTokens += mu.inputTokens ?? 0
              entry.outputTokens += mu.outputTokens ?? 0
              usage[model] = entry
            }
          }
        } catch {}
      }
    }
  } catch {}
  return usage
}

async function recomputeDailyTokenUsage(userId: string): Promise<Record<string, Record<string, { inputTokens: number; outputTokens: number }>>> {
  // daily[model][date] = { inputTokens, outputTokens }
  const daily: Record<string, Record<string, { inputTokens: number; outputTokens: number }>> = {}
  try {
    const allLoops = await listLoops()
    const userLoops = allLoops.filter((l) => l.createdBy === userId)
    for (const loop of userLoops) {
      const hp = loopHistoryPath(loop.id)
      if (!existsSync(hp)) continue
      let raw: string
      try { raw = await readFile(hp, "utf8") } catch { continue }
      // Fallback date for historical messages without _ts: loop creation date
      const fallbackDate = (loop.createdAt ?? new Date().toISOString()).slice(0, 10)
      let currentDate = fallbackDate
      for (const line of raw.split("\n")) {
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          // Track date: explicit _ts wins, clear-boundary ts updates the sliding window
          if (msg.type === "clear-boundary" && typeof msg.ts === "string") {
            currentDate = msg.ts.slice(0, 10)
          }
          const ts = typeof msg._ts === "string" ? msg._ts : null
          const date = ts ? ts.slice(0, 10) : currentDate
          if (msg.type === "result" && msg.modelUsage) {
            for (const [model, u] of Object.entries(msg.modelUsage)) {
              const mu = u as any
              daily[model] ??= {}
              const entry = daily[model][date] ?? { inputTokens: 0, outputTokens: 0 }
              entry.inputTokens += mu.inputTokens ?? 0
              entry.outputTokens += mu.outputTokens ?? 0
              daily[model][date] = entry
            }
          }
        } catch {}
      }
    }
  } catch {}
  return daily
}

// ── personal repo bootstrap (deploy-key flow) ──
//
// Two-step:
//   1. POST /api/auth/register  → user created, personal/<id>/ scaffolded with
//      `git init` + ed25519 deploy keypair. Response carries `publicKey`.
//   2. User registers publicKey as a deploy key (write access) on their
//      personalRepo, then calls POST /api/personal/import to clone the repo
//      using the managed private key. Cloned content replaces the empty
//      scaffold; the keypair is preserved.
//
// GET /api/personal/status reports current state so the UI can render
// "needs import" banner + retry button.

app.get("/api/personal/status", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const user = await findUser(userId)
  if (!user) return c.json({ error: "user missing" }, 500)
  // If the user never went through register-with-personalRepo (or ssh-keygen
  // was unavailable then), the keypair may be missing — try once now so this
  // endpoint can serve as the lazy-init for the deploy-key flow.
  let publicKey = await getPublicKey(userId)
  if (!publicKey) {
    const r = await ensurePersonalKeypair(userId)
    publicKey = r.publicKey
  }
  const imported = !(await isPersonalFresh(userId))
  return c.json({
    userId,
    personalRepo: user.personalRepo ?? null,
    publicKey,
    imported,
  })
})

// Export the user's git-crypt key (base64). Behind a fresh password check
// to prevent walk-up attacks on an unattended browser. The key decrypts
// .loopat/vaults/** on any host that holds it, so we don't want a stolen
// session cookie to be enough to lift it.
app.post("/api/personal/crypt-key", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const body = await c.req.json().catch(() => ({}))
  const password = typeof body.password === "string" ? body.password : ""
  if (!password) return c.json({ error: "password required" }, 400)
  const user = await findUser(userId)
  if (!user) return c.json({ error: "user missing" }, 500)
  const ok = await verifyPassword(password, user.salt, user.hash)
  if (!ok) return c.json({ error: "wrong password" }, 403)
  const { gitCryptKeyExists, getGitCryptKey } = await import("./git-crypt-key")
  if (!(await gitCryptKeyExists(userId))) {
    return c.json({ error: "no crypt key on this host" }, 404)
  }
  try {
    const buf = await getGitCryptKey(userId)
    return c.json({ cryptKey: buf.toString("base64") })
  } catch (e: any) {
    return c.json({ error: `failed to read key: ${e?.message ?? e}` }, 500)
  }
})

app.post("/api/personal/import", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const user = await findUser(userId)
  if (!user) return c.json({ error: "user missing" }, 500)
  const body = await c.req.json().catch(() => ({}))
  const provided = typeof body.repoUrl === "string" && body.repoUrl.trim() ? body.repoUrl.trim() : ""
  const repoUrl = provided || user.personalRepo
  if (!repoUrl) return c.json({ error: "no personalRepo on file and none provided" }, 400)
  const cryptKey = typeof body.cryptKey === "string" && body.cryptKey.trim() ? body.cryptKey.trim() : undefined
  // If the user typed a fresh URL (had none on file, or changed it), persist
  // before attempting clone — keeps users.json + personal/ consistent.
  if (provided && provided !== user.personalRepo) {
    await setPersonalRepo(userId, provided)
  }
  const r = await importPersonalFromRepo(userId, repoUrl, cryptKey)
  if (!r.ok) {
    // 422 = data condition prevents proceeding (secrets leaked — user must
    // fix locally first, no amount of input here helps).
    if (r.secretsExposed) {
      return c.json({ error: r.error, secretsExposed: true, exposedFiles: r.exposedFiles ?? [] }, 422)
    }
    // 422 = repo isn't a clean slate; user must point at a fresh repo or use
    // Recovery (BYOK). UI surfaces the Recovery hint in this case.
    if (r.notClean) {
      return c.json({ error: r.error, notClean: true }, 422)
    }
    if (r.needsCryptKey) return c.json({ error: r.error, needsCryptKey: true }, 409)
    return c.json({ error: r.error }, 400)
  }
  // On auto-init, `cryptKey` is returned exactly once for the user to back
  // up. Subsequent /api/personal/status calls do NOT expose it.
  return c.json({ ok: true, autoInitialized: !!r.autoInitialized, cryptKey: r.cryptKey ?? null })
})

// Destroy personal/<user>/ AND the saved git-crypt key. Two-step from the
// client's POV: first call (no `force`) verifies the password, inspects the
// repo, attempts a sync if dirty, and either deletes (clean / sync ok) or
// returns 409 with a data-loss preview. Second call (force=true, same
// password) skips the sync and just deletes.
app.post("/api/personal/delete", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const body = await c.req.json().catch(() => ({}))
  const password = typeof body.password === "string" ? body.password : ""
  const force = body.force === true
  if (!password) return c.json({ error: "password required" }, 400)
  const user = await findUser(userId)
  if (!user) return c.json({ error: "user missing" }, 500)
  const ok = await verifyPassword(password, user.salt, user.hash)
  if (!ok) return c.json({ error: "wrong password" }, 403)

  const status = await inspectPersonalDirty(userId)
  const dirty = status.uncommitted > 0 || status.unpushed > 0

  if (!force && dirty) {
    // Try to sync first. If it works, we can delete with no data loss.
    const sync = await syncPersonalToRemote(userId)
    if (!sync.ok) {
      return c.json(
        {
          error: "personal/ has unsynced changes and sync failed",
          syncFailed: true,
          syncError: sync.error,
          uncommitted: status.uncommitted,
          unpushed: status.unpushed,
          hasRemote: status.hasRemote,
        },
        409,
      )
    }
  }

  const del = await deletePersonalVault(userId)
  if (!del.ok) return c.json({ error: del.error }, 500)
  return c.json({
    ok: true,
    synced: !force && dirty,
    dataLost: force && dirty,
  })
})

// Pull from remote. Stashes local changes, fetches, merges, then pops stash.
app.post("/api/personal/pull", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const r = await pullPersonalFromRemote(userId)
  if (!r.ok) {
    const status: Record<string, unknown> = { error: r.error }
    if (r.conflicts) status.conflicts = r.conflicts
    if (r.needsStash) status.needsStash = true
    return c.json(status, r.conflicts ? 409 : 400)
  }
  return c.json({ ok: true, message: r.message })
})

// Push to remote. Stages, commits, and pushes.
app.post("/api/personal/push", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const r = await pushPersonalToRemote(userId)
  if (!r.ok) {
    return c.json({ error: r.error, needsPull: r.needsPull }, r.needsPull ? 409 : 400)
  }
  return c.json({ ok: true, message: r.message })
})

// All /api/* routes below require auth, EXCEPT the two endpoints used by the
// public share view (GET /api/loops/:id and WS /ws/loop/:id), which allow
// anonymous read iff meta.public === true. There is no anonymous workspace
// access at all.

app.get("/api/loops", requireAuth, async (c) => {
  // ?archived=true → only archived; ?archived=all → both; default → hide archived
  const filter = c.req.query("archived") ?? ""
  const all = await listLoops()
  let loops = all
  if (filter === "true") loops = all.filter((m) => m.archived === true)
  else if (filter === "all") loops = all
  else loops = all.filter((m) => m.archived !== true)
  return c.json({ loops })
})

// List vaults this user has on disk. Each entry is the name a loop can put
// in `meta.config.vault` to bind that vault's contents into the sandbox.
// When the user hasn't created any vaults yet, the legacy `secrets/` dir
// shows up as the implicit "default" vault.
app.get("/api/vaults", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const { listVaults } = await import("./vaults")
  return c.json({ vaults: listVaults(userId) })
})

app.post("/api/loops", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const body = await c.req.json().catch(() => ({}))
  const title = typeof body.title === "string" ? body.title : "untitled"
  const repo = typeof body.repo === "string" && body.repo.trim() ? body.repo.trim() : undefined
  const sandbox = typeof body.sandbox === "string" && body.sandbox.trim() ? body.sandbox.trim() : undefined
  const vault = typeof body.vault === "string" && body.vault.trim() ? body.vault.trim() : undefined
  try {
    const meta = await createLoop({ title, repo, createdBy: userId, sandbox, vault })
    return c.json(meta)
  } catch (e: any) {
    return c.json({ error: e?.message ?? "create failed" }, 400)
  }
})

app.post("/api/loops/:id/viewed", requireAuth, async (c) => {
  const id = c.req.param("id")
  markLoopViewed(id)
  // Broadcast immediately so UI updates without refresh
  const entry = getLoopStatus()[id]
  if (entry) {
    const update = { [id]: entry }
    for (const [ws, ids] of statusWatchers) {
      if (ids.has(id)) {
        try { ws.send(JSON.stringify({ type: "update", data: update })) } catch {}
      }
    }
  }
  return c.json({ ok: true })
})

// Public-or-auth: anonymous visitors get meta only when the loop is public.
app.get("/api/loops/:id", async (c) => {
  const id = c.req.param("id") ?? ""
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "not found" }, 404)
  if (!meta.public && !getRequestUserId(c)) {
    return c.json({ error: "unauthorized" }, 401)
  }
  return c.json(meta)
})

// Archive / unarchive. Only the loop owner (createdBy) may flip the flag.
app.patch("/api/loops/:id", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  const userId = c.get("userId") as string
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "not found" }, 404)
  if (meta.createdBy !== userId) return c.json({ error: "forbidden" }, 403)
  const body = await c.req.json().catch(() => ({}))
  const patch: Partial<typeof meta> = {}
  if (typeof body.archived === "boolean") {
    patch.archived = body.archived
    patch.archivedAt = body.archived ? new Date().toISOString() : undefined
  }
  if (typeof body.public === "boolean") {
    patch.public = body.public
    patch.publicAt = body.public ? new Date().toISOString() : undefined
  }
  // Share config fields
  if (typeof body.shareEnabled === "boolean") patch.shareEnabled = body.shareEnabled
  if (body.shareMode === "static" || body.shareMode === "port") patch.shareMode = body.shareMode
  if (typeof body.shareAlias === "string") patch.shareAlias = body.shareAlias.trim() || undefined
  if (typeof body.sharePort === "number") patch.sharePort = body.sharePort
  if (Object.keys(patch).length === 0) return c.json({ error: "no allowed fields" }, 400)
  const updated = await patchLoopMeta(id, patch)
  // On archive: tear down the Claude SDK process and terminal PTY so no
  // orphaned processes linger. Un-archive is fine — next connect re-spawns.
  if (body.archived === true) {
    destroyLoopSession(id)
    killTerm(id)
  }
  return c.json(updated)
})

// Strip thinking blocks from the SDK jsonl history (used before switching
// to a provider that can't validate the existing thinking signatures).
app.post("/api/loops/:id/strip-thinking", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  const userId = c.get("userId") as string
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "not found" }, 404)
  if (meta.createdBy !== userId) return c.json({ error: "forbidden" }, 403)
  if (meta.archived) return c.json({ error: "loop is archived (read-only)" }, 409)
  const session = getSession(id)
  const r = await session.stripThinkingBlocks()
  return c.json(r)
})

app.get("/api/loops/:id/context", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  if (!(await loopExists(id))) return c.json({ error: "not found" }, 404)
  const mounts: { name: string; path: string }[] = []
  if (existsSync(loopContextKnowledge(id))) mounts.push({ name: "knowledge", path: "context/knowledge" })
  if (existsSync(loopContextNotes(id))) mounts.push({ name: "notes", path: "context/notes" })
  if (existsSync(loopContextPersonal(id))) mounts.push({ name: "personal", path: "context/personal" })
  if (existsSync(loopContextRepos(id))) mounts.push({ name: "repos", path: "context/repos" })
  return c.json({ mounts })
})

// Loop's active sandbox + version comparison. UI uses catalogVersion vs
// loopVersion to surface "update available". Null sandbox = no sandbox set.
app.get("/api/loops/:id/sandbox", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "not found" }, 404)
  const name = meta.config?.sandbox
  if (!name) return c.json({ name: null })
  const loopVersion = meta.config?.sandbox_version ?? null
  const catalogVersion = await getSandboxVersion(name)
  return c.json({ name, loopVersion, catalogVersion })
})

// Refresh: re-copy catalog sandbox into this loop, then tear down SDK session
// and PTY so next reconnect picks up the new lockfile.
app.post("/api/loops/:id/sandbox/refresh", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "not found" }, 404)
  if (meta.archived) return c.json({ error: "loop is archived" }, 403)
  if (!meta.config?.sandbox) return c.json({ error: "loop has no sandbox" }, 400)
  try {
    const version = await refreshLoopSandbox(id)
    // Existing bwrap argv (PATH, mise data dir bind) is baked at spawn time —
    // forced respawn is how the new lockfile takes effect.
    destroyLoopSession(id)
    killTerm(id)
    return c.json({ ok: true, version })
  } catch (e: any) {
    return c.json({ error: e?.message ?? "refresh failed" }, 500)
  }
})

app.get("/api/loops/:id/files", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  if (!(await loopExists(id))) return c.json({ error: "not found" }, 404)
  const path = c.req.query("path") ?? ""
  return c.json({ entries: await listDir(id, path) })
})

app.get("/api/loops/:id/file", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  if (!(await loopExists(id))) return c.json({ error: "not found" }, 404)
  const path = c.req.query("path") ?? ""
  if (!path) return c.json({ error: "path required" }, 400)
  const r = await readWorkdirFile(id, path)
  if (!r) return c.json({ error: "not a file or unreadable" }, 404)
  return c.json(r)
})

app.put("/api/loops/:id/file", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "not found" }, 404)
  if (meta.archived) return c.json({ error: "loop is archived (read-only)" }, 409)
  const path = c.req.query("path") ?? ""
  if (!path) return c.json({ error: "path required" }, 400)
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.content !== "string") return c.json({ error: "content required" }, 400)
  const ok = await writeWorkdirFile(id, path, body.content)
  if (!ok) return c.json({ error: "write failed" }, 500)
  return c.json({ ok: true })
})

app.post("/api/loops/:id/upload", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "not found" }, 404)
  if (meta.archived) return c.json({ error: "loop is archived (read-only)" }, 409)
  const formData = await c.req.formData()
  const file = formData.get("file")
  if (!(file instanceof File)) return c.json({ error: "file required" }, 400)
  const dir = loopWorkdir(id)
  const filePath = join(dir, file.name)
  try {
    const buf = await file.arrayBuffer()
    await Bun.write(filePath, new Uint8Array(buf))
    return c.json({ ok: true, path: file.name })
  } catch (e: any) {
    return c.json({ error: e?.message ?? "upload failed" }, 500)
  }
})

app.delete("/api/loops/:id/file", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "not found" }, 404)
  if (meta.archived) return c.json({ error: "loop is archived (read-only)" }, 409)
  const path = c.req.query("path") ?? ""
  if (!path) return c.json({ error: "path required" }, 400)
  const ok = await deleteWorkdirFile(id, path)
  if (!ok) return c.json({ error: "delete failed" }, 500)
  return c.json({ ok: true })
})

app.post("/api/loops/:id/folder", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "not found" }, 404)
  if (meta.archived) return c.json({ error: "loop is archived (read-only)" }, 409)
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.path !== "string" || !body.path) return c.json({ error: "path required" }, 400)
  const ok = await createWorkdirFolder(id, body.path)
  if (!ok) return c.json({ error: "mkdir failed" }, 500)
  return c.json({ ok: true })
})

// ── git operations (workdir) ──

type GitFileInfo = {
  path: string
  status: "A" | "M" | "D" | "R" | "?"
  additions: number
  deletions: number
  isBinary: boolean
}

type GitCommit = {
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

async function getGitStatus(loopId: string): Promise<{ unstaged: GitFileInfo[]; staged: GitFileInfo[] }> {
  const dir = loopWorkdir(loopId)
  if (!existsSync(join(dir, ".git"))) return { unstaged: [], staged: [] }

  const execOpts = { encoding: "utf8" as const, timeout: 10_000 }
  const unstaged: GitFileInfo[] = []
  const staged: GitFileInfo[] = []

  // Parse git status --porcelain for file statuses
  let porcelain = ""
  try {
    porcelain = (await execFileP("git", ["-C", dir, "status", "--porcelain"], execOpts)).stdout.trim()
  } catch { return { unstaged: [], staged: [] } }

  // Get numstat for unstaged and staged changes
  let unstagedNumstat = ""
  let stagedNumstat = ""
  try { unstagedNumstat = (await execFileP("git", ["-C", dir, "diff", "--numstat"], execOpts)).stdout.trim() } catch {}
  try { stagedNumstat = (await execFileP("git", ["-C", dir, "diff", "--cached", "--numstat"], execOpts)).stdout.trim() } catch {}

  // Parse numstat into map: path -> { additions, deletions, isBinary }
  const numstatMap = new Map<string, { additions: number; deletions: number; isBinary: boolean }>()
  for (const line of [...stagedNumstat.split("\n"), ...unstagedNumstat.split("\n")]) {
    const parts = line.split("\t")
    if (parts.length < 3) continue
    const adds = parseInt(parts[0], 10)
    const dels = parseInt(parts[1], 10)
    const isBinary = isNaN(adds) || isNaN(dels)
    const p = parts[2]
    // Only set if not already present or if the new one has more info
    if (!numstatMap.has(p) || (!isBinary && numstatMap.get(p)!.isBinary)) {
      numstatMap.set(p, { additions: isNaN(adds) ? 0 : adds, deletions: isNaN(dels) ? 0 : dels, isBinary })
    }
  }

  for (const line of porcelain.split("\n")) {
    if (!line || line.length < 4) continue
    const xy = line.slice(0, 2)
    // Robust path extraction: skip 2-char status, then trim leading whitespace
    // Handles both ` M README.md` and `?? hello.html` formats reliably
    let rest = line.slice(2).trimStart()
    if (!rest) continue
    // git quotes paths containing spaces/special chars: ` M "my file.txt"`
    if (rest.startsWith('"') && rest.endsWith('"')) {
      rest = rest.slice(1, -1)
    }
    // Handle renamed files: `R  old.txt -> new.txt` — take the new name after `-> `
    if (xy[0] === 'R' || xy[1] === 'R') {
      const arrowIdx = rest.indexOf(' -> ')
      if (arrowIdx >= 0) rest = rest.slice(arrowIdx + 4)
    }
    const p = rest

    const stat = numstatMap.get(p) ?? { additions: 0, deletions: 0, isBinary: false }

    // Index status (staged)
    if (xy[0] !== " " && xy[0] !== "?") {
      const code = xy[0] as GitFileInfo["status"]
      staged.push({ path: p, status: code, ...stat })
    }
    // Worktree status (unstaged)
    if (xy[1] !== " " && xy[1] !== "!") {
      const code = xy[1] === "?" ? "?" : xy[1] as GitFileInfo["status"]
      unstaged.push({ path: p, status: code, ...stat })
    }
  }

  return { unstaged, staged }
}

app.get("/api/loops/:id/git-status", async (c) => {
  const id = c.req.param("id") ?? ""
  if (!(await loopExists(id))) return c.json({ error: "not found" }, 404)
  return c.json(await getGitStatus(id))
})

app.get("/api/loops/:id/git-diff", async (c) => {
  const id = c.req.param("id") ?? ""
  if (!(await loopExists(id))) return c.json({ error: "not found" }, 404)
  const path = c.req.query("path") ?? ""
  if (!path) return c.json({ error: "path required" }, 400)
  const staged = c.req.query("staged") === "1"
  const dir = loopWorkdir(id)
  if (!existsSync(join(dir, ".git"))) return c.json({ error: "not a git repo" }, 400)
  try {
    const args = ["-C", dir, "diff", "--", path]
    if (staged) args.splice(3, 0, "--cached")
    let diff = (await execFileP("git", args, { encoding: "utf8", timeout: 10_000 })).stdout.trim()
    // Untracked files have nothing in the index to diff against — fall back to
    // --no-index /dev/null to show the full file content as additions.
    if (!diff && !staged) {
      diff = (await execFileP("git", ["-C", dir, "diff", "--no-index", "/dev/null", path], { encoding: "utf8", timeout: 10_000 })).stdout.trim()
    }
    return c.json({ diff })
  } catch (e: any) {
    return c.json({ error: e?.message ?? "diff failed" }, 500)
  }
})

app.post("/api/loops/:id/git-stage", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  if (!(await loopExists(id))) return c.json({ error: "not found" }, 404)
  const body = await c.req.json().catch(() => ({}))
  const files: string[] = Array.isArray(body.files) ? body.files : []
  const unstage = body.unstage === true
  if (files.length === 0) return c.json({ error: "files required" }, 400)
  const dir = loopWorkdir(id)
  if (!existsSync(join(dir, ".git"))) return c.json({ error: "not a git repo" }, 400)
  try {
    const args = unstage ? ["-C", dir, "reset", "HEAD", "--", ...files] : ["-C", dir, "add", "--", ...files]
    await execFileP("git", args, { encoding: "utf8", timeout: 10_000 })
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e?.message ?? "stage failed" }, 500)
  }
})

app.post("/api/loops/:id/git-commit", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  if (!(await loopExists(id))) return c.json({ error: "not found" }, 404)
  const body = await c.req.json().catch(() => ({}))
  const message = typeof body.message === "string" && body.message.trim() ? body.message.trim() : ""
  if (!message) return c.json({ error: "commit message required" }, 400)
  const dir = loopWorkdir(id)
  if (!existsSync(join(dir, ".git"))) return c.json({ error: "not a git repo" }, 400)
  try {
    await execFileP("git", ["-C", dir, "commit", "-m", message], { encoding: "utf8", timeout: 10_000 })
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e?.message ?? "commit failed" }, 500)
  }
})

app.get("/api/loops/:id/git-log", async (c) => {
  const id = c.req.param("id") ?? ""
  if (!(await loopExists(id))) return c.json({ error: "not found" }, 404)
  const limit = parseInt(c.req.query("limit") ?? "50", 10)
  const dir = loopWorkdir(id)
  if (!existsSync(join(dir, ".git"))) return c.json({ commits: [] })
  try {
    const format = "%H%n%h%n%s%n%an%n%ai%n%P%n%D"
    const raw = (await execFileP("git", ["-C", dir, "log", `--format=${format}`, "-n", String(Math.min(limit, 200))], { encoding: "utf8", timeout: 10_000 })).stdout.trim()
    const commits: GitCommit[] = []
    const lines = raw.split("\n")
    for (let i = 0; i + 6 < lines.length || i < lines.length; i += 7) {
      if (i + 6 >= lines.length) break
      const refs = lines[i + 6]
      const branchMatch = refs.match(/HEAD -> ([^,\]]+)/)
      const branches = refs.split(",").map(s => s.trim()).filter(s => s && !s.startsWith("HEAD") && !s.startsWith("tag:"))
      const tagMatches = refs.match(/tag: ([^,\)]+)/g)
      const tags = tagMatches ? tagMatches.map(t => t.replace("tag: ", "").trim()) : []
      commits.push({
        hash: lines[i],
        shortHash: lines[i + 1],
        subject: lines[i + 2],
        author: lines[i + 3],
        date: lines[i + 4],
        parentHashes: lines[i + 5].split(" ").filter(Boolean),
        branch: branchMatch?.[1] ?? null,
        branches,
        tags,
      })
    }
    return c.json({ commits })
  } catch {
    return c.json({ commits: [] })
  }
})

app.post("/api/loops/:id/git-discard", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  if (!(await loopExists(id))) return c.json({ error: "not found" }, 404)
  const body = await c.req.json().catch(() => ({}))
  const file: string = typeof body.file === "string" ? body.file : ""
  if (!file) return c.json({ error: "file required" }, 400)
  const dir = loopWorkdir(id)
  if (!existsSync(join(dir, ".git"))) return c.json({ error: "not a git repo" }, 400)
  try {
    // First check if the file is tracked. Untracked files can't be
    // checked out — remove them instead.
    const tracked = (await execFileP("git", ["-C", dir, "ls-files", "--error-unmatch", file], { encoding: "utf8", timeout: 5_000 }).catch(() => null)) !== null
    if (tracked) {
      await execFileP("git", ["-C", dir, "checkout", "--", file], { encoding: "utf8", timeout: 10_000 })
    } else {
      await execFileP("rm", ["-f", join(dir, file)], { encoding: "utf8", timeout: 5_000 })
    }
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e?.message ?? "discard failed" }, 500)
  }
})

// Workspace vault APIs (Context tab)
const VAULTS = new Set(["knowledge", "notes", "personal", "repos"])

app.get("/api/workspace/files", requireAuth, async (c) => {
  const vault = c.req.query("vault") ?? ""
  if (!VAULTS.has(vault)) return c.json({ error: "invalid vault" }, 400)
  const userId = c.get("userId") as string
  const path = c.req.query("path") ?? ""
  if (c.req.query("flat") === "1") {
    return c.json({ entries: await vaultFlatList(vault as VaultId, userId) })
  }
  return c.json({ entries: await vaultList(vault as VaultId, path, userId) })
})

app.get("/api/workspace/file", requireAuth, async (c) => {
  const vault = c.req.query("vault") ?? ""
  if (!VAULTS.has(vault)) return c.json({ error: "invalid vault" }, 400)
  const userId = c.get("userId") as string
  const path = c.req.query("path") ?? ""
  if (!path) return c.json({ error: "path required" }, 400)
  const r = await vaultRead(vault as VaultId, path, userId)
  if (!r) return c.json({ error: "not a file" }, 404)
  return c.json(r)
})

app.put("/api/workspace/file", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const vault = c.req.query("vault") ?? ""
  if (!VAULTS.has(vault)) return c.json({ error: "invalid vault" }, 400)
  const path = c.req.query("path") ?? ""
  if (!path) return c.json({ error: "path required" }, 400)
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.content !== "string") return c.json({ error: "content required" }, 400)
  const r = await vaultWrite(vault as VaultId, path, body.content, userId)
  if (!r.ok) return c.json({ error: r.error }, 500)
  return c.json(r)
})

app.post("/api/workspace/file", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const vault = c.req.query("vault") ?? ""
  if (!VAULTS.has(vault)) return c.json({ error: "invalid vault" }, 400)
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.path !== "string" || !body.path) return c.json({ error: "path required" }, 400)
  const r = await vaultCreateFile(vault as VaultId, body.path, userId)
  if (!r.ok) return c.json({ error: r.error }, r.error === "exists" ? 409 : 500)
  return c.json({ ok: true })
})

app.delete("/api/workspace/file", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const vault = c.req.query("vault") ?? ""
  if (!VAULTS.has(vault)) return c.json({ error: "invalid vault" }, 400)
  const path = c.req.query("path") ?? ""
  if (!path) return c.json({ error: "path required" }, 400)
  const r = await vaultDelete(vault as VaultId, path, userId)
  if (!r.ok) return c.json({ error: r.error }, 500)
  return c.json({ ok: true })
})

app.post("/api/workspace/folder", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const vault = c.req.query("vault") ?? ""
  if (!VAULTS.has(vault)) return c.json({ error: "invalid vault" }, 400)
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.path !== "string" || !body.path) return c.json({ error: "path required" }, 400)
  const r = await vaultCreateFolder(vault as VaultId, body.path, userId)
  if (!r.ok) return c.json({ error: r.error }, r.error === "exists" ? 409 : 500)
  return c.json({ ok: true })
})

app.get("/api/workspace/backlinks", requireAuth, async (c) => {
  const vault = c.req.query("vault") ?? ""
  if (!VAULTS.has(vault)) return c.json({ error: "invalid vault" }, 400)
  const userId = c.get("userId") as string
  const path = c.req.query("path") ?? ""
  if (!path) return c.json({ backlinks: [] })
  return c.json({ backlinks: await vaultBacklinks(vault as VaultId, path, userId) })
})

app.get("/api/workspace/repos", requireAuth, async (c) => {
  return c.json({ repos: await listRepos() })
})

app.get("/api/sandboxes", requireAuth, async (c) => {
  return c.json({ sandboxes: await listSandboxes() })
})

// Per-file read/write inside a sandbox dir. `file` defaults to mise.toml (the
// "main" file). Whitelist guards path traversal — only known basenames map
// to actual files inside the sandbox dir.
app.get("/api/sandboxes/:name", requireAuth, async (c) => {
  const name = c.req.param("name") ?? ""
  if (!isValidSandboxName(name)) return c.json({ error: "invalid sandbox name" }, 400)
  const file = c.req.query("file") ?? "mise.toml"
  if (!isValidSandboxFile(file)) return c.json({ error: "invalid file" }, 400)
  const content = await readSandboxFile(name, file)
  if (content === null) return c.json({ error: "not found" }, 404)
  return c.json({ name, file, content })
})

app.put("/api/sandboxes/:name", requireAuth, async (c) => {
  const name = c.req.param("name") ?? ""
  if (!isValidSandboxName(name)) return c.json({ error: "invalid sandbox name" }, 400)
  const file = c.req.query("file") ?? "mise.toml"
  if (!isValidSandboxFile(file)) return c.json({ error: "invalid file" }, 400)
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.content !== "string") return c.json({ error: "content required" }, 400)
  await writeSandboxFile(name, file, body.content)
  // Order: write → lock (mise.toml only) → commit. Lock comes before commit
  // so the commit captures both toml and the regenerated lockfile atomically.
  let lockRes: { ok: boolean; error?: string } | null = null
  if (file === "mise.toml") {
    lockRes = await lockSandbox(name)
  }
  const commitRes = await commitSandboxChange(name, { kind: "update", file })
  return c.json({
    ok: true, name, file,
    ...(lockRes ? { locked: lockRes.ok, lockError: lockRes.error } : {}),
    committed: commitRes.ok, commitSha: commitRes.sha, commitError: commitRes.error,
  })
})

// Remove a sandbox from the catalog. Per-loop snapshots already copied stay
// intact (they're standalone), so deleting "default" doesn't break loops
// that already use it — they keep running off their own sandbox/ dir.
app.delete("/api/sandboxes/:name", requireAuth, async (c) => {
  const name = c.req.param("name") ?? ""
  if (!isValidSandboxName(name)) return c.json({ error: "invalid sandbox name" }, 400)
  await deleteSandbox(name)
  const commitRes = await commitSandboxChange(name, { kind: "delete" })
  return c.json({ ok: true, name, committed: commitRes.ok, commitSha: commitRes.sha, commitError: commitRes.error })
})

app.get("/api/workspace/repo/:name", requireAuth, async (c) => {
  const name = c.req.param("name") ?? ""
  const detail = await readRepoDetail(name)
  if (!detail) return c.json({ error: "not found" }, 404)
  // recent loops on this repo
  const loops = await listLoops()
  const recent = loops.filter((l) => (l as any).repo === name).slice(0, 8)
  return c.json({ ...detail, recentLoops: recent })
})

// ── focus + topics ──
app.get("/api/focus", requireAuth, async (c) => {
  const focuses = await listFocuses()
  return c.json({ focuses })
})

app.get("/api/focus/:name", requireAuth, async (c) => {
  const name = c.req.param("name") ?? ""
  const r = await readFocus(decodeURIComponent(name))
  if (!r) return c.json({ error: "not found" }, 404)
  return c.json({ name, body: r.body, mtimeMs: r.mtimeMs })
})

app.put("/api/focus/:name", requireAuth, async (c) => {
  const name = decodeURIComponent(c.req.param("name") ?? "")
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.body !== "string") return c.json({ error: "body required" }, 400)
  const ok = await writeFocus(name, body.body)
  if (!ok) return c.json({ error: "write failed" }, 500)
  return c.json({ ok: true })
})

// ── kanban: notes/todo/*.md board (one file = one column) ──
app.get("/api/kanban", requireAuth, async (c) => {
  const columns = await listKanbanColumns()
  return c.json({ columns })
})

app.post("/api/kanban/:filename/cards", requireAuth, async (c) => {
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.text !== "string" || !body.text.trim()) {
    return c.json({ error: "text required" }, 400)
  }
  const r = await addCard(filename, body)
  if (!r.ok) return c.json({ error: "add failed" }, 500)
  kanbanNotify()
  return c.json({ cid: r.cid })
})

app.patch("/api/kanban/:filename/cards/:cid/toggle", requireAuth, async (c) => {
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const cid = c.req.param("cid") ?? ""
  const ok = await toggleCard(filename, cid)
  if (!ok) return c.json({ error: "not found" }, 404)
  kanbanNotify()
  return c.json({ ok: true })
})

app.patch("/api/kanban/:filename/cards/:cid", requireAuth, async (c) => {
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const cid = c.req.param("cid") ?? ""
  const patch = await c.req.json().catch(() => ({}))
  const ok = await updateCardMeta(filename, cid, patch)
  if (!ok) return c.json({ error: "not found or patch failed" }, 404)
  kanbanNotify()
  return c.json({ ok: true })
})

app.put("/api/kanban/:filename/cards/:cid/block", requireAuth, async (c) => {
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const cid = c.req.param("cid") ?? ""
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.block !== "string") return c.json({ error: "block required" }, 400)
  const ok = await updateCardBlock(filename, cid, body.block)
  if (!ok) return c.json({ error: "not found" }, 404)
  kanbanNotify()
  return c.json({ ok: true })
})

app.delete("/api/kanban/:filename/cards/:cid", requireAuth, async (c) => {
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const cid = c.req.param("cid") ?? ""
  const ok = await deleteCard(filename, cid)
  if (!ok) return c.json({ error: "not found" }, 404)
  kanbanNotify()
  return c.json({ ok: true })
})

app.post("/api/kanban/:filename/cards/:cid/move", requireAuth, async (c) => {
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const cid = c.req.param("cid") ?? ""
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.toFile !== "string") return c.json({ error: "toFile required" }, 400)
  const ok = await moveCard(filename, cid, body.toFile, body.toIndex)
  if (!ok) return c.json({ error: "move failed" }, 500)
  kanbanNotify()
  return c.json({ ok: true })
})

app.post("/api/kanban/columns", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.filename !== "string" || !body.filename.trim()) {
    return c.json({ error: "filename required" }, 400)
  }
  const ok = await createColumn(body.filename + (body.filename.endsWith(".md") ? "" : ".md"), body.title)
  if (!ok) return c.json({ error: "create failed" }, 500)
  kanbanNotify()
  return c.json({ ok: true })
})

app.get("/api/kanban/config", requireAuth, async (c) => {
  const cfg = await readKanbanConfig()
  return c.json(cfg ?? { columns: [] })
})

app.put("/api/kanban/config", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (Array.isArray(body.columns)) {
    await saveColumnOrder(body.columns)
    kanbanNotify()
  }
  return c.json({ ok: true })
})

app.put("/api/kanban/:filename/rename", requireAuth, async (c) => {
  const fromFile = decodeURIComponent(c.req.param("filename") ?? "")
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.toFile !== "string" || !body.toFile.trim()) {
    return c.json({ error: "toFile required" }, 400)
  }
  const ok = await renameColumn(fromFile, body.toFile + (body.toFile.endsWith(".md") ? "" : ".md"))
  if (!ok) return c.json({ error: "rename failed" }, 500)
  kanbanNotify()
  return c.json({ ok: true })
})

app.delete("/api/kanban/:filename", requireAuth, async (c) => {
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const ok = await deleteColumn(filename)
  if (!ok) return c.json({ error: "delete failed" }, 500)
  kanbanNotify()
  return c.json({ ok: true })
})

app.put("/api/kanban/:filename/color", requireAuth, async (c) => {
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.color !== "string") return c.json({ error: "color required" }, 400)
  await setColumnColor(filename, body.color)
  kanbanNotify()
  return c.json({ ok: true })
})

app.put("/api/kanban/:filename/reorder", requireAuth, async (c) => {
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const body = await c.req.json().catch(() => ({}))
  if (!Array.isArray(body.cids)) return c.json({ error: "cids array required" }, 400)
  const ok = await reorderCards(filename, body.cids)
  if (!ok) return c.json({ error: "reorder failed" }, 500)
  kanbanNotify()
  return c.json({ ok: true })
})

app.post("/api/kanban/:filename/cards/:cid/assign-driver", requireAuth, async (c) => {
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const cid = c.req.param("cid") ?? ""
  const userId = c.get("userId") as string
  const r = await assignDriverForCard(filename, cid, userId)
  if (!r.ok) return c.json({ error: "no associated loop" }, 400)
  return c.json(r)
})

app.post("/api/kanban/:filename/cards/:cid/create-loop", requireAuth, async (c) => {
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const cid = c.req.param("cid") ?? ""
  const userId = c.get("userId") as string
  const r = await createLoopFromCard(filename, cid, userId)
  if (!r.ok) return c.json({ error: "create failed" }, 500)
  return c.json(r)
})

app.post("/api/kanban/:filename/cards/:cid/link-loop", requireAuth, async (c) => {
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const cid = c.req.param("cid") ?? ""
  const userId = c.get("userId") as string
  const { loopId } = (await c.req.json().catch(() => ({}))) as { loopId?: string }
  if (!loopId) return c.json({ error: "loopId required" }, 400)
  const ok = await linkLoopToCard(filename, cid, loopId, userId)
  if (!ok) return c.json({ error: "link failed" }, 500)
  return c.json({ ok: true })
})

app.get("/api/topics", requireAuth, async (c) => {
  const loops = await listLoops()
  const titles = loops
    .filter((l) => !l.archived)
    .map((l) => ({ id: l.id, title: l.title }))
  return c.json({ topics: await listTopics(titles) })
})

// ── Chat ──────────────────────────────────────────────────────────────────
//
// SQLite-backed channels + 1:1 DMs. Real-time fanout via /ws/chat with
// per-conversation subscriber sets. When a loop is spawned from a chat
// conversation, the last 1024 messages are snapshotted to a per-loop jsonl
// at loops/<id>/context/chat/<convId>.jsonl so the AI inside the sandbox
// can read it from /loopat/context/chat/.

type ChatSubscriber = { ws: any; userId: string; convs: Set<string> }
const chatSubscribers = new Set<ChatSubscriber>()

function chatBroadcastToConv(convId: string, msg: object, isDm: boolean, dmParties: [string, string] | null) {
  const payload = JSON.stringify(msg)
  for (const sub of chatSubscribers) {
    if (!sub.convs.has(convId)) continue
    // DM: only the two parties receive even if a third party somehow subscribed.
    if (isDm && dmParties && sub.userId !== dmParties[0] && sub.userId !== dmParties[1]) continue
    try { sub.ws.send(payload) } catch {}
  }
}

function chatBroadcastConvCreated(convCreatedPayload: any, isDm: boolean, dmParties: [string, string] | null) {
  // For channel creation: broadcast to every connected client so rails refresh.
  // For DM creation: only the two parties learn about it.
  const payload = JSON.stringify(convCreatedPayload)
  for (const sub of chatSubscribers) {
    if (isDm && dmParties && sub.userId !== dmParties[0] && sub.userId !== dmParties[1]) continue
    try { sub.ws.send(payload) } catch {}
  }
}

app.get("/api/chat/users", requireAuth, async (c) => {
  // Workspace member directory for the DM picker. Filter to active accounts —
  // pending users can't log in so DMing them is pointless.
  const users = await listUsers()
  const me = c.get("userId") as string
  return c.json({
    users: users
      .filter((u) => u.status === "active")
      .map((u) => ({ id: u.id, role: u.role, isMe: u.id === me })),
  })
})

app.get("/api/chat/conversations", requireAuth, (c) => {
  const userId = c.get("userId") as string
  const convs = listConversationsForUser(userId)
  return c.json({ conversations: convs })
})

app.post("/api/chat/channels", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.name !== "string") return c.json({ error: "name required" }, 400)
  const topic = typeof body.topic === "string" ? body.topic : undefined
  const r = createChannel({ name: body.name, topic, createdBy: userId })
  if (!r.ok) return c.json({ error: r.error }, 400)
  chatBroadcastConvCreated({ type: "conv_created", conv: r.conv }, false, null)
  return c.json({ conv: r.conv })
})

app.delete("/api/chat/channels/:id", requireAdmin, (c) => {
  const id = c.req.param("id") ?? ""
  const conv = getConv(id)
  if (!conv || conv.kind !== "channel") return c.json({ error: "not found" }, 404)
  const ok = deleteChannel(id)
  if (!ok) return c.json({ error: "delete failed" }, 500)
  chatBroadcastConvCreated({ type: "conv_deleted", convId: id }, false, null)
  return c.json({ ok: true })
})

app.post("/api/chat/dm/:username", requireAuth, async (c) => {
  const me = c.get("userId") as string
  const peer = c.req.param("username") ?? ""
  if (!peer) return c.json({ error: "username required" }, 400)
  if (peer === me) return c.json({ error: "cannot DM yourself" }, 400)
  const peerUser = await findUser(peer)
  if (!peerUser || peerUser.status !== "active") return c.json({ error: "user not found" }, 404)
  const conv = getOrCreateDm(me, peer, me)
  // Broadcast so both parties' rails see the new DM (idempotent — no-op if already known).
  chatBroadcastConvCreated(
    { type: "conv_created", conv },
    true,
    [conv.dmUserA as string, conv.dmUserB as string],
  )
  return c.json({ conv })
})

app.get("/api/chat/conversations/:id/messages", requireAuth, (c) => {
  const id = c.req.param("id") ?? ""
  const userId = c.get("userId") as string
  const conv = getConv(id)
  if (!conv) return c.json({ error: "not found" }, 404)
  if (!userCanAccess(conv, userId)) return c.json({ error: "forbidden" }, 403)
  const before = parseInt(c.req.query("before") ?? "0", 10) || 0
  const limit = parseInt(c.req.query("limit") ?? "50", 10) || 50
  return c.json({ messages: listMessages(id, { before, limit }) })
})

app.post("/api/chat/conversations/:id/messages", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  const userId = c.get("userId") as string
  const conv = getConv(id)
  if (!conv) return c.json({ error: "not found" }, 404)
  if (!userCanAccess(conv, userId)) return c.json({ error: "forbidden" }, 403)
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.text !== "string" || !body.text.trim()) return c.json({ error: "text required" }, 400)
  const parentId = Number.isInteger(body.parentId) && body.parentId > 0 ? body.parentId : null
  let m
  try {
    m = postMessage(id, userId, body.text, parentId)
  } catch (e: any) {
    return c.json({ error: e?.message ?? "post failed" }, 400)
  }
  const dmParties: [string, string] | null =
    conv.kind === "dm" ? [conv.dmUserA as string, conv.dmUserB as string] : null
  // Broadcast carries parent_id implicitly via Message.parentId — clients
  // route it to the main feed (null) or the open ThreadPanel (matching root).
  chatBroadcastToConv(id, { type: "message", message: m }, conv.kind === "dm", dmParties)
  return c.json({ message: m })
})

// Thread fetch: root message + all replies. Auth via the conversation the
// root belongs to. Used by ThreadPanel on open.
app.get("/api/chat/threads/:msgId", requireAuth, (c) => {
  const userId = c.get("userId") as string
  const rootId = parseInt(c.req.param("msgId") ?? "0", 10)
  if (!rootId) return c.json({ error: "invalid msgId" }, 400)
  const t = listThread(rootId)
  if (!t) return c.json({ error: "not found" }, 404)
  const conv = getConv(t.root.convId)
  if (!conv || !userCanAccess(conv, userId)) return c.json({ error: "forbidden" }, 403)
  return c.json({ root: t.root, replies: t.replies })
})

app.post("/api/chat/conversations/:id/read", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  const userId = c.get("userId") as string
  const conv = getConv(id)
  if (!conv) return c.json({ error: "not found" }, 404)
  if (!userCanAccess(conv, userId)) return c.json({ error: "forbidden" }, 403)
  const body = await c.req.json().catch(() => ({}))
  const lastReadId = parseInt(body.lastReadId ?? 0, 10) || 0
  if (lastReadId <= 0) return c.json({ error: "lastReadId required" }, 400)
  markRead(userId, id, lastReadId)
  return c.json({ ok: true })
})

// Spawn a loop seeded from a thread. The thread (= root message + replies,
// length ≥ 1) is the natural semantic unit — even a brand-new top-level
// message with no replies works (snapshot of 1 line). Snapshot lives at
// loops/<id>/context/chat/<rootId>.jsonl, mounted ro at /loopat/context/chat/
// inside the sandbox.
app.post("/api/chat/threads/:msgId/spawn-loop", requireAuth, async (c) => {
  const rootId = parseInt(c.req.param("msgId") ?? "0", 10)
  if (!rootId) return c.json({ error: "invalid msgId" }, 400)
  const userId = c.get("userId") as string
  const t = listThread(rootId)
  if (!t) return c.json({ error: "not found" }, 404)
  const conv = getConv(t.root.convId)
  if (!conv || !userCanAccess(conv, userId)) return c.json({ error: "forbidden" }, 403)
  const body = await c.req.json().catch(() => ({}))
  const dmPeer = conv.kind === "dm"
    ? (conv.dmUserA === userId ? conv.dmUserB : conv.dmUserA)
    : null
  // Title default: first ~40 chars of the thread root (the topic). Cleaner
  // than "from #channel" — at thread granularity the root IS the topic.
  const defaultTitle = t.root.text.replace(/\s+/g, " ").slice(0, 40).trim() || "from chat"
  const title = typeof body.title === "string" && body.title.trim()
    ? body.title.trim()
    : defaultTitle
  let meta
  try {
    meta = await createLoop({ title, createdBy: userId })
  } catch (e: any) {
    return c.json({ error: e?.message ?? "loop create failed" }, 400)
  }
  const destPath = pathJoin(loopContextChatDir(meta.id), `${rootId}.jsonl`)
  let snapshot
  try {
    snapshot = await snapshotThreadToJsonl(rootId, destPath)
  } catch (e: any) {
    return c.json({ error: `snapshot failed: ${e?.message ?? e}` }, 500)
  }
  if (!snapshot) return c.json({ error: "thread vanished" }, 404)
  await patchLoopMeta(meta.id, {
    seededFrom: {
      kind: "chat",
      convId: t.root.convId,
      threadRootId: rootId,
      messageCount: snapshot.messageCount,
      snapshotAt: new Date().toISOString(),
    },
  } as any)
  const convLabel = conv.kind === "channel" ? `#${conv.name}` : `@${dmPeer}`
  const seedPrompt =
    `Spawned from a ${convLabel} thread (${snapshot.messageCount} message${snapshot.messageCount === 1 ? "" : "s"}). ` +
    `Snapshot at \`/loopat/context/chat/${rootId}.jsonl\` — read it with the Read tool, then propose next steps.`
  return c.json({ loopId: meta.id, seedPrompt, messageCount: snapshot.messageCount })
})

// ── Chat WebSocket ────────────────────────────────────────────────────────

app.get(
  "/ws/chat",
  upgradeWebSocket(async (c) => {
    const userId = getRequestUserId(c)
    if (!userId) {
      return {
        onOpen(_e, ws) {
          ws.send(JSON.stringify({ type: "error", message: "unauthorized" }))
          ws.close()
        },
      }
    }
    let sub: ChatSubscriber | null = null
    return {
      onOpen(_e, ws) {
        sub = { ws, userId, convs: new Set() }
        chatSubscribers.add(sub)
        ws.send(JSON.stringify({ type: "chat_connected" }))
      },
      onMessage(event, ws) {
        try {
          const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)
          const msg = JSON.parse(data)
          if (msg?.type === "subscribe" && typeof msg.convId === "string" && sub) {
            const conv = getConv(msg.convId)
            if (!conv) return
            if (!userCanAccess(conv, userId)) return
            sub.convs.add(msg.convId)
          } else if (msg?.type === "unsubscribe" && typeof msg.convId === "string" && sub) {
            sub.convs.delete(msg.convId)
          }
        } catch (e) {
          try { ws.send(JSON.stringify({ type: "error", message: "bad message" })) } catch {}
        }
      },
      onClose() {
        if (sub) chatSubscribers.delete(sub)
        sub = null
      },
    }
  })
)

// ── Kanban WebSocket (real-time updates) ──

app.get(
  "/ws/kanban",
  upgradeWebSocket(async (c) => {
    const userId = getRequestUserId(c)
    if (!userId) {
      return {
        onOpen(_e, ws) {
          ws.send(JSON.stringify({ type: "error", message: "unauthorized" }))
          ws.close()
        },
      }
    }
    return {
      onOpen(_e, ws) {
        const sub: KanbanSubscriber = { ws, userId }
        kanbanSubscribers.add(sub)
        ws.send(JSON.stringify({ type: "kanban_connected" }))
      },
      onMessage(_event, _ws) {
        // No client-to-server messages needed for Kanban — it's broadcast-only
      },
      onClose(_e, ws) {
        for (const sub of kanbanSubscribers) {
          if (sub.ws === ws) { kanbanSubscribers.delete(sub); break }
        }
      },
    }
  })
)

app.get(
  "/ws/loop/:id/term",
  upgradeWebSocket(async (c) => {
    const id = c.req.param("id") ?? ""
    const userId = getRequestUserId(c)
    if (!userId) {
      return {
        onOpen(_e, ws) {
          ws.send(JSON.stringify({ type: "error", message: "unauthorized" }))
          ws.close()
        },
      }
    }
    const canWrite = true
    const exists = await loopExists(id)
    if (!exists) {
      return {
        onOpen(_e, ws) {
          ws.send(JSON.stringify({ type: "error", message: `loop ${id} not found` }))
          ws.close()
        },
      }
    }
    let attachedTerm: any = null
    return {
      async onOpen(_e, ws) {
        attachedTerm = ws
        try {
          await attachTerm(id, ws)
        } catch (e: any) {
          attachedTerm = null
          const msg = e?.message ?? String(e)
          console.error(`[term:${id.slice(0, 8)}] attach failed: ${msg}`)
          try {
            ws.send(JSON.stringify({ type: "error", message: msg }))
            ws.send(JSON.stringify({ type: "exit", code: -1 }))
          } catch {}
          try { ws.close() } catch {}
        }
      },
      async onMessage(event, ws) {
        try {
          const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)
          const msg = JSON.parse(data)
          // resize is harmless; allow anonymous so viewers don't trigger auth errors on connect
          if (msg?.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
            resizeTerm(id, msg.cols, msg.rows)
            return
          }
          if (!canWrite) {
            try { ws.send(JSON.stringify({ type: "error", message: "login required to send" })) } catch {}
            return
          }
          // Block writes on archived loops (re-read each msg to honor unarchive).
          const meta = await getLoop(id)
          if (meta?.archived) {
            try { ws.send(JSON.stringify({ type: "error", message: "loop is archived (read-only)" })) } catch {}
            return
          }
          if (msg?.type === "data" && typeof msg.data === "string") writeTerm(id, msg.data)
        } catch (e) {
          console.error("term ws parse", e)
        }
      },
      onClose() {
        if (attachedTerm) detachTerm(id, attachedTerm)
      },
    }
  })
)

app.get(
  "/ws/loop/:id",
  upgradeWebSocket(async (c) => {
    const id = c.req.param("id") ?? ""
    const userId = getRequestUserId(c)
    const canWrite = !!userId
    const exists = await loopExists(id)
    if (!exists) {
      return {
        onOpen(_e, ws) {
          ws.send(JSON.stringify({ type: "error", message: `loop ${id} not found` }))
          ws.close()
        },
      }
    }
    // Anonymous attach is only allowed for loops that have been explicitly
    // shared (meta.public). Logged-in users can attach to any loop they can
    // see. Writes (sendUserText/clear/etc) for anon are blocked below.
    if (!userId) {
      const meta = await getLoop(id)
      if (!meta?.public) {
        return {
          onOpen(_e, ws) {
            ws.send(JSON.stringify({ type: "error", message: "unauthorized" }))
            ws.close()
          },
        }
      }
    }
    const session = getSession(id)
    let attached: any = null
    return {
      async onOpen(_e, ws) {
        attached = ws
        await session.attach(ws)
      },
      async onMessage(event, ws) {
        if (!canWrite) {
          try { ws.send(JSON.stringify({ type: "error", message: "login required to send" })) } catch {}
          return
        }
        // Block all writes on archived loops. Re-read meta per message so
        // unarchive takes effect without reconnect.
        const meta = await getLoop(id)
        if (meta?.archived) {
          try { ws.send(JSON.stringify({ type: "error", message: "loop is archived (read-only)" })) } catch {}
          return
        }
        try {
          const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)
          const msg = JSON.parse(data)
          if (msg?.type === "user" && typeof msg.text === "string") {
            // Validate against SDK PermissionMode values
            const validModes = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]
            const pm = msg.permissionMode
            const permissionMode = typeof pm === "string" && validModes.includes(pm)
              ? pm as "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto"
              : undefined
            session.sendUserText(msg.text, permissionMode)
          } else if (msg?.type === "clear") {
            session.clear(userId ?? "anon")
          } else if (msg?.type === "interrupt") {
            session.interrupt()
          } else if (msg?.type === "queue_clear") {
            session.clearQueue()
          } else if (msg?.type === "queue_remove") {
            if (typeof msg?.index === "number") session.removeQueueItem(msg.index)
          } else if (msg?.type === "queue_status") {
            try { ws.send(JSON.stringify({ type: "queue_update", queueLength: session.getQueueLength() })) } catch {}
          } else if (msg?.type === "answers") {
            session.answerQuestions(msg.tool_use_id, msg.answers)
          } else if (msg?.type === "permission_answer") {
            session.answerPermission(msg.tool_use_id, !!msg.allow)
          } else if (msg?.type === "set_max_thinking_tokens") {
            session.setMaxThinkingTokens(
              typeof msg.tokens === "number" || msg.tokens === null ? msg.tokens : null,
            )
          } else if (msg?.type === "get_context_usage") {
            session.getContextUsage().then((usage) => {
              if (usage) {
                try { ws.send(JSON.stringify({ type: "context_usage", ...usage })) } catch {}
              }
            }).catch(() => {})
          } else if (msg?.type === "provider_select" && typeof msg.provider === "string") {
            const ok = session.setProvider(msg.provider)
            if (ok) {
              const source = msg.source === "personal" || msg.source === "workspace" ? msg.source : undefined
              // Persist to loop meta so it survives reloads
              patchLoopMeta(id, { config: { default_model: msg.provider, default_model_source: source } }).catch(() => {})
              try {
                // Resolve provider info: personal first, then workspace fallback.
                let p: { model: string; maxContextTokens?: number } | undefined
                if (userId) {
                  try {
                    const loopMeta = await getLoop(id)
                    const pCfg = await loadPersonalConfig(userId, loopMeta?.config?.vault)
                    p = pCfg.providers[msg.provider]
                  } catch {}
                }
                if (!p) {
                  const wCfg = await loadConfig()
                  p = wCfg.providers?.[msg.provider]
                }
                if (p) {
                  ws.send(JSON.stringify({
                    type: "provider",
                    name: msg.provider,
                    model: p.model,
                    contextWindow: p.maxContextTokens && p.maxContextTokens > 0 ? p.maxContextTokens : 200_000,
                  }))
                }
              } catch {}
            }
          }
        } catch (e) {
          console.error("ws message parse error", e)
        }
      },
      onClose() {
        if (attached) session.detach(attached)
      },
    }
  })
)

// ── static assets (production) ──
import { getLoopStatus, watchStatusFile, markLoopViewed, type LoopStatusMap } from "./loop-status"

// ── Loop status real-time hub ──

let lastSnapshot: LoopStatusMap = getLoopStatus()
const statusWatchers = new Map<any, Set<string>>()

watchStatusFile((curr, prev) => {
  lastSnapshot = curr
  for (const [ws, ids] of statusWatchers) {
    const updates: LoopStatusMap = {}
    for (const id of ids) {
      if (curr[id]?.updated !== prev[id]?.updated) {
        updates[id] = curr[id]
      }
    }
    if (Object.keys(updates).length) {
      try { ws.send(JSON.stringify({ type: "update", data: updates })) } catch {}
    }
  }
})

app.get("/ws/loop-status", upgradeWebSocket((c) => {
  return {
    onOpen: (_ev, ws) => {
      statusWatchers.set(ws, new Set())
    },
    onMessage: (ev, ws) => {
      try {
        const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)
        const msg = JSON.parse(text)
        if (msg.type === "subscribe") {
          const ids = new Set(msg.ids as string[])
          statusWatchers.set(ws, ids)
          const init: LoopStatusMap = {}
          for (const id of ids) {
            if (lastSnapshot[id]) init[id] = lastSnapshot[id]
          }
          ws.send(JSON.stringify({ type: "init", data: init }))
        }
      } catch (e) {
        console.error("[ws/loop-status] error:", e)
      }
    },
    onClose: (_ev, ws) => {
      statusWatchers.delete(ws)
    }
  }
}))

import { join } from "node:path"
import { networkInterfaces } from "node:os"
const webDist = join(import.meta.dir, "..", "..", "web", "dist")
const indexHtml = join(webDist, "index.html")

app.get("*", async (c, next) => {
  const path = c.req.path
  // Don't interfere with API / WS routes
  if (path.startsWith("/api/") || path.startsWith("/ws/")) return next()
  // Try to serve the exact file
  const file = Bun.file(join(webDist, path === "/" ? "index.html" : path))
  if (await file.exists()) {
    return new Response(file, {
      headers: { "content-type": file.type },
    })
  }
  // SPA fallback
  return new Response(Bun.file(indexHtml), {
    headers: { "content-type": "text/html" },
  })
})

const port = Number(process.env.PORT ?? 7787)
const hostname = process.env.HOST ?? "127.0.0.1"
await ensureWorkspaceDirs()
const backfilled = await backfillAllMounts()
const cfg = await loadConfig()
// Initialise chat DB. bootstrap user = first admin (if one exists) — only used
// to seed the default #general channel on a fresh DB.
let chatSeed = ""
try {
  const users = await listUsers()
  const firstAdmin = users.find((u) => u.role === "admin")
  chatSeed = firstAdmin?.id ?? users[0]?.id ?? ""
} catch {}
initChat(chatSeed)
await printBootstrapBanner(cfg)
if (backfilled > 0) console.log(`[loopat] backfilled context mounts on ${backfilled} loop(s)`)

// Start workspace serve service (separate port)
import "./serve"

const serveHost = process.env.LOOPAT_SERVE_HOST ?? "127.0.0.1"
const servePort = process.env.LOOPAT_SERVE_PORT ?? "7788"

console.log(`[loopat] server listening on http://${hostname}:${port}`)
console.log(`[loopat] workspace serve listening on http://${serveHost}:${servePort}`)

export default {
  port,
  hostname,
  fetch: app.fetch,
  websocket,
}
