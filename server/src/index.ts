import { Hono } from "hono"
import { cors } from "hono/cors"
import { createBunWebSocket } from "hono/bun"
import { existsSync } from "node:fs"
import { listLoops, createLoop, getLoop, loopExists, patchLoopMeta, backfillAllMounts, ensureWorkspaceDirs, provisionUserPersonal } from "./loops"
import { getSession } from "./session"
import { listDir, readWorkdirFile, writeWorkdirFile } from "./files"
import { vaultList, vaultFlatList, vaultRead, vaultWrite, vaultCreateFile, vaultBacklinks, listRepos, readRepoDetail, readFocusData, type VaultId } from "./workspace"
import { attachTerm, detachTerm, writeTerm, resizeTerm } from "./term"
import {
  LOOPAT_HOME,
  WORKSPACE,
  loopContextKnowledge,
  loopContextNotes,
  loopContextPersonal,
  loopContextRepos,
} from "./paths"
import { loadConfig, loadPersonalConfig, getActiveProvider, type ProviderConfig } from "./config"
import { printBootstrapBanner } from "./bootstrap"
import {
  createUser,
  findUser,
  verifyPassword,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  getRequestUserId,
  requireAuth,
  COOKIE_NAME,
  isValidUsername,
} from "./auth"
import { getCookie } from "hono/cookie"

const { upgradeWebSocket, websocket } = createBunWebSocket()

type Variables = { userId: string }
const app = new Hono<{ Variables: Variables }>()

app.use("/api/*", cors({ origin: (o) => o ?? "*", credentials: true }))

// public routes
app.get("/api/health", (c) => c.json({ ok: true, loopatHome: LOOPAT_HOME, workspace: WORKSPACE }))

// ── providers (public) ──
// Merges personal + workspace configs. Personal providers take precedence
// (they carry per-user apiKeys via secrets/). Source field indicates origin.
app.get("/api/providers", async (c) => {
  const wCfg = await loadConfig()
  const providers: Record<string, { model: string; baseUrl: string; source: "personal" | "workspace" }> = {}
  // Start with workspace providers (workspace config historically carries
  // providers on disk even though the TS type was split)
  const wp = (wCfg as any).providers as Record<string, { model: string; baseUrl: string }> | undefined
  if (wp) {
    for (const [name, p] of Object.entries(wp)) {
      providers[name] = { model: p.model, baseUrl: p.baseUrl, source: "workspace" }
    }
  }
  // Overlay personal providers (they take precedence)
  const wDefault = (wCfg as any).default as string | undefined
  let active = wDefault ?? ""
  const userId = getRequestUserId(c)
  if (userId) {
    try {
      const pCfg = await loadPersonalConfig(userId)
      for (const [name, p] of Object.entries(pCfg.providers)) {
        providers[name] = { model: p.model, baseUrl: p.baseUrl, source: "personal" }
      }
      active = pCfg.default || active
    } catch {}
  }
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
    // best-effort: clone personalRepo if given, fall back to empty git-init'd dir
    await provisionUserPersonal(user.id, user.personalRepo)
    const token = createSession(user.id)
    setSessionCookie(c, token)
    return c.json({ user: { id: user.id } })
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
  const token = createSession(user.id)
  setSessionCookie(c, token)
  return c.json({ user: { id: user.id } })
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
  return c.json({ user: { id: userId } })
})

// All non-auth /api/* routes below are publicly readable; writes go through
// requireAuth (per-route). Anonymous reads can NOT touch personal data: the
// personal vault and any loop path under context/personal are blocked.

function isPersonalLoopPath(path: string): boolean {
  return path === "context/personal" || path.startsWith("context/personal/")
}

app.get("/api/loops", async (c) => {
  // ?archived=true → only archived; ?archived=all → both; default → hide archived
  const filter = c.req.query("archived") ?? ""
  const all = await listLoops()
  let loops = all
  if (filter === "true") loops = all.filter((m) => m.archived === true)
  else if (filter === "all") loops = all
  else loops = all.filter((m) => m.archived !== true)
  return c.json({ loops })
})

app.post("/api/loops", requireAuth, async (c) => {
  const userId = c.get("userId") as string
  const body = await c.req.json().catch(() => ({}))
  const title = typeof body.title === "string" ? body.title : "untitled"
  const repo = typeof body.repo === "string" && body.repo.trim() ? body.repo.trim() : undefined
  try {
    const meta = await createLoop({ title, repo, createdBy: userId })
    return c.json(meta)
  } catch (e: any) {
    return c.json({ error: e?.message ?? "create failed" }, 400)
  }
})

app.get("/api/loops/:id", async (c) => {
  const id = c.req.param("id") ?? ""
  const meta = await getLoop(id)
  if (!meta) return c.json({ error: "not found" }, 404)
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
  if (Object.keys(patch).length === 0) return c.json({ error: "no allowed fields" }, 400)
  const updated = await patchLoopMeta(id, patch)
  return c.json(updated)
})

app.get("/api/loops/:id/context", async (c) => {
  const id = c.req.param("id") ?? ""
  if (!(await loopExists(id))) return c.json({ error: "not found" }, 404)
  const mounts: { name: string; path: string }[] = []
  if (existsSync(loopContextKnowledge(id))) mounts.push({ name: "knowledge", path: "context/knowledge" })
  if (existsSync(loopContextNotes(id))) mounts.push({ name: "notes", path: "context/notes" })
  if (existsSync(loopContextPersonal(id))) mounts.push({ name: "personal", path: "context/personal" })
  if (existsSync(loopContextRepos(id))) mounts.push({ name: "repos", path: "context/repos" })
  return c.json({ mounts })
})

app.get("/api/loops/:id/files", async (c) => {
  const id = c.req.param("id") ?? ""
  if (!(await loopExists(id))) return c.json({ error: "not found" }, 404)
  const path = c.req.query("path") ?? ""
  if (isPersonalLoopPath(path) && !getRequestUserId(c)) {
    return c.json({ error: "login required" }, 401)
  }
  return c.json({ entries: await listDir(id, path) })
})

app.get("/api/loops/:id/file", async (c) => {
  const id = c.req.param("id") ?? ""
  if (!(await loopExists(id))) return c.json({ error: "not found" }, 404)
  const path = c.req.query("path") ?? ""
  if (!path) return c.json({ error: "path required" }, 400)
  if (isPersonalLoopPath(path) && !getRequestUserId(c)) {
    return c.json({ error: "login required" }, 401)
  }
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

// Workspace vault APIs (Context tab)
const VAULTS = new Set(["knowledge", "notes", "personal", "repos"])

app.get("/api/workspace/files", async (c) => {
  const vault = c.req.query("vault") ?? ""
  if (!VAULTS.has(vault)) return c.json({ error: "invalid vault" }, 400)
  const userId = getRequestUserId(c)
  if (vault === "personal" && !userId) return c.json({ error: "login required" }, 401)
  const path = c.req.query("path") ?? ""
  if (c.req.query("flat") === "1") {
    return c.json({ entries: await vaultFlatList(vault as VaultId, userId ?? "") })
  }
  return c.json({ entries: await vaultList(vault as VaultId, path, userId ?? "") })
})

app.get("/api/workspace/file", async (c) => {
  const vault = c.req.query("vault") ?? ""
  if (!VAULTS.has(vault)) return c.json({ error: "invalid vault" }, 400)
  const userId = getRequestUserId(c)
  if (vault === "personal" && !userId) return c.json({ error: "login required" }, 401)
  const path = c.req.query("path") ?? ""
  if (!path) return c.json({ error: "path required" }, 400)
  const r = await vaultRead(vault as VaultId, path, userId ?? "")
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

app.get("/api/workspace/backlinks", async (c) => {
  const vault = c.req.query("vault") ?? ""
  if (!VAULTS.has(vault)) return c.json({ error: "invalid vault" }, 400)
  const userId = getRequestUserId(c)
  if (vault === "personal" && !userId) return c.json({ error: "login required" }, 401)
  const path = c.req.query("path") ?? ""
  if (!path) return c.json({ backlinks: [] })
  return c.json({ backlinks: await vaultBacklinks(vault as VaultId, path, userId ?? "") })
})

app.get("/api/workspace/repos", async (c) => {
  return c.json({ repos: await listRepos() })
})

app.get("/api/workspace/repo/:name", async (c) => {
  const name = c.req.param("name") ?? ""
  const detail = await readRepoDetail(name)
  if (!detail) return c.json({ error: "not found" }, 404)
  // recent loops on this repo
  const loops = await listLoops()
  const recent = loops.filter((l) => (l as any).repo === name).slice(0, 8)
  return c.json({ ...detail, recentLoops: recent })
})

app.get("/api/workspace/focus", async (c) => {
  return c.json(await readFocusData())
})

app.get(
  "/ws/loop/:id/term",
  upgradeWebSocket(async (c) => {
    const id = c.req.param("id") ?? ""
    const canWrite = !!getRequestUserId(c)
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
        await attachTerm(id, ws)
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
            session.sendUserText(msg.text)
          } else if (msg?.type === "clear") {
            session.clear(userId ?? "anon")
          } else if (msg?.type === "interrupt") {
            session.interrupt()
          } else if (msg?.type === "answers") {
            session.answerQuestions(msg.tool_use_id, msg.answers)
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
                    const pCfg = await loadPersonalConfig(userId)
                    p = pCfg.providers[msg.provider]
                  } catch {}
                }
                if (!p) {
                  const wCfg = await loadConfig() as any
                  p = wCfg?.providers?.[msg.provider]
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
import { join } from "node:path"
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
await printBootstrapBanner(cfg)
if (backfilled > 0) console.log(`[loopat] backfilled context mounts on ${backfilled} loop(s)`)

export default {
  port,
  hostname,
  fetch: app.fetch,
  websocket,
}
