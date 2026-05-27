/**
 * Standalone workspace serve service.
 * Listens on port 7788, serves loop workdirs via subdomain routing.
 * Supports static file serving and HTTP port forwarding.
 */
import { createServer, request as httpRequest } from "node:http"
import { existsSync, statSync, createReadStream, readdirSync, readFileSync as readFileSyncFs } from "node:fs"
import { join, normalize } from "node:path"
import { loopsDir, loopWorkdir, loopMetaPath } from "./paths"

const SERVE_PORT = Number(process.env.LOOPAT_SERVE_PORT ?? 7788)
const SERVE_HOST = process.env.LOOPAT_SERVE_HOST ?? "127.0.0.1"

// Blocked paths — never served
const BLOCKED = new Set([
  ".git", ".ssh", ".env", "node_modules", ".DS_Store",
  ".bun", ".claude", ".vscode", ".idea",
])

function isBlocked(filePath: string): boolean {
  const parts = filePath.split("/").filter(Boolean)
  return parts.some((p) => BLOCKED.has(p) || p.startsWith(".env"))
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".otf": "font/otf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".csv": "text/csv",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
}

function getMime(path: string): string {
  return MIME_TYPES[normalize(path).split(".").pop() ? `.${normalize(path).split(".").pop()}`.toLowerCase() : ""] || "application/octet-stream"
}

type LoopMeta = {
  id: string
  title: string
  shareEnabled?: boolean
  shareMode?: "static" | "port"
  shareAlias?: string
  sharePort?: number
}

// Cache: alias -> loop_id
const aliasCache = new Map<string, string>()

function loadMeta(loopId: string): LoopMeta | null {
  const p = loopMetaPath(loopId)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSyncFs(p, "utf8"))
  } catch {
    return null
  }
}

function resolveLoop(host: string): { loopId: string; meta: LoopMeta } | null {
  const parts = host.split(".")
  if (parts.length < 2) return null
  const subdomain = parts[0].toLowerCase()

  // Check alias cache first
  if (aliasCache.has(subdomain)) {
    const loopId = aliasCache.get(subdomain)!
    const meta = loadMeta(loopId)
    if (meta?.shareEnabled) return { loopId, meta }
    aliasCache.delete(subdomain)
  }

  // Scan all loops
  let dirs: string[]
  try {
    dirs = readdirSync(loopsDir())
  } catch {
    return null
  }

  for (const dir of dirs) {
    const meta = loadMeta(dir)
    if (!meta) continue
    if (!meta.shareEnabled) continue
    const shortId = dir.slice(0, 8)
    if (shortId === subdomain || meta.shareAlias === subdomain) {
      if (meta.shareAlias) aliasCache.set(meta.shareAlias, dir)
      return { loopId: dir, meta }
    }
  }
  return null
}

function rebuildAliasCache() {
  aliasCache.clear()
  let dirs: string[]
  try {
    dirs = readdirSync(loopsDir())
  } catch {
    return
  }
  for (const dir of dirs) {
    const meta = loadMeta(dir)
    if (meta?.shareEnabled && meta.shareAlias) {
      aliasCache.set(meta.shareAlias, dir)
    }
  }
}

rebuildAliasCache()
setInterval(rebuildAliasCache, 30_000)

function serveStaticFile(workdir: string, urlPath: string, res: any): boolean {
  let rel = decodeURIComponent(urlPath)
  if (rel.startsWith("/")) rel = rel.slice(1)
  if (!rel) rel = "index.html"

  const full = normalize(join(workdir, rel))
  if (!full.startsWith(normalize(workdir))) {
    res.writeHead(403)
    res.end("Forbidden")
    return true
  }

  if (isBlocked(rel)) {
    res.writeHead(403)
    res.end("Forbidden")
    return true
  }

  if (!existsSync(full)) {
    if (existsSync(join(full, "index.html"))) {
      return serveStaticFile(workdir, rel + "/index.html", res)
    }
    res.writeHead(404)
    res.end("Not found")
    return true
  }

  const s = statSync(full)
  if (s.isDirectory()) {
    if (existsSync(join(full, "index.html"))) {
      return serveStaticFile(workdir, rel + "/index.html", res)
    }
    res.writeHead(403)
    res.end("Directory listing not allowed")
    return true
  }

  if (!s.isFile()) {
    res.writeHead(403)
    res.end("Forbidden")
    return true
  }

  res.writeHead(200, {
    "Content-Type": getMime(full),
    "Content-Length": s.size,
    "Cache-Control": "no-cache",
  })
  createReadStream(full).pipe(res)
  return true
}

function proxyToPort(port: number, req: any, res: any): void {
  const headers: Record<string, string> = { ...req.headers }
  delete headers["host"]
  headers["host"] = `localhost:${port}`
  if (req.socket.remoteAddress) headers["x-forwarded-for"] = req.socket.remoteAddress
  if (req.headers["host"]) headers["x-forwarded-host"] = req.headers["host"]

  const proxyReq = httpRequest({
    hostname: "127.0.0.1",
    port,
    method: req.method,
    path: req.url,
    headers,
    timeout: 30_000,
  }, (proxyRes: any) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers)
    proxyRes.pipe(res)
  })

  proxyReq.on("error", () => {
    res.writeHead(502)
    res.end("Port forwarding error - is the service running?")
  })

  proxyReq.on("timeout", () => {
    proxyReq.destroy()
    res.writeHead(504)
    res.end("Gateway timeout")
  })

  req.pipe(proxyReq)
}

const server = createServer((req, res) => {
  const host = (req.headers["host"] ?? "").split(":")[0].toLowerCase()
  const resolved = resolveLoop(host)

  if (!resolved) {
    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("No workspace found for this domain")
    return
  }

  const { meta, loopId } = resolved

  if (!meta.shareEnabled) {
    res.writeHead(403)
    res.end("Workspace sharing is disabled")
    return
  }

  const workdir = loopWorkdir(loopId)
  if (!existsSync(workdir)) {
    res.writeHead(404)
    res.end("Workdir not found")
    return
  }

  if (meta.shareMode === "port" && meta.sharePort) {
    if (meta.sharePort < 1024 || meta.sharePort > 65535) {
      res.writeHead(400)
      res.end("Invalid port — must be 1024-65535")
      return
    }
    proxyToPort(meta.sharePort, req, res)
  } else {
    serveStaticFile(workdir, req.url ?? "/", res)
  }
})

server.on("error", (e: any) => {
  if (e.code === "EADDRINUSE") {
    console.error(`[loopat] workspace serve port ${SERVE_PORT} already in use`)
  } else {
    console.error(`[loopat] workspace serve error:`, e)
  }
})

console.log(`[loopat] workspace serve starting on http://${SERVE_HOST}:${SERVE_PORT}`)
server.listen(SERVE_PORT, SERVE_HOST, () => {
  console.log(`[loopat] workspace serve listening on http://${SERVE_HOST}:${SERVE_PORT}`)
})

export { server }
