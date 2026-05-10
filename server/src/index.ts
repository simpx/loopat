import { Hono } from "hono"
import { cors } from "hono/cors"
import { createBunWebSocket } from "hono/bun"
import { existsSync } from "node:fs"
import { listLoops, createLoop, getLoop, loopExists, backfillAllMounts, ensureWorkspaceDirs, provisionUserPersonal } from "./loops"
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
} from "./paths"
import { loadConfig } from "./config"
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
  return c.json({ loops: await listLoops() })
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

app.get("/api/loops/:id/context", async (c) => {
  const id = c.req.param("id") ?? ""
  if (!(await loopExists(id))) return c.json({ error: "not found" }, 404)
  const mounts: { name: string; path: string }[] = []
  if (existsSync(loopContextKnowledge(id))) mounts.push({ name: "knowledge", path: "context/knowledge" })
  if (existsSync(loopContextNotes(id))) mounts.push({ name: "notes", path: "context/notes" })
  if (existsSync(loopContextPersonal(id))) mounts.push({ name: "personal", path: "context/personal" })
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
  if (!(await loopExists(id))) return c.json({ error: "not found" }, 404)
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
      onMessage(event, _ws) {
        if (!canWrite) return
        try {
          const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)
          const msg = JSON.parse(data)
          if (msg?.type === "data" && typeof msg.data === "string") writeTerm(id, msg.data)
          else if (msg?.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number")
            resizeTerm(id, msg.cols, msg.rows)
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
    const session = getSession(id)
    let attached: any = null
    return {
      async onOpen(_e, ws) {
        attached = ws
        await session.attach(ws)
      },
      onMessage(event, ws) {
        if (!canWrite) {
          try { ws.send(JSON.stringify({ type: "error", message: "login required to send" })) } catch {}
          return
        }
        try {
          const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)
          const msg = JSON.parse(data)
          if (msg?.type === "user" && typeof msg.text === "string") {
            session.sendUserText(msg.text)
          } else if (msg?.type === "interrupt") {
            session.interrupt()
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

const port = Number(process.env.PORT ?? 7787)
await ensureWorkspaceDirs()
const backfilled = await backfillAllMounts()
const cfg = await loadConfig()
await printBootstrapBanner(cfg)
if (backfilled > 0) console.log(`[loopat] backfilled context mounts on ${backfilled} loop(s)`)

export default {
  port,
  fetch: app.fetch,
  websocket,
}
