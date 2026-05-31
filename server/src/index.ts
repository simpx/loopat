import { Hono } from "hono"
import { cors } from "hono/cors"
import { createBunWebSocket } from "hono/bun"
import { existsSync } from "node:fs"
import { execSync, execFile } from "node:child_process"
import { promisify } from "node:util"
import { listLoops, createLoop, getLoop, loopExists, patchLoopMeta, backfillAllMounts, ensureWorkspaceDirs, provisionUserPersonal, importPersonalFromRepo, setupPersonalViaProvider, listPersonalReposViaProvider, authenticateViaProvider, providerTokenHelp, isPersonalFresh, ensureUiNotesWorktree, syncUiNotes, ffUpdateUiNotes, notesBehind, inspectPersonalDirty, syncPersonalToRemote, deletePersonalVault, pullPersonalFromRemote, pushPersonalToRemote, ensureContextMounts, effectiveDriver, isDriver, distillLoop, inspectRepoSync, pullRepoFromRemote, pushRepoToRemote } from "./loops"
import { getEphemeralHostPort } from "./podman"
import { getOnboardingStatus, startOnboardingLoop, markOnboardingDone } from "./onboarding"
import { startMcpAuth, completeMcpAuth, probeOAuthSupport, evictOAuthProbe, parseBearerEnvName, type OAuthSupport } from "./mcp-oauth"
import { DEFAULT_VAULT, loadVaultEnvs } from "./vaults"
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
import { join as pathJoin, dirname } from "node:path"
import { ensurePersonalKeypair, getPublicKey } from "./personal-keys"
// `destroySession` here clashes with auth's session-token destroyer; alias to
// keep both callable without import-order-dependent shadowing.
import { getSession, destroySession as destroyLoopSession, restartSession, getActivitySnapshot } from "./session"
import { listDir, listDirRecursive, readWorkdirFile, writeWorkdirFile, deleteWorkdirFile, createWorkdirFolder } from "./files"
import { vaultList, vaultFlatList, vaultRead, vaultWrite, vaultCreateFile, vaultCreateFolder, vaultDelete, vaultBacklinks, listRepos, readRepoDetail, pullRepo, addRepo, listTopics, type VaultId } from "./workspace"
// sandboxes module removed — no /api/sandboxes/* routes in the profile model.
// Use /api/profiles + /api/personal/default-profiles instead.
import { attachTerm, detachTerm, writeTerm, resizeTerm, killTerm } from "./term"
import {
  LOOPAT_HOME,
  LOOPAT_INSTALL_DIR,
  WORKSPACE,
  loopContextKnowledge,
  loopContextNotes,
  loopContextPersonal,
  loopContextRepos,
  loopWorkdir,
  loopHistoryPath,
  loopChatHistoryPath,
  workspaceKnowledgeDir,
  workspaceNotesDir,
  workspaceRepoDir,
  workspaceReposDir,
  loopsDir,
} from "./paths"
import { loadConfig, loadPersonalConfig, savePersonalConfig, saveWorkspaceConfig, loadTokenUsage, getActiveProvider, readPersonalDiskRaw, savePersonalDisk, describeApiKeyRef, writeVaultEnv, deleteVaultEnv, type ProviderConfig, type ModelEntry } from "./config"
import { listBoards, createBoard, renameBoard, listKanbanColumns, addCard, toggleCard, deleteCard, moveCard, updateCardMeta, updateCardBlock, reorderCards, createColumn, deleteColumn, readKanbanConfig, saveColumnOrder, setColumnColor, renameColumn, assignDriverForCard, createLoopFromCard, linkLoopToCard, kanbanUserCtx } from "./kanban"
import { printBootstrapBanner } from "./bootstrap"
import { serveHostExec } from "./host-exec"
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
export const app = new Hono<{ Variables: Variables }>()

app.use("/api/*", cors({ origin: (o) => o ?? "*", credentials: true }))

// public routes
app.get("/api/health", (c) => c.json({ ok: true, loopatHome: LOOPAT_HOME, workspace: WORKSPACE }))

app.get("/api/version", (c) => {
  let branch = "unknown", commit = "unknown"
  try { branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim() } catch {}
  try { commit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim() } catch {}
  return c.json({ branch, commit })
})

// Loop API v1 — see docs/api-v1.md. Public surface for bot frameworks + the
// web app's chat experience. All other web features stay on internal WS/REST.
import { buildApiV1 } from "./api-v1"
app.route("/api/v1", buildApiV1())

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

app.get("/api/serve/config", requireAdmin, async (c) => {
  const cfg = await loadConfig()
  const domain = cfg.serveDomain ?? "nip.io"
  const ip = getLocalIp()
  const isNip = domain === "nip.io"
  return c.json({
    // Standard serve
    serveEnabled: cfg.serveEnabled ?? true,
    domain,
    ip,
    baseUrl: isNip ? `.${ip}.${domain}` : `.${domain}`,
    withPort: cfg.serveWithPort ?? false,
    https: cfg.serveHttps ?? false,
    displayPort: cfg.serveDisplayPort ?? 7788,
    // Dynamic port
    serveDynamicEnabled: cfg.serveDynamicEnabled ?? false,
    serveDynamicDomain: cfg.serveDynamicDomain ?? "",
    serveDynamicPortRange: cfg.serveDynamicPortRange ?? "10000-20000",
    serveDynamicUdpEnabled: cfg.serveDynamicUdpEnabled ?? false,
    serveDynamicStaticEnabled: cfg.serveDynamicStaticEnabled ?? false,
    // Ephemeral port: kernel-assigned host port per loop, changes on
    // every loop restart. No port-proxy involved.
    serveEphemeralEnabled: cfg.serveEphemeralEnabled ?? false,
    serveEphemeralDomain: cfg.serveEphemeralDomain ?? "",
  })
})

app.put("/api/serve/config", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const patch: Record<string, unknown> = {}
  if (typeof body.domain === "string" && body.domain.trim()) patch.serveDomain = body.domain.trim()
  if (typeof body.withPort === "boolean") patch.serveWithPort = body.withPort
  if (typeof body.https === "boolean") patch.serveHttps = body.https
  if (typeof body.displayPort === "number") patch.serveDisplayPort = body.displayPort
  if (typeof body.serveEnabled === "boolean") patch.serveEnabled = body.serveEnabled
  if (typeof body.serveDynamicEnabled === "boolean") patch.serveDynamicEnabled = body.serveDynamicEnabled
  if (typeof body.serveDynamicDomain === "string") patch.serveDynamicDomain = body.serveDynamicDomain.trim()
  if (typeof body.serveDynamicPortRange === "string") patch.serveDynamicPortRange = body.serveDynamicPortRange.trim()
  if (typeof body.serveDynamicUdpEnabled === "boolean") patch.serveDynamicUdpEnabled = body.serveDynamicUdpEnabled
  if (typeof body.serveDynamicStaticEnabled === "boolean") patch.serveDynamicStaticEnabled = body.serveDynamicStaticEnabled
  if (typeof body.serveEphemeralEnabled === "boolean") patch.serveEphemeralEnabled = body.serveEphemeralEnabled
  if (typeof body.serveEphemeralDomain === "string") patch.serveEphemeralDomain = body.serveEphemeralDomain.trim()
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

// Return a random unused port from the dynamic port range, or null if none available.
app.get("/api/serve/available-port", requireAuth, async (c) => {
  const cfg = await loadConfig()
  const range = cfg.serveDynamicPortRange || "10000-20000"
  const [lo, hi] = range.split("-").map(Number)
  if (!lo || !hi || lo >= hi) return c.json({ port: null, error: "invalid port range" })

  // Port-proxy maps the entire range — binding test would always fail.
  // Just pick a port not already claimed by another ENABLED loop.
  const used = new Set<number>()
  try {
    const all = await listLoops()
    for (const loop of all) {
      if (loop.shareEnabled && loop.shareExternalPort) used.add(loop.shareExternalPort)
    }
  } catch {}

  for (let i = 0; i < 100; i++) {
    const port = lo + Math.floor(Math.random() * (hi - lo + 1))
    if (!used.has(port)) return c.json({ port })
  }
  return c.json({ port: null, error: "no available port in range" })
})

// Check if a specific port is available for use by a loop.
app.get("/api/serve/check-port", requireAuth, async (c) => {
  const port = parseInt(c.req.query("port") ?? "")
  const loopId = (c.req.query("loopId") ?? "").trim()
  if (!port || port < 1 || port > 65535) return c.json({ available: false, reason: "Invalid port" })

  const cfg = await loadConfig()
  const range = cfg.serveDynamicPortRange || "10000-20000"
  const [lo, hi] = range.split("-").map(Number)
  if (port < lo || port > hi) return c.json({ available: false, reason: `Port outside configured range (${range})` })

  // Check if another ENABLED loop already claims this port
  try {
    const all = await listLoops()
    for (const loop of all) {
      if (loop.id === loopId) continue
      if (loop.shareEnabled && loop.shareExternalPort === port) {
        return c.json({ available: false, reason: `Port ${port} is already used by another loop` })
      }
    }
  } catch {}

  return c.json({ available: true })
})

// ── providers (auth required) ──
// Merges personal + workspace configs. Personal providers take precedence
// (they carry per-user apiKeys via secrets/). Source field indicates origin.
app.get("/api/providers", requireAuth, async (c) => {
  const wCfg = await loadConfig()
  const providers: Record<string, { models: ModelEntry[]; baseUrl: string; source: "personal" | "workspace"; enabled: boolean; hasKey: boolean }> = {}
  if (wCfg.providers) {
    for (const [name, p] of Object.entries(wCfg.providers)) {
      const hasKey = typeof p.apiKey === "string" && p.apiKey.length > 0
      providers[name] = { models: p.models, baseUrl: p.baseUrl, source: "workspace", enabled: hasKey ? p.enabled : false, hasKey }
    }
  }
  // Overlay personal providers (they take precedence)
  let active = wCfg.default ?? ""
  const userId = c.get("userId") as string
  try {
    const pCfg = await loadPersonalConfig(userId)
    for (const [name, p] of Object.entries(pCfg.providers)) {
      const hasKey = typeof p.apiKey === "string" && p.apiKey.length > 0
      // Only overlay if the user actually configured this provider (has a key).
      // Template/preset providers without a key should not shadow workspace config.
      if (hasKey) {
        providers[name] = { models: p.models, baseUrl: p.baseUrl, source: "personal", enabled: p.enabled !== false, hasKey }
      }
    }
    active = pCfg.default || active
  } catch {}
  return c.json({ providers, default: active })
})

// Test a provider + model connection by making a minimal Messages API call.
// Accepts either a plain apiKey, or a provider name + source to resolve the
// key server-side (so tests work for stored/encrypted keys without re-typing).
app.post("/api/providers/test", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { baseUrl, apiKey: rawApiKey, model, provider, source } = body
  if (typeof baseUrl !== "string" || !baseUrl) return c.json({ ok: false, error: "baseUrl required" }, 400)
  if (typeof model !== "string" || !model) return c.json({ ok: false, error: "model required" }, 400)

  let apiKey = typeof rawApiKey === "string" ? rawApiKey.trim() : ""
  // Resolve key server-side when a stored (encrypted) key is being tested
  if (!apiKey && typeof provider === "string" && provider) {
    if (source === "personal") {
      const userId = c.get("userId") as string
      try {
        const pCfg = await loadPersonalConfig(userId)
        apiKey = pCfg.providers[provider]?.apiKey ?? ""
      } catch {}
    } else if (source === "workspace") {
      try {
        const wCfg = await loadConfig()
        apiKey = (wCfg.providers?.[provider] as any)?.apiKey ?? ""
      } catch {}
    }
  }
  if (!apiKey) return c.json({ ok: false, error: "no API key — enter one or store it first" }, 400)

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      return c.json({ ok: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` })
    }
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message ?? "connection failed" })
  }
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

// ── profile CRUD (admin) ──

app.get("/api/admin/profiles", requireAdmin, async (c) => {
  const { listProfilesRich } = await import("./tiers")
  return c.json({ profiles: await listProfilesRich() })
})

app.post("/api/admin/profiles", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const name = typeof body.name === "string" ? body.name.trim() : ""
  if (!name) return c.json({ error: "name required" }, 400)
  const { createProfile } = await import("./tiers")
  const r = await createProfile(name)
  if (!r.ok) return c.json({ error: r.error }, 400)
  return c.json({ ok: true })
})

app.get("/api/admin/profiles/:name", requireAdmin, async (c) => {
  const name = c.req.param("name") ?? ""
  const { getProfile } = await import("./tiers")
  const p = await getProfile(name)
  if (!p) return c.json({ error: "not found" }, 404)
  return c.json(p)
})

app.put("/api/admin/profiles/:name", requireAdmin, async (c) => {
  const name = c.req.param("name") ?? ""
  const body = await c.req.json().catch(() => ({}))
  const { updateProfile } = await import("./tiers")
  const r = await updateProfile(name, { settings: body.settings, claudeMd: body.claudeMd })
  if (!r.ok) return c.json({ error: r.error }, 400)
  return c.json({ ok: true })
})

app.delete("/api/admin/profiles/:name", requireAdmin, async (c) => {
  const name = c.req.param("name") ?? ""
  const { deleteProfile } = await import("./tiers")
  const r = await deleteProfile(name)
  if (!r.ok) return c.json({ error: r.error }, 400)
  return c.json({ ok: true })
})

// ── admin presets ──

import { DEFAULT_PROVIDER_PRESETS, DEFAULT_MISE_TOOL_PRESETS } from "./presets"

app.get("/api/admin/presets", requireAdmin, async (c) => {
  const cfg = await loadConfig()
  const presets = cfg.presets ?? {
    providerPresets: DEFAULT_PROVIDER_PRESETS,
    miseToolPresets: DEFAULT_MISE_TOOL_PRESETS,
  }
  return c.json(presets)
})

app.put("/api/admin/presets", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (body.providerPresets !== undefined && !Array.isArray(body.providerPresets)) {
    return c.json({ error: "providerPresets must be an array" }, 400)
  }
  if (body.miseToolPresets !== undefined && !Array.isArray(body.miseToolPresets)) {
    return c.json({ error: "miseToolPresets must be an array" }, 400)
  }
  try {
    await saveWorkspaceConfig({ presets: body })
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e?.message ?? "save failed" }, 500)
  }
})

// ── admin platform (system info + git pull) ──

/**
 * Snapshot of server state for the admin dashboard at /admin/system. Polled
 * every few seconds while the page is open. Active = WS attached OR SDK
 * streaming a reply OR a user message landed in the last 60s. "Active users"
 * is the unique-driver count across those loops.
 */
app.get("/api/admin/system", requireAdmin, async (c) => {
  // version + how far behind origin we are
  let branch = "unknown", commit = "unknown"
  try { branch = (await execFileP("git", ["-C", LOOPAT_INSTALL_DIR, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() } catch {}
  try { commit = (await execFileP("git", ["-C", LOOPAT_INSTALL_DIR, "rev-parse", "HEAD"])).stdout.trim() } catch {}
  let behindBy = 0, latestCommit: string | null = null, latestMessage: string | null = null
  try {
    // Don't `fetch` here — too slow for a 5s poll. Use whatever the local
    // origin/main ref already knows; admin clicks "Check" to refresh it.
    const remote = (await execFileP("git", ["-C", LOOPAT_INSTALL_DIR, "rev-parse", "@{u}"])).stdout.trim()
    if (commit && remote && commit !== remote) {
      const log = (await execFileP("git", ["-C", LOOPAT_INSTALL_DIR, "log", "--oneline", `${commit}..${remote}`])).stdout.trim()
      behindBy = log ? log.split("\n").length : 0
      latestCommit = remote
      latestMessage = (await execFileP("git", ["-C", LOOPAT_INSTALL_DIR, "log", "-1", "--pretty=%s", remote])).stdout.trim()
    }
  } catch {}

  const { stat: fsStat } = await import("node:fs/promises")
  const snap = getActivitySnapshot()
  const now = Date.now()
  const activeLoops: Array<{ id: string; title: string; driver: string; wsCount: number; generating: boolean; lastMsgAgeSec: number }> = []
  let totalWs = 0
  let totalGenerating = 0
  for (const s of snap) {
    totalWs += s.wsCount
    if (s.generating) totalGenerating++
    let lastMsgAgeSec = Number.POSITIVE_INFINITY
    try {
      const st = await fsStat(loopHistoryPath(s.id))
      lastMsgAgeSec = Math.floor((now - st.mtimeMs) / 1000)
    } catch {}
    const active = s.wsCount > 0 || s.generating || lastMsgAgeSec < 60
    if (!active) continue
    const meta = await getLoop(s.id)
    if (!meta) continue
    activeLoops.push({
      id: s.id,
      title: meta.title,
      driver: meta.driver ?? meta.createdBy,
      wsCount: s.wsCount,
      generating: s.generating,
      lastMsgAgeSec: Number.isFinite(lastMsgAgeSec) ? lastMsgAgeSec : -1,
    })
  }
  const activeUsers = new Set(activeLoops.map((l) => l.driver)).size
  return c.json({
    version: { branch, commit, behindBy, latestCommit, latestMessage },
    activity: {
      activeLoops: activeLoops.length,
      activeUsers,
      totalWs,
      totalGenerating,
      loops: activeLoops,
    },
  })
})

/** Run git fetch — refreshes origin/main so the dashboard's behindBy is current. */
app.post("/api/admin/system/check", requireAdmin, async (c) => {
  try {
    const r = await execFileP("git", ["-C", LOOPAT_INSTALL_DIR, "fetch", "--quiet"])
    return c.json({ ok: true, message: r.stderr.trim() || "ok" })
  } catch (e: any) {
    return c.json({ ok: false, error: e?.stderr?.toString().trim() || e?.message || "fetch failed" }, 500)
  }
})

/**
 * git pull --ff-only. Does NOT restart the server — bun --hot is expected to
 * pick up code changes. Schema/dep changes need a real restart (ssh in, run
 * scripts/stop.sh && scripts/start.sh). Failures surface stderr verbatim so
 * the admin can see exactly what to fix.
 */
app.post("/api/admin/system/pull", requireAdmin, async (c) => {
  let oldHead = "", newHead = "", message = ""
  try {
    oldHead = (await execFileP("git", ["-C", LOOPAT_INSTALL_DIR, "rev-parse", "HEAD"])).stdout.trim()
    const r = await execFileP("git", ["-C", LOOPAT_INSTALL_DIR, "pull", "--ff-only"])
    newHead = (await execFileP("git", ["-C", LOOPAT_INSTALL_DIR, "rev-parse", "HEAD"])).stdout.trim()
    message = (r.stdout || r.stderr || "").trim() || "ok"
  } catch (e: any) {
    return c.json({
      ok: false,
      error: e?.stderr?.toString().trim() || e?.stdout?.toString().trim() || e?.message || "pull failed",
      oldHead, newHead,
    }, 500)
  }
  return c.json({ ok: true, pulled: oldHead !== newHead, oldHead, newHead, message })
})

// ── settings (auth required) ──

app.get("/api/settings/personal", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const cfg = await loadPersonalConfig(userId)
  // Recompute token usage from persisted message histories (modelUsage in result messages)
  const tokenUsage = await recomputeTokenUsage(userId)
  const providers: Record<string, { models: ModelEntry[]; baseUrl: string; hasKey: boolean; enabled: boolean; maxContextTokens?: number }> = {}
  for (const [name, p] of Object.entries(cfg.providers)) {
    providers[name] = {
      models: p.models,
      baseUrl: p.baseUrl,
      hasKey: !!p.apiKey,
      enabled: p.enabled,
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

// ── disk-shape settings (for the rich Settings page) ──
// `/api/settings/personal/disk` returns the raw personal/<user>/.loopat/
// config.json. Provider apiKey strings may contain `${VAR}` references; for
// each provider we report whether the referenced vault env file exists.
// The resolved (secret) values are NEVER included — the UI sees structure
// and existence only.

app.get("/api/settings/personal/disk", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const disk = await readPersonalDiskRaw(userId)
  const refExists: Record<string, { kind: string; exists: boolean; varName?: string }> = {}
  if (disk.providers) {
    for (const [name, val] of Object.entries(disk.providers)) {
      if (name === "default" || !val || typeof val !== "object") continue
      const apiKey = (val as any).apiKey
      if (apiKey !== undefined) {
        const d = describeApiKeyRef(apiKey, userId)
        refExists[`providers.${name}.apiKey`] = {
          kind: d.kind,
          exists: d.exists,
          ...(d.varName ? { varName: d.varName } : {}),
        }
      }
    }
  }
  return c.json({ disk, refExists })
})

app.put("/api/settings/personal/disk", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const body = await c.req.json().catch(() => ({}))
  const r = await savePersonalDisk(userId, body)
  if (!r.ok) return c.json({ error: r.error }, 400)
  return c.json({ ok: true })
})

// Write a value to a vault env file. Used by the Settings UI when the user
// types a new apiKey / token. Body: `{ name, value, vault? }` — `name` is
// the env var name (i.e. the contents of `${...}` in config.json apiKey ref);
// `vault` defaults to "default".
app.post("/api/settings/personal/value", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const body = await c.req.json().catch(() => ({}))
  const name = typeof body.name === "string" ? body.name : ""
  const value = typeof body.value === "string" ? body.value : ""
  const vault = typeof body.vault === "string" && body.vault ? body.vault : "default"
  if (!VAULT_RE.test(vault)) return c.json({ error: "invalid vault" }, 400)
  if (!name) return c.json({ error: "name required" }, 400)
  const r = await writeVaultEnv(userId, vault, name, value)
  if (!r.ok) return c.json({ error: r.error }, 400)
  return c.json({ ok: true })
})

// ── onboarding (auth required) ──
// Welcome-card state machine for new users. See server/src/onboarding.ts.

app.get("/api/onboarding", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const status = await getOnboardingStatus(userId)
  // If state says "started" but the loop has since been deleted, fall back to
  // "fresh" so the user can re-start instead of staring at a dead link.
  if (status.state === "started" && status.loopId) {
    if (!(await loopExists(status.loopId))) {
      return c.json({ state: "fresh" })
    }
  }
  return c.json(status)
})

app.post("/api/onboarding/start", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  try {
    const r = await startOnboardingLoop(userId)
    return c.json({ ok: true, loopId: r.loopId })
  } catch (e: any) {
    return c.json({ error: e?.message ?? "start failed" }, 500)
  }
})

app.post("/api/onboarding/done", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  await markOnboardingDone(userId)
  return c.json({ ok: true })
})

// ── MCP OAuth (auth required) ──
// loopat owns the OAuth dance entirely: discovery + DCR + auth code + PKCE
// + token exchange happen server-side. The resulting access token is written
// to the user's personal default vault as a plain env file named by the
// server's `Authorization: Bearer ${VAR}` header — i.e. the same env every
// CC spawn already substitutes into request headers. MCP tokens are thus
// indistinguishable from any other vault env (git-crypt encrypted on disk,
// auto-injected at sandbox spawn).

const VAULT_RE = /^[a-zA-Z0-9_-]+$/
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/
// Server names can have spaces, dots etc. ("Google Drive", "Solve Intelligence").
// Allow common printable chars; reject path/shell metas.
const SERVER_NAME_RE = /^[A-Za-z0-9 ._-]{1,64}$/

/** Best-effort recovery of the public URL the user's browser is hitting us
 *  on. Order: LOOPAT_PUBLIC_URL env → X-Forwarded-* headers → request Host
 *  header. The OAuth `redirect_uri` is built from this and must match what
 *  we register with DCR. */
function publicBaseUrl(c: any): string {
  if (process.env.LOOPAT_PUBLIC_URL) return process.env.LOOPAT_PUBLIC_URL.replace(/\/+$/, "")
  const xfHost = c.req.header("x-forwarded-host")
  const xfProto = c.req.header("x-forwarded-proto")
  const host = xfHost ?? c.req.header("host")
  const proto = xfProto ?? (c.req.url.startsWith("https") ? "https" : "http")
  return `${proto}://${host}`
}

// List the MCP servers visible to a loop. Single source = the loop's merged
// `.claude/settings.json` (composed by compose.ts from team/profile/personal
// settings + plugin-shipped defaults). Each server reports whether its
// `Authorization: Bearer ${VAR}` env is set in the user's personal default
// vault — that's the `authed` flag. `authed` does NOT validate the token
// (no expiry check, no probe), it only means "the env file exists & non-empty".
app.get("/api/mcp-servers", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const loopId = c.req.query("loopId")

  let mcpServers: Record<string, any> = {}
  if (loopId) {
    const { loopClaudeDir } = await import("./paths")
    const { readFile: rf } = await import("node:fs/promises")
    const settingsPath = pathJoin(loopClaudeDir(loopId), "settings.json")
    if (existsSync(settingsPath)) {
      try {
        const j = JSON.parse(await rf(settingsPath, "utf8"))
        mcpServers = (j?.mcpServers ?? {}) as Record<string, any>
      } catch (e: any) {
        console.warn(`[mcp] loop ${loopId} settings unreadable: ${e?.message ?? e}`)
      }
    }
  }

  const envs = await loadVaultEnvs(userId, DEFAULT_VAULT)

  const servers = await Promise.all(
    Object.entries(mcpServers).map(async ([name, srv]) => {
      const type = (srv?.type ?? "stdio") as string
      const url = (srv as any)?.url as string | undefined
      const authTokenEnv = parseBearerEnvName(srv)
      const authed = authTokenEnv ? !!envs[authTokenEnv] : false
      let oauthSupport: OAuthSupport | undefined
      if (url && (type === "http" || type === "sse")) {
        try {
          oauthSupport = await probeOAuthSupport(url)
        } catch {
          oauthSupport = "unreachable"
        }
      }
      return { name, type, url, authTokenEnv, authed, oauthSupport }
    }),
  )

  return c.json({ servers })
})

// Force re-probe of OAuth support. POST with no body clears entire cache;
// body {url: ...} evicts just that URL. Useful after admin fixes a server
// URL or adds a previously-unreachable server.
app.post("/api/mcp-servers/reprobe", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const url = typeof body.url === "string" ? body.url : undefined
  evictOAuthProbe(url)
  return c.json({ ok: true })
})

app.post("/api/mcp-auth/start", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const body = await c.req.json().catch(() => ({}))
  const serverName = typeof body.serverName === "string" ? body.serverName.trim() : ""
  const loopId = typeof body.loopId === "string" ? body.loopId.trim() : ""
  if (!serverName || !SERVER_NAME_RE.test(serverName)) return c.json({ error: "invalid serverName" }, 400)
  if (!loopId) return c.json({ error: "loopId required" }, 400)
  const r = await startMcpAuth({
    user: userId,
    serverName,
    loopId,
    publicBaseUrl: publicBaseUrl(c),
  })
  if (!r.ok) return c.json({ error: r.error }, 400)
  return c.json({ authorizationUrl: r.authorizationUrl })
})

// OAuth provider redirects the browser here after the user authorizes. We
// finish the token exchange and bounce back to the Settings UI with the
// outcome in the query string — no JSON, browser-friendly redirect.
app.get("/api/mcp-auth/callback", async (c) => {
  const state = c.req.query("state") ?? ""
  const code = c.req.query("code") ?? ""
  const errParam = c.req.query("error")
  if (errParam) {
    return c.redirect(`/?mcp_auth=error&reason=${encodeURIComponent(errParam)}`)
  }
  if (!state || !code) {
    return c.redirect(`/?mcp_auth=error&reason=missing_state_or_code`)
  }
  const r = await completeMcpAuth({ state, code })
  if (!r.ok) {
    return c.redirect(`/?mcp_auth=error&reason=${encodeURIComponent(r.error)}`)
  }
  return c.redirect(`/?mcp_auth=ok&server=${encodeURIComponent(r.serverName)}`)
})

// Restart the in-memory LoopSession for a loop (interrupt the running
// query(), so the next user message re-spawns CC and re-injects mcpServers
// + vault tokens + provider env). Conversation history is preserved via
// the SDK's --continue. Auth: must be the loop's createdBy.
app.post("/api/loops/:id/restart-session", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const id = c.req.param("id")
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "loop not found" }, 404)
  if (meta.rfdRequestedAt) return c.json({ error: "loop is in RFD state — click Drive to take over" }, 409)
  if (!isDriver(meta, userId)) return c.json({ error: `only driver (${effectiveDriver(meta)}) can write` }, 403)
  const restarted = restartSession(id)
  return c.json({ ok: true, restarted })
})

// "Forget" an MCP token = delete the env file in the user's personal default
// vault. The UI passes the env name from /api/mcp-servers' `authTokenEnv`.
// This endpoint deliberately accepts any valid env name (not MCP-specific):
// MCP tokens are indistinguishable from other vault envs in the new design.
app.delete("/api/envs/:name", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const name = c.req.param("name")
  if (!ENV_NAME_RE.test(name)) return c.json({ error: "invalid env name" }, 400)
  await deleteVaultEnv(userId, DEFAULT_VAULT, name)
  return c.json({ ok: true })
})

// ── tier settings API (composition model) ──

app.get("/api/tiers", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const me = await findUser(userId)
  const isAdmin = me?.role === "admin"
  const { getTiers } = await import("./tiers")
  return c.json(await getTiers(userId, isAdmin))
})

app.get("/api/tiers/:tier/settings", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const tierId = c.req.param("tier") ?? ""
  const { getTierSettings } = await import("./tiers")
  return c.json(await getTierSettings(tierId, userId))
})

app.put("/api/tiers/:tier/settings", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const tierId = c.req.param("tier") ?? ""
  const me = await findUser(userId)
  const isAdmin = me?.role === "admin"
  // Only admin can write team/profile tiers
  if ((tierId === "team" || tierId.startsWith("profile:")) && !isAdmin) {
    return c.json({ error: "admin required for team/profile tiers" }, 403)
  }
  const body = await c.req.json().catch(() => ({}))
  const { saveTierSettings } = await import("./tiers")
  const r = await saveTierSettings(tierId, body, userId)
  if (!r.ok) return c.json({ error: r.error }, 400)
  return c.json({ ok: true })
})

app.get("/api/tiers/:tier/mise-config", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const tierId = c.req.param("tier") ?? ""
  const { getTierMiseConfig } = await import("./tiers")
  return c.json(await getTierMiseConfig(tierId, userId))
})

app.put("/api/tiers/:tier/mise-config", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const tierId = c.req.param("tier") ?? ""
  const me = await findUser(userId)
  const isAdmin = me?.role === "admin"
  if ((tierId === "team" || tierId.startsWith("profile:")) && !isAdmin) {
    return c.json({ error: "admin required for team/profile tiers" }, 403)
  }
  const body = await c.req.json().catch(() => ({}))
  const content = typeof body.content === "string" ? body.content : ""
  const { saveTierMiseConfig } = await import("./tiers")
  const r = await saveTierMiseConfig(tierId, content, userId)
  if (!r.ok) return c.json({ error: r.error }, 400)
  return c.json({ ok: true })
})

app.get("/api/plugins/available", requireAuth, async (c) => {
  const { listAvailablePlugins } = await import("./tiers")
  return c.json({ plugins: await listAvailablePlugins() })
})

app.get("/api/plugins/browse", requireAuth, async (c) => {
  const { browseMarketplacePlugins } = await import("./tiers")
  return c.json({ plugins: await browseMarketplacePlugins() })
})

app.get("/api/marketplaces", requireAuth, async (c) => {
  const { listMarketplaces } = await import("./tiers")
  return c.json({ marketplaces: await listMarketplaces() })
})

app.post("/api/plugins/refresh", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const { refreshMarketplaces } = await import("./tiers")
  const r = await refreshMarketplaces(userId)
  if (!r.ok) return c.json({ error: r.error }, 500)
  return c.json({ ok: true, added: r.added })
})

app.get("/api/settings/workspace", requireAuth, requireAdmin, async (c) => {
  const cfg = await loadConfig()
  const providers: Record<string, { models: ModelEntry[]; baseUrl: string; hasKey: boolean; enabled: boolean }> = {}
  if (cfg.providers) {
    for (const [name, p] of Object.entries(cfg.providers)) {
      providers[name] = { models: p.models, baseUrl: p.baseUrl, hasKey: !!(p as any).apiKey, enabled: p.enabled }
    }
  }
  const tokenUsage = await recomputeWorkspaceTokenUsage()
  return c.json({
    providers,
    default: cfg.default ?? "",
    tokenUsage,
  })
})

app.put("/api/settings/workspace", requireAuth, requireAdmin, async (c) => {
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

app.get("/api/settings/token-usage/loops", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const loops = await recomputeLoopTokenUsage(userId)
  return c.json(loops)
})

// ── token usage recompute helpers ──

import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises"

type TokenUsageEntry = { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }

function newEntry(): TokenUsageEntry {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
}

function addUsage(e: TokenUsageEntry, mu: any) {
  e.inputTokens += mu.inputTokens ?? 0
  e.outputTokens += mu.outputTokens ?? 0
  e.cacheReadInputTokens += mu.cacheReadInputTokens ?? 0
  e.cacheCreationInputTokens += mu.cacheCreationInputTokens ?? 0
}

async function recomputeTokenUsage(userId: string): Promise<Record<string, TokenUsageEntry>> {
  const usage: Record<string, TokenUsageEntry> = {}
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
              const entry = usage[model] ?? newEntry()
              addUsage(entry, mu)
              usage[model] = entry
            }
          }
        } catch {}
      }
    }
  } catch {}
  return usage
}

async function recomputeWorkspaceTokenUsage(): Promise<Record<string, TokenUsageEntry>> {
  const usage: Record<string, TokenUsageEntry> = {}
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
              const entry = usage[model] ?? newEntry()
              addUsage(entry, mu)
              usage[model] = entry
            }
          }
        } catch {}
      }
    }
  } catch {}
  return usage
}

async function recomputeDailyTokenUsage(userId: string): Promise<Record<string, Record<string, TokenUsageEntry>>> {
  // daily[model][date] = { inputTokens, outputTokens, ... }
  const daily: Record<string, Record<string, TokenUsageEntry>> = {}
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
              const entry = daily[model][date] ?? newEntry()
              addUsage(entry, mu)
              daily[model][date] = entry
            }
          }
        } catch {}
      }
    }
  } catch {}
  return daily
}

async function recomputeLoopTokenUsage(userId: string): Promise<Array<{
  loopId: string
  title: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  lastActivity: string
}>> {
  const loops: Array<{
    loopId: string
    title: string
    model: string
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    lastActivity: string
  }> = []
  try {
    const allLoops = await listLoops()
    const userLoops = allLoops.filter((l) => l.createdBy === userId)
    for (const loop of userLoops) {
      const hp = loopHistoryPath(loop.id)
      if (!existsSync(hp)) continue
      let raw: string
      try { raw = await readFile(hp, "utf8") } catch { continue }
      let inputTokens = 0
      let outputTokens = 0
      let cacheReadInputTokens = 0
      let cacheCreationInputTokens = 0
      const models = new Set<string>()
      let lastActivity = loop.createdAt ?? ""
      for (const line of raw.split("\n")) {
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg._ts) lastActivity = msg._ts
          if (msg.type === "result" && msg.modelUsage) {
            for (const [, mu] of Object.entries(msg.modelUsage as Record<string, any>)) {
              const m = mu as any
              inputTokens += m.inputTokens ?? 0
              outputTokens += m.outputTokens ?? 0
              cacheReadInputTokens += m.cacheReadInputTokens ?? 0
              cacheCreationInputTokens += m.cacheCreationInputTokens ?? 0
            }
            for (const model of Object.keys(msg.modelUsage)) {
              models.add(model)
            }
          }
        } catch {}
      }
      if (inputTokens > 0 || outputTokens > 0) {
        loops.push({
          loopId: loop.id,
          title: loop.title || "Untitled",
          model: Array.from(models).join(", "),
          inputTokens,
          outputTokens,
          cacheReadInputTokens,
          cacheCreationInputTokens,
          lastActivity,
        })
      }
    }
  } catch {}
  // Sort by last activity descending
  loops.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
  return loops
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
  const wcfg = await loadConfig()
  const providerId = wcfg.gitHost?.provider ?? "github"
  return c.json({
    userId,
    personalRepo: user.personalRepo ?? null,
    publicKey,
    imported,
    gitHost: {
      provider: providerId,
      baseUrl: wcfg.gitHost?.baseUrl ?? null,
      defaultRepo: wcfg.gitHost?.defaultRepo ?? "loopat-personal",
      tokenHelp: await providerTokenHelp(providerId),
    },
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

// POST /api/personal/github — onboard personal via a GitHub PAT (host-side
// only): create the repo, register the deploy key, clone + git-crypt. The PAT
// never enters a sandbox; runtime git uses the deploy key / vault. See
// docs/identity.md (integration contract).
app.post("/api/personal/github", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const user = await findUser(userId)
  if (!user) return c.json({ error: "user missing" }, 500)
  const body = await c.req.json().catch(() => ({}))
  const token = typeof body.token === "string" ? body.token.trim() : ""
  if (!token) return c.json({ error: "github token required" }, 400)
  const wcfg = await loadConfig()
  const repoName = (typeof body.repoName === "string" && body.repoName.trim()) || wcfg.gitHost?.defaultRepo || "loopat-personal"
  const baseUrl = (typeof body.baseUrl === "string" && body.baseUrl.trim() ? body.baseUrl.trim() : undefined) ?? wcfg.gitHost?.baseUrl
  const cryptKey = typeof body.cryptKey === "string" && body.cryptKey.trim() ? body.cryptKey.trim() : undefined
  const provider = (typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : undefined) ?? wcfg.gitHost?.provider ?? "github"
  const r = await setupPersonalViaProvider({ userId, provider, token, baseUrl, repoName, cryptKey })
  if (!r.ok) {
    if (r.needsCryptKey) return c.json({ error: r.error, needsCryptKey: true }, 409)
    return c.json({ error: r.error }, 400)
  }
  await setPersonalRepo(userId, r.repoUrl)
  return c.json({ ok: true, repo: r.repo, created: r.created, autoInitialized: !!r.autoInitialized, cryptKey: r.cryptKey ?? null })
})

// POST /api/personal/repos — list the user's repos for the onboarding picker.
// "personal"-named repos come first. Empty when the provider can't list.
app.post("/api/personal/repos", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const token = typeof body.token === "string" ? body.token.trim() : ""
  if (!token) return c.json({ ok: false, repos: [], error: "token required" })
  const wcfg = await loadConfig()
  const provider = (typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : undefined) ?? wcfg.gitHost?.provider ?? "github"
  const baseUrl = (typeof body.baseUrl === "string" && body.baseUrl.trim() ? body.baseUrl.trim() : undefined) ?? wcfg.gitHost?.baseUrl
  try {
    // Validate the token first so a bad token surfaces as an error in the token
    // step, instead of an empty (misleading "no repos") picker.
    const auth = await authenticateViaProvider({ provider, token, baseUrl })
    if (!auth.ok) return c.json({ ok: false, repos: [], error: auth.error })
    const repos = await listPersonalReposViaProvider({ provider, token, baseUrl })
    return c.json({ ok: true, repos, login: auth.login })
  } catch (e: any) {
    return c.json({ ok: false, repos: [], error: e?.message ?? String(e) })
  }
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
// If `force: true` is passed in the body, discards all local changes instead
// of stashing (for recovering from stash failures).
app.post("/api/personal/pull", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const body = await c.req.json().catch(() => ({}))
  const r = await pullPersonalFromRemote(userId, { force: !!body.force })
  if (!r.ok) {
    const status: Record<string, unknown> = { error: r.error }
    if (r.conflict) { status.conflict = true; status.files = r.files }
    if (r.needsStash) status.needsStash = true
    return c.json(status, r.conflict ? 409 : 400)
  }
  return c.json({ ok: true, message: r.message })
})

// Push to remote. Commits, rebases onto origin (held back on real conflict),
// then ff-pushes.
app.post("/api/personal/push", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const r = await pushPersonalToRemote(userId)
  if (!r.ok) {
    const status: Record<string, unknown> = { error: r.error }
    if (r.conflict) { status.conflict = true; status.files = r.files }
    if (r.needsPull) status.needsPull = true
    return c.json(status, (r.conflict || r.needsPull) ? 409 : 400)
  }
  return c.json({ ok: true, message: r.message })
})

// ── Workspace repo sync (knowledge / notes / repos/<name>) ──
// All ff-only. Any authenticated user may sync. Push to repos/<name> is
// not supported — code flows through PRs upstream, never from primary.

function syncDirFor(resource: string, name?: string): string | null {
  if (resource === "knowledge") return workspaceKnowledgeDir()
  if (resource === "notes") return workspaceNotesDir()
  if (resource === "repos" && name) {
    const dir = workspaceRepoDir(name)
    return existsSync(dir) ? dir : null
  }
  return null
}

app.get("/api/sync/knowledge/status", requireAuth, async (c) => c.json(await inspectRepoSync(workspaceKnowledgeDir())))
app.post("/api/sync/knowledge/pull", requireAuth, async (c) => {
  const r = await pullRepoFromRemote(workspaceKnowledgeDir())
  return r.ok ? c.json(r) : c.json({ error: r.error }, 400)
})
app.post("/api/sync/knowledge/push", requireAuth, async (c) => {
  const r = await pushRepoToRemote(workspaceKnowledgeDir())
  return r.ok ? c.json(r) : c.json({ error: r.error }, 400)
})

app.get("/api/sync/notes/status", requireAuth, async (c) => c.json(await inspectRepoSync(workspaceNotesDir())))
app.post("/api/sync/notes/pull", requireAuth, async (c) => {
  const r = await pullRepoFromRemote(workspaceNotesDir())
  return r.ok ? c.json(r) : c.json({ error: r.error }, 400)
})
app.post("/api/sync/notes/push", requireAuth, async (c) => {
  const r = await pushRepoToRemote(workspaceNotesDir())
  return r.ok ? c.json(r) : c.json({ error: r.error }, 400)
})

app.get("/api/sync/repos", requireAuth, async (c) => {
  // List repos available for sync (just names of subdirs of workspaceReposDir).
  try {
    const { readdir } = await import("node:fs/promises")
    const entries = await readdir(workspaceReposDir())
    const repos: string[] = []
    for (const e of entries) {
      if (e.startsWith(".")) continue
      if (existsSync(workspaceRepoDir(e) + "/.git")) repos.push(e)
    }
    return c.json({ repos })
  } catch {
    return c.json({ repos: [] })
  }
})
app.get("/api/sync/repos/:name/status", requireAuth, async (c) => {
  const dir = syncDirFor("repos", c.req.param("name"))
  if (!dir) return c.json({ error: "repo not found" }, 404)
  return c.json(await inspectRepoSync(dir))
})
app.post("/api/sync/repos/:name/pull", requireAuth, async (c) => {
  const dir = syncDirFor("repos", c.req.param("name"))
  if (!dir) return c.json({ error: "repo not found" }, 404)
  const r = await pullRepoFromRemote(dir)
  return r.ok ? c.json(r) : c.json({ error: r.error }, 400)
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

// Return the current user's `default_profiles` from
// personal/<u>/.loopat/config.json. Used by NewLoopDialog to pre-check the
// user's typical setup. Returns [] if config absent / field missing.
app.get("/api/personal/default-profiles", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const { existsSync } = await import("node:fs")
  const { readFile } = await import("node:fs/promises")
  const { personalLoopatConfigPath } = await import("./paths")
  const path = personalLoopatConfigPath(userId)
  if (!existsSync(path)) return c.json({ default_profiles: [] })
  try {
    const j = JSON.parse(await readFile(path, "utf8"))
    const arr = Array.isArray(j?.default_profiles)
      ? j.default_profiles.filter((x: unknown): x is string => typeof x === "string")
      : []
    return c.json({ default_profiles: arr })
  } catch {
    return c.json({ default_profiles: [] })
  }
})

app.put("/api/personal/default-profiles", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const { existsSync } = await import("node:fs")
  const { readFile, writeFile, mkdir: mk } = await import("node:fs/promises")
  const { dirname } = await import("node:path")
  const { personalLoopatConfigPath } = await import("./paths")
  const body = await c.req.json().catch(() => ({}))
  if (!Array.isArray(body.default_profiles)) return c.json({ error: "default_profiles must be an array" }, 400)
  const path = personalLoopatConfigPath(userId)
  let cfg: Record<string, any> = {}
  if (existsSync(path)) {
    try { cfg = JSON.parse(await readFile(path, "utf8")) } catch { cfg = {} }
  }
  cfg.default_profiles = body.default_profiles.filter((x: unknown): x is string => typeof x === "string")
  try {
    await mk(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(cfg, null, 2) + "\n")
    return c.json({ ok: true })
  } catch (e: any) {
    return c.json({ error: e?.message ?? "save failed" }, 500)
  }
})

// List available profiles in `<LOOPAT_HOME>/context/profiles/`. Each profile
// is a directory with a profile.json. Returns name + description so the UI
// can render a multi-select. Base profile is included if present — UI may
// choose to render it as "always on" / non-toggleable.
/**
 * Compute totals for a hypothetical loop with the given profile selection.
 * Team layer is always implicit. Used by NewLoopDialog to show "23 plugins ·
 * 7 skills · ..." preview before the user creates the loop.
 *
 * Reads .claude/ dirs of team + selected profiles + each enabled plugin
 * (host-installed cache OR local marketplace source).
 */
app.get("/api/loop-stats", requireAuth, async (c) => {
  const { computeLoopStats } = await import("./loop-stats")
  const profilesParam = c.req.query("profiles") ?? ""
  const profiles = profilesParam.split(",").map((s) => s.trim()).filter(Boolean)
  const stats = await computeLoopStats(profiles)
  return c.json(stats)
})

app.get("/api/profiles", requireAuth, async (c) => {
  // Profile = a subdir of `.loopat/profiles/` with a `.claude/` inside.
  // No loopat-invented metadata file: `description` is pulled from the
  // profile's CLAUDE.md frontmatter `description:` field (preferred) or
  // its first heading (legacy fallback) — see extractProfileDescription.
  const { listProfiles } = await import("./profiles")
  const { extractProfileDescription } = await import("./tiers")
  const { workspaceProfileClaudeMdPath } = await import("./paths")
  const { existsSync } = await import("node:fs")
  const { readFile } = await import("node:fs/promises")
  const names = await listProfiles()
  const profiles = await Promise.all(names.map(async (name) => {
    const mdPath = workspaceProfileClaudeMdPath(name)
    const md = existsSync(mdPath) ? await readFile(mdPath, "utf8").catch(() => null) : null
    return { name, description: extractProfileDescription(md) ?? undefined }
  }))
  return c.json({ profiles })
})

app.post("/api/loops", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const body = await c.req.json().catch(() => ({}))
  const title = typeof body.title === "string" ? body.title : "untitled"
  const repo = typeof body.repo === "string" && body.repo.trim() ? body.repo.trim() : undefined
  // Profile model: `profiles` body field is an array of profile names (loaded
  // from `<LOOPAT_HOME>/context/profiles/<name>/`). The old `sandbox` body
  // field is silently ignored — UI's NewLoopDialog still sends it for
  // backward compat but it has no effect on the spawn flow.
  const profiles: string[] | undefined = Array.isArray(body.profiles)
    ? body.profiles.filter((s: unknown): s is string => typeof s === "string" && s.trim().length > 0)
    : undefined
  const vault = typeof body.vault === "string" && body.vault.trim() ? body.vault.trim() : undefined
  const knowledgeRw = body.knowledge_rw === true
  const mountAllLoops = body.mount_all_loops === true
  if (mountAllLoops) {
    // Cross-loop view exposes every other loop's chats / workdir / meta.
    // Admin-only — checked server-side so a non-admin can't just POST the
    // flag by hand. (UI never offers the toggle outside the admin menu.)
    const me = await findUser(userId)
    if (!me || me.role !== "admin") {
      return c.json({ error: "mount_all_loops requires admin role" }, 403)
    }
  }
  try {
    const meta = await createLoop({ title, repo, createdBy: userId, profiles, vault, knowledgeRw, mountAllLoops })
    return c.json(meta)
  } catch (e: any) {
    return c.json({ error: e?.message ?? "create failed" }, 400)
  }
})

// Distill: spawn a child loop seeded with the source's conversation snapshot
// and a distill-kind project-tier CLAUDE.md. Any authenticated user may call;
// the source is read-only here.
app.post("/api/loops/:id/distill", requireAuth, async (c) => {
  const sourceId = c.req.param("id") ?? ""
  const userId = c.get("userId") as string
  try {
    const child = await distillLoop(sourceId, userId)
    return c.json(child)
  } catch (e: any) {
    const msg = e?.message ?? "distill failed"
    const code = /not found/i.test(msg) ? 404 : 400
    return c.json({ error: msg }, code)
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
  if (typeof body.title === "string") {
    const t = body.title.trim()
    if (!t) return c.json({ error: "title cannot be empty" }, 400)
    if (t.length > 200) return c.json({ error: "title too long (max 200)" }, 400)
    patch.title = t
  }
  // Share config fields
  if (typeof body.shareEnabled === "boolean") patch.shareEnabled = body.shareEnabled
  if (body.shareMode === "static" || body.shareMode === "port" || body.shareMode === "ephemeral") patch.shareMode = body.shareMode
  if (typeof body.shareAlias === "string") patch.shareAlias = body.shareAlias.trim() || undefined
  if (typeof body.sharePort === "number") patch.sharePort = body.sharePort
  if (typeof body.shareExternalPort === "number") patch.shareExternalPort = body.shareExternalPort
  if (body.shareProtocol === "tcp" || body.shareProtocol === "udp" || body.shareProtocol === "static") patch.shareProtocol = body.shareProtocol
  if (Object.keys(patch).length === 0) return c.json({ error: "no allowed fields" }, 400)
  const previous = await getLoop(id) // before patch (for old mode comparison)
  const updated = await patchLoopMeta(id, patch)
  const shareTouched =
    "shareEnabled" in patch || "shareExternalPort" in patch || "sharePort" in patch ||
    "shareProtocol" in patch || "shareMode" in patch
  if (shareTouched) {
    // Touch trigger for port-proxy (direct mode hot-reloads from inotify).
    try {
      const trigger = pathJoin(loopsDir(), ".port-proxy-trigger")
      await writeFile(trigger, String(Date.now())) // write ts to guarantee inotify Modify event
    } catch {}
    // Ephemeral mode: -p flags live on the loop container's create-args,
    // so the container itself must be recreated. Kill attached SDK + PTY;
    // the next attach calls ensureContainer, sees config-hash drift, and
    // recreates with the new `-p :<sharePort>` (kernel picks new host port).
    const wasEphemeral = previous && previous.shareEnabled && previous.shareMode === "ephemeral"
    const isEphemeral = updated && updated.shareEnabled && updated.shareMode === "ephemeral"
    const portChanged = previous && updated && previous.sharePort !== updated.sharePort
    const protoChanged = previous && updated && previous.shareProtocol !== updated.shareProtocol
    if (wasEphemeral || isEphemeral || (isEphemeral && (portChanged || protoChanged))) {
      destroyLoopSession(id)
      killTerm(id)
    }
  }
  // On archive: tear down the Claude SDK process and terminal PTY so no
  // orphaned processes linger. Un-archive is fine — next connect re-spawns.
  if (body.archived === true) {
    destroyLoopSession(id)
    killTerm(id)
  }
  return c.json(updated)
})

// Request For Drive: current driver releases control. Sandbox + terminal are
// torn down (on-disk history kept), and `rfdRequestedAt` is set so any other
// authenticated user can claim the loop via POST /:id/drive.
app.post("/api/loops/:id/request-drive", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  const userId = c.get("userId") as string
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "not found" }, 404)
  if (!isDriver(meta, userId)) return c.json({ error: "forbidden" }, 403)
  if (meta.archived) return c.json({ error: "loop is archived (read-only)" }, 409)
  if (meta.rfdRequestedAt) return c.json({ error: "already requested for drive" }, 409)
  const updated = await patchLoopMeta(id, {
    rfdRequestedAt: new Date().toISOString(),
    rfdRequestedBy: userId,
  })
  // Tear down what's running. .claude/, messages.jsonl, sandbox snapshot all
  // stay — the next driver resumes via --continue when they send a message.
  destroyLoopSession(id)
  killTerm(id)
  return c.json(updated)
})

// Drive: any authenticated user takes over an RFD'd loop. Lazy spawn — the
// sandbox respawns under the new driver's personal config on the next user
// message (ensureStarted picks up effectiveDriver). `pendingDriverNote` lets
// the model know about the handoff on the first message.
app.post("/api/loops/:id/drive", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  const userId = c.get("userId") as string
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "not found" }, 404)
  if (!meta.rfdRequestedAt) return c.json({ error: "not up for drive" }, 409)
  if (meta.archived) return c.json({ error: "loop is archived (read-only)" }, 409)
  const now = new Date().toISOString()
  const previous = effectiveDriver(meta)
  const history = [...(meta.driverHistory ?? []), { driver: userId, since: now }]
  const updated = await patchLoopMeta(id, {
    driver: userId,
    driverHistory: history,
    rfdRequestedAt: undefined,
    rfdRequestedBy: undefined,
    pendingDriverNote: { from: previous, to: userId, at: now },
  })
  // Repoint the personal mount before the next spawn. Idempotent.
  try { await ensureContextMounts(id, userId) } catch (e: any) {
    console.warn(`[loopat] /drive: ensureContextMounts failed for ${id}: ${e?.message ?? e}`)
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
  if (meta.archived) return c.json({ error: "loop is archived (read-only)" }, 409)
  if (meta.rfdRequestedAt) return c.json({ error: "loop is in RFD state — click Drive to take over" }, 409)
  if (!isDriver(meta, userId)) return c.json({ error: `only driver (${effectiveDriver(meta)}) can write` }, 403)
  const session = getSession(id)
  const r = await session.stripThinkingBlocks()
  return c.json(r)
})

/**
 * Read the live host port for an ephemeral-mode share. Returns null when
 * the container is down, not in ephemeral mode, or the mapping hasn't
 * been observed yet (e.g. container is still starting). The UI polls
 * this endpoint while the dialog is open so a fresh restart's new port
 * appears without the user reloading.
 */
app.get("/api/loops/:id/share/current-port", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "not found" }, 404)
  if (!meta.shareEnabled || meta.shareMode !== "ephemeral" || !meta.sharePort) {
    return c.json({ port: null })
  }
  const proto: "tcp" | "udp" = meta.shareProtocol === "udp" ? "udp" : "tcp"
  const port = await getEphemeralHostPort(id, meta.sharePort, proto)
  return c.json({ port, internalPort: meta.sharePort, protocol: proto })
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

app.get("/api/loops/:id/files", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  if (!(await loopExists(id))) return c.json({ error: "not found" }, 404)
  const path = c.req.query("path") ?? ""
  return c.json({ entries: await listDir(id, path) })
})

// Recursive file tree — single call returns all files under a path.
// The frontend FilePicker uses this instead of recursively calling /files.
app.get("/api/loops/:id/files/tree", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  if (!(await loopExists(id))) return c.json({ error: "not found" }, 404)
  const path = c.req.query("path") ?? ""
  return c.json({ entries: await listDirRecursive(id, path) })
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
  const userId = c.get("userId") as string
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "not found" }, 404)
  if (meta.archived) return c.json({ error: "loop is archived (read-only)" }, 409)
  if (meta.rfdRequestedAt) return c.json({ error: "loop is in RFD state — click Drive to take over" }, 409)
  if (!isDriver(meta, userId)) return c.json({ error: `only driver (${effectiveDriver(meta)}) can write` }, 403)
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
  const userId = c.get("userId") as string
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "not found" }, 404)
  if (meta.archived) return c.json({ error: "loop is archived (read-only)" }, 409)
  if (meta.rfdRequestedAt) return c.json({ error: "loop is in RFD state — click Drive to take over" }, 409)
  if (!isDriver(meta, userId)) return c.json({ error: `only driver (${effectiveDriver(meta)}) can write` }, 403)
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
  const userId = c.get("userId") as string
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "not found" }, 404)
  if (meta.archived) return c.json({ error: "loop is archived (read-only)" }, 409)
  if (meta.rfdRequestedAt) return c.json({ error: "loop is in RFD state — click Drive to take over" }, 409)
  if (!isDriver(meta, userId)) return c.json({ error: `only driver (${effectiveDriver(meta)}) can write` }, 403)
  const path = c.req.query("path") ?? ""
  if (!path) return c.json({ error: "path required" }, 400)
  const ok = await deleteWorkdirFile(id, path)
  if (!ok) return c.json({ error: "delete failed" }, 500)
  return c.json({ ok: true })
})

app.post("/api/loops/:id/folder", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  const userId = c.get("userId") as string
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "not found" }, 404)
  if (meta.archived) return c.json({ error: "loop is archived (read-only)" }, 409)
  if (meta.rfdRequestedAt) return c.json({ error: "loop is in RFD state — click Drive to take over" }, 409)
  if (!isDriver(meta, userId)) return c.json({ error: `only driver (${effectiveDriver(meta)}) can write` }, 403)
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.path !== "string" || !body.path) return c.json({ error: "path required" }, 400)
  const ok = await createWorkdirFolder(id, body.path)
  if (!ok) return c.json({ error: "mkdir failed" }, 500)
  return c.json({ ok: true })
})

// ── chat history ──
app.get("/api/loops/:id/chat-history", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "not found" }, 404)
  const path = loopChatHistoryPath(id)
  if (!existsSync(path)) return c.json([])
  const raw = await Bun.file(path).text()
  const lines = raw.split("\n").filter(Boolean)
  const entries = lines.map((l) => {
    try { return JSON.parse(l) } catch { return null }
  }).filter((e): e is NonNullable<typeof e> => e !== null)
  return c.json(entries)
})

app.post("/api/loops/:id/chat-history", requireAuth, async (c) => {
  const id = c.req.param("id") ?? ""
  const userId = c.get("userId") as string
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "not found" }, 404)
  if (meta.archived) return c.json({ error: "loop is archived (read-only)" }, 409)
  if (meta.rfdRequestedAt) return c.json({ error: "loop is in RFD state — click Drive to take over" }, 409)
  if (!isDriver(meta, userId)) return c.json({ error: `only driver (${effectiveDriver(meta)}) can write` }, 403)
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.text !== "string" || !body.text.trim()) return c.json({ error: "text required" }, 400)
  const path = loopChatHistoryPath(id)
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, JSON.stringify({ text: body.text.trim(), ts: Date.now() }) + "\n")
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
  const userId = c.get("userId") as string
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "not found" }, 404)
  if (meta.archived) return c.json({ error: "loop is archived (read-only)" }, 409)
  if (meta.rfdRequestedAt) return c.json({ error: "loop is in RFD state — click Drive to take over" }, 409)
  if (!isDriver(meta, userId)) return c.json({ error: `only driver (${effectiveDriver(meta)}) can write` }, 403)
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
  const userId = c.get("userId") as string
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "not found" }, 404)
  if (meta.archived) return c.json({ error: "loop is archived (read-only)" }, 409)
  if (meta.rfdRequestedAt) return c.json({ error: "loop is in RFD state — click Drive to take over" }, 409)
  if (!isDriver(meta, userId)) return c.json({ error: `only driver (${effectiveDriver(meta)}) can write` }, 403)
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
  const userId = c.get("userId") as string
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "not found" }, 404)
  if (meta.archived) return c.json({ error: "loop is archived (read-only)" }, 409)
  if (meta.rfdRequestedAt) return c.json({ error: "loop is in RFD state — click Drive to take over" }, 409)
  if (!isDriver(meta, userId)) return c.json({ error: `only driver (${effectiveDriver(meta)}) can write` }, 403)
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

// notes is edited through a per-user UI-loop worktree (a no-AI UI loop); make
// sure it exists (opened from origin/main) before any read/write resolves it.
async function ensureVaultReady(vault: string, user: string): Promise<void> {
  if (vault === "notes") await ensureUiNotesWorktree(user)
}

app.get("/api/workspace/files", requireAuth, async (c) => {
  const vault = c.req.query("vault") ?? ""
  if (!VAULTS.has(vault)) return c.json({ error: "invalid vault" }, 400)
  const userId = c.get("userId") as string
  const path = c.req.query("path") ?? ""
  await ensureVaultReady(vault, userId)
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
  await ensureVaultReady(vault, userId)
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
  await ensureVaultReady(vault, userId)
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
  await ensureVaultReady(vault, userId)
  const r = await vaultCreateFile(vault as VaultId, body.path, userId)
  if (!r.ok) return c.json({ error: r.error }, r.error === "exists" ? 409 : 500)
  return c.json({ ok: true })
})

// Save = land this user's notes edits on origin/main (the no-AI UI loop).
// Explicit: the user clicks save. ff-only + rebase; a real conflict is held back.
app.post("/api/notes/save", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const r = await syncUiNotes(userId)
  if (!r.ok) {
    const status: Record<string, unknown> = { error: r.error }
    if (r.conflict) { status.conflict = true; status.files = r.files }
    if (r.needsPull) status.needsPull = true
    return c.json(status, (r.conflict || r.needsPull) ? 409 : 400)
  }
  return c.json({ ok: true, message: r.message })
})

// How many commits the user's notes are behind origin (drives the "remote
// updated" hint). Polled lightly by the client; no push.
app.get("/api/notes/behind", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  return c.json({ behind: await notesBehind(userId) })
})

// Refresh = ff-pull origin/main into the user's notes worktree. Diverged (local
// unsaved edits) is not an error — the client just keeps its draft.
app.post("/api/notes/refresh", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const r = await ffUpdateUiNotes(userId)
  if (!r.ok) return c.json({ ok: false, diverged: r.diverged ?? false, error: r.error }, r.diverged ? 200 : 400)
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

// Register a new repo. Body: { name, source } where source is a git URL
// (cloned) or a local path (symlinked).
app.post("/api/workspace/repos", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const source = typeof body.source === "string" ? body.source : ""
  const name = typeof body.name === "string" ? body.name : ""
  const r = await addRepo({ name, source })
  if (!r.ok) return c.json({ error: r.error }, 400)
  return c.json({ ok: true, name: r.name, kind: r.kind })
})

// /api/sandboxes/* routes removed — sandbox concept replaced by profiles
// (post-2026-05). Profile management uses /api/profiles + per-profile
// .claude/settings.json edited via CC's own commands (cd .loopat/profiles/<n>
// && claude plugin install --scope=project ...).

app.get("/api/workspace/repo/:name", requireAuth, async (c) => {
  const name = c.req.param("name") ?? ""
  const detail = await readRepoDetail(name)
  if (!detail) return c.json({ error: "not found" }, 404)
  // recent loops on this repo
  const loops = await listLoops()
  const recent = loops.filter((l) => (l as any).repo === name).slice(0, 8)
  return c.json({ ...detail, recentLoops: recent })
})

// `git pull --ff-only` in the repo. Fast-forward only — diverged branches
// surface as an error so the user resolves them in their own checkout.
app.post("/api/workspace/repo/:name/pull", requireAuth, async (c) => {
  const name = c.req.param("name") ?? ""
  const r = await pullRepo(name)
  if (!r.ok) return c.json({ error: r.error }, 400)
  return c.json({ ok: true, output: r.output })
})

// ── topics ──

// ── kanban: focus boards (one directory per board, one .md file per column) ──
// Kanban edits go through the editing user's notes worktree (a per-user UI
// loop): carry the user via AsyncLocalStorage + ensure the worktree exists.
// Changes reach origin through the explicit notes save (/api/notes/save).
app.use("/api/kanban/*", requireAuth, async (c, next) => {
  const userId = c.get("userId") as string
  await ensureUiNotesWorktree(userId)
  return kanbanUserCtx.run(userId, () => next())
})

// Board management
app.get("/api/kanban/boards", requireAuth, async (c) => {
  const boards = await listBoards()
  return c.json({ boards })
})

app.post("/api/kanban/boards", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.name !== "string" || !body.name.trim()) {
    return c.json({ error: "name required" }, 400)
  }
  const ok = await createBoard(body.name.trim())
  if (!ok) return c.json({ error: "create failed" }, 500)
  return c.json({ ok: true })
})

app.put("/api/kanban/boards/:name/rename", requireAuth, async (c) => {
  const oldName = decodeURIComponent(c.req.param("name") ?? "")
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.name !== "string" || !body.name.trim()) {
    return c.json({ error: "name required" }, 400)
  }
  const ok = await renameBoard(oldName, body.name.trim())
  if (!ok) return c.json({ error: "rename failed" }, 500)
  return c.json({ ok: true })
})

// Column management
app.post("/api/kanban/columns/:board", requireAuth, async (c) => {
  const board = decodeURIComponent(c.req.param("board") ?? "default")
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.filename !== "string" || !body.filename.trim()) {
    return c.json({ error: "filename required" }, 400)
  }
  const ok = await createColumn(board, body.filename + (body.filename.endsWith(".md") ? "" : ".md"), body.title)
  if (!ok) return c.json({ error: "create failed" }, 500)
  kanbanNotify()
  return c.json({ ok: true })
})

app.put("/api/kanban/columns/:board/:filename/rename", requireAuth, async (c) => {
  const board = decodeURIComponent(c.req.param("board") ?? "default")
  const fromFile = decodeURIComponent(c.req.param("filename") ?? "")
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.toFile !== "string" || !body.toFile.trim()) {
    return c.json({ error: "toFile required" }, 400)
  }
  const ok = await renameColumn(board, fromFile, body.toFile + (body.toFile.endsWith(".md") ? "" : ".md"))
  if (!ok) return c.json({ error: "rename failed" }, 500)
  kanbanNotify()
  return c.json({ ok: true })
})

app.delete("/api/kanban/columns/:board/:filename", requireAuth, async (c) => {
  const board = decodeURIComponent(c.req.param("board") ?? "default")
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const ok = await deleteColumn(board, filename)
  if (!ok) return c.json({ error: "delete failed" }, 500)
  kanbanNotify()
  return c.json({ ok: true })
})

app.put("/api/kanban/columns/:board/:filename/color", requireAuth, async (c) => {
  const board = decodeURIComponent(c.req.param("board") ?? "default")
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.color !== "string") return c.json({ error: "color required" }, 400)
  await setColumnColor(board, filename, body.color)
  kanbanNotify()
  return c.json({ ok: true })
})

app.put("/api/kanban/columns/:board/:filename/reorder", requireAuth, async (c) => {
  const board = decodeURIComponent(c.req.param("board") ?? "default")
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const body = await c.req.json().catch(() => ({}))
  if (!Array.isArray(body.cids)) return c.json({ error: "cids array required" }, 400)
  const ok = await reorderCards(board, filename, body.cids)
  if (!ok) return c.json({ error: "reorder failed" }, 500)
  kanbanNotify()
  return c.json({ ok: true })
})

// Card mutations
app.post("/api/kanban/columns/:board/:filename/cards", requireAuth, async (c) => {
  const board = decodeURIComponent(c.req.param("board") ?? "default")
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.text !== "string" || !body.text.trim()) {
    return c.json({ error: "text required" }, 400)
  }
  const r = await addCard(board, filename, body)
  if (!r.ok) return c.json({ error: "add failed" }, 500)
  kanbanNotify()
  return c.json({ cid: r.cid })
})

app.patch("/api/kanban/columns/:board/:filename/cards/:cid/toggle", requireAuth, async (c) => {
  const board = decodeURIComponent(c.req.param("board") ?? "default")
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const cid = c.req.param("cid") ?? ""
  const ok = await toggleCard(board, filename, cid)
  if (!ok) return c.json({ error: "not found" }, 404)
  kanbanNotify()
  return c.json({ ok: true })
})

app.patch("/api/kanban/columns/:board/:filename/cards/:cid", requireAuth, async (c) => {
  const board = decodeURIComponent(c.req.param("board") ?? "default")
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const cid = c.req.param("cid") ?? ""
  const patch = await c.req.json().catch(() => ({}))
  const ok = await updateCardMeta(board, filename, cid, patch)
  if (!ok) return c.json({ error: "not found or patch failed" }, 404)
  kanbanNotify()
  return c.json({ ok: true })
})

app.put("/api/kanban/columns/:board/:filename/cards/:cid/block", requireAuth, async (c) => {
  const board = decodeURIComponent(c.req.param("board") ?? "default")
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const cid = c.req.param("cid") ?? ""
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.block !== "string") return c.json({ error: "block required" }, 400)
  const ok = await updateCardBlock(board, filename, cid, body.block)
  if (!ok) return c.json({ error: "not found" }, 404)
  kanbanNotify()
  return c.json({ ok: true })
})

app.delete("/api/kanban/columns/:board/:filename/cards/:cid", requireAuth, async (c) => {
  const board = decodeURIComponent(c.req.param("board") ?? "default")
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const cid = c.req.param("cid") ?? ""
  const ok = await deleteCard(board, filename, cid)
  if (!ok) return c.json({ error: "not found" }, 404)
  kanbanNotify()
  return c.json({ ok: true })
})

app.post("/api/kanban/columns/:board/:filename/cards/:cid/move", requireAuth, async (c) => {
  const board = decodeURIComponent(c.req.param("board") ?? "default")
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const cid = c.req.param("cid") ?? ""
  const body = await c.req.json().catch(() => ({}))
  if (typeof body.toFile !== "string") return c.json({ error: "toFile required" }, 400)
  const ok = await moveCard(board, filename, cid, body.toFile, body.toIndex)
  if (!ok) return c.json({ error: "move failed" }, 500)
  kanbanNotify()
  return c.json({ ok: true })
})

app.post("/api/kanban/columns/:board/:filename/cards/:cid/assign-driver", requireAuth, async (c) => {
  const board = decodeURIComponent(c.req.param("board") ?? "default")
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const cid = c.req.param("cid") ?? ""
  const userId = c.get("userId") as string
  const r = await assignDriverForCard(board, filename, cid, userId)
  if (!r.ok) return c.json({ error: "no associated loop" }, 400)
  return c.json(r)
})

app.post("/api/kanban/columns/:board/:filename/cards/:cid/create-loop", requireAuth, async (c) => {
  const board = decodeURIComponent(c.req.param("board") ?? "default")
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const cid = c.req.param("cid") ?? ""
  const userId = c.get("userId") as string
  const r = await createLoopFromCard(board, filename, cid, userId)
  if (!r.ok) return c.json({ error: "create failed" }, 500)
  return c.json(r)
})

app.post("/api/kanban/columns/:board/:filename/cards/:cid/link-loop", requireAuth, async (c) => {
  const board = decodeURIComponent(c.req.param("board") ?? "default")
  const filename = decodeURIComponent(c.req.param("filename") ?? "")
  const cid = c.req.param("cid") ?? ""
  const userId = c.get("userId") as string
  const { loopId } = (await c.req.json().catch(() => ({}))) as { loopId?: string }
  if (!loopId) return c.json({ error: "loopId required" }, 400)
  const ok = await linkLoopToCard(board, filename, cid, loopId, userId)
  if (!ok) return c.json({ error: "link failed" }, 500)
  return c.json({ ok: true })
})

// Board data (list columns + config)
app.get("/api/kanban/:board", requireAuth, async (c) => {
  const board = decodeURIComponent(c.req.param("board") ?? "default")
  const columns = await listKanbanColumns(board)
  return c.json({ columns })
})

app.get("/api/kanban/config/:board", requireAuth, async (c) => {
  const board = decodeURIComponent(c.req.param("board") ?? "default")
  const cfg = await readKanbanConfig(board)
  return c.json(cfg ?? { columns: [] })
})

app.put("/api/kanban/config/:board", requireAuth, async (c) => {
  const board = decodeURIComponent(c.req.param("board") ?? "default")
  const body = await c.req.json().catch(() => ({}))
  if (Array.isArray(body.columns)) {
    await saveColumnOrder(board, body.columns)
    kanbanNotify()
  }
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
    // Read client dimensions from query params so we can resize the PTY
    // before replaying scrollback — avoids displaying 80×24 content on a
    // larger terminal, which misplaces the cursor.
    const qCols = parseInt(c.req.query("cols") || "0")
    const qRows = parseInt(c.req.query("rows") || "0")
    let attachedTerm: any = null
    return {
      async onOpen(_e, ws) {
        attachedTerm = ws
        try {
          if (qCols > 0 && qRows > 0) {
            await attachTerm(id, ws, qCols, qRows)
          } else {
            await attachTerm(id, ws)
          }
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
          if (meta?.rfdRequestedAt) {
            try { ws.send(JSON.stringify({ type: "error", message: "loop is in RFD state — click Drive to take over" })) } catch {}
            return
          }
          if (meta && userId && !isDriver(meta, userId)) {
            try { ws.send(JSON.stringify({ type: "error", message: `only driver (${effectiveDriver(meta)}) can write` })) } catch {}
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
        if (meta?.rfdRequestedAt) {
          try { ws.send(JSON.stringify({ type: "error", message: "loop is in RFD state — click Drive to take over" })) } catch {}
          return
        }
        if (meta && userId && !isDriver(meta, userId)) {
          try { ws.send(JSON.stringify({ type: "error", message: `only driver (${effectiveDriver(meta)}) can write` })) } catch {}
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
            // /goal: extract goal, persist to meta, set on session.
            // Rewrite the text so CC sees a natural-language message instead
            // of an unrecognized slash command.
            const goalMatch = msg.text.match(/^\/goal\s+(.+)/)
            if (goalMatch) {
              const goal = goalMatch[1].trim()
              const setAt = new Date().toISOString()
              session.setGoal(goal, setAt)
              patchLoopMeta(id, { config: { ...(meta?.config ?? {}), goal, goalSetAt: setAt, goalStatus: "active" } }).catch(() => {})
              msg.text = `My goal is: ${goal}`
            }
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
          } else if (msg?.type === "set_goal") {
            const goal = typeof msg.goal === "string" && msg.goal.trim() ? msg.goal.trim() : null
            const setAt = goal ? new Date().toISOString() : undefined
            session.setGoal(goal, setAt)
            patchLoopMeta(id, { config: { ...(meta?.config ?? {}), goal: goal ?? undefined, goalSetAt: setAt ?? undefined, goalStatus: goal ? "active" : undefined } }).catch(() => {})
          } else if (msg?.type === "complete_goal") {
            session.completeGoal()
            patchLoopMeta(id, { config: { ...(meta?.config ?? {}), goalStatus: "completed" } }).catch(() => {})
          } else if (msg?.type === "provider_select" && typeof msg.provider === "string") {
            const ok = session.setProvider(msg.provider)
            if (ok) {
              const source = msg.source === "personal" || msg.source === "workspace" ? msg.source : undefined
              const selectedModel = typeof msg.model === "string" ? msg.model : undefined
              // Persist to loop meta so it survives reloads
              patchLoopMeta(id, { config: { default_model: msg.provider, default_model_source: source, ...(selectedModel ? { default_model_id: selectedModel } : {}) } }).catch(() => {})
              try {
                // Resolve provider info: personal first, then workspace fallback.
                let p: ProviderConfig | undefined
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
                  const activeModel = selectedModel ?? p.models.find(m => m.enabled !== false)?.id ?? p.models[0]?.id ?? ""
                  const activeModelEntry = p.models.find(m => m.id === activeModel)
                  const ctxWindow = activeModelEntry?.maxContextTokens && activeModelEntry.maxContextTokens > 0
                    ? activeModelEntry.maxContextTokens
                    : p.maxContextTokens && p.maxContextTokens > 0
                      ? p.maxContextTokens
                      : 200_000
                  ws.send(JSON.stringify({
                    type: "provider",
                    name: msg.provider,
                    model: activeModel,
                    models: p.models,
                    contextWindow: ctxWindow,
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

const port = Number(process.env.PORT ?? 10001)
const hostname = process.env.HOST ?? "127.0.0.1"

// Fast, serve-critical init only — keep this short so the port opens quickly.
await ensureWorkspaceDirs()
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

// Open the port NOW, before the slow boot work below (mount backfill, podman
// probe, container prewarm). Otherwise the vite dev proxy hits ECONNREFUSED
// during the seconds those awaits run. The rest boots while we're listening.
const server = Bun.serve({
  port,
  hostname,
  fetch: app.fetch,
  websocket,
})
console.log(`[loopat] server listening on http://${hostname}:${port}`)
console.log(`[loopat] workspace serve starting via podman container (port ${process.env.LOOPAT_SERVE_PORT ?? "7788"})`)

await printBootstrapBanner(cfg)
const backfilled = await backfillAllMounts()
if (backfilled > 0) console.log(`[loopat] backfilled context mounts on ${backfilled} loop(s)`)

// host-cli proxy: a unix socket the loop sandboxes mount + forward to, so
// host-only clis (macOS / machine-bound) run on the host on behalf of a loop.
try {
  const sock = join(LOOPAT_HOME, "host-exec.sock")
  serveHostExec(sock, { loopExists })
  console.log(`[loopat] host-exec socket: ${sock}`)
} catch (e: any) {
  console.warn(`[loopat] host-exec socket failed: ${e?.message ?? e}`)
}

// Pull every imported personal repo from its remote on boot (best-effort).
// personal is a per-user repo synced directly (not via loops), so a host that
// was offline catches up here; settings edits then write-through on save.
void (async () => {
  try {
    for (const u of await listUsers()) {
      if (await isPersonalFresh(u.id)) continue // not imported yet — nothing to pull
      const r = await pullPersonalFromRemote(u.id).catch(() => null)
      if (r && !r.ok) console.warn(`[loopat] boot pull personal (${u.id}): ${r.error}`)
    }
  } catch (e: any) {
    console.warn(`[loopat] boot personal pull-all failed: ${e?.message ?? e}`)
  }
})()

// Probe podman availability up front so misconfigured hosts fail loudly on
// boot rather than mid-session.
import { probePodman, stopAllWorkspaceContainers, ensureServeContainer, ensurePortProxyContainer } from "./podman"
const podmanProbe = await probePodman()
if (podmanProbe.ok) {
  console.log(`[loopat] sandbox runtime: ${podmanProbe.version}`)
  // Start workspace serve in a container on the shared bridge network.
  ensureServeContainer().catch((e) => {
    console.warn(`[loopat] serve container failed: ${e?.message ?? e}`)
  })
  ensurePortProxyContainer().catch((e) => {
    console.warn(`[loopat] port-proxy container failed: ${e?.message ?? e}`)
  })
} else {
  console.warn(`[loopat] sandbox runtime: NOT AVAILABLE — ${podmanProbe.hint}`)
  console.warn(`[loopat] chat / terminal will fail until podman is installed.`)
}

// On graceful shutdown, stop every loopat-managed container so the host
// isn't left with orphaned sandbox processes after the server dies.
const stopAllOnExit = async () => {
  try {
    await stopAllWorkspaceContainers()
  } catch (e: any) {
    console.warn(`[loopat] stop-all on exit failed: ${e?.message ?? e}`)
  }
}
process.on("SIGINT", () => { void stopAllOnExit().finally(() => process.exit(0)) })
process.on("SIGTERM", () => { void stopAllOnExit().finally(() => process.exit(0)) })

// Plugin caching is delegated to CC itself — admin uses `claude plugin
// install` inside each sandbox's .claude/ dir. No loopat-side prewarm.

export { server }
