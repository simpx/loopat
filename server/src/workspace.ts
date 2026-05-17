/**
 * Workspace-level file APIs for Context tab vaults (knowledge / notes /
 * personal / repos). Auto-commits on write per user's design:
 * "每次修改自动 commit, log 记录动作"。
 */
import { readdir, readFile, writeFile, stat, mkdir, rm, unlink } from "node:fs/promises"
// Re-using readFile for parsing focus/inbox markdown.
import { existsSync } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { join, normalize, relative, sep, dirname } from "node:path"
import {
  workspaceKnowledgeDir,
  workspaceNotesDir,
  workspaceReposDir,
  personalDir,
} from "./paths"

const execFileP = promisify(execFile)

export type VaultId = "knowledge" | "notes" | "personal" | "repos"

export type VaultEntry = {
  name: string
  path: string
  type: "file" | "dir"
  size?: number
}

export function vaultRoot(vault: VaultId, user: string): string {
  switch (vault) {
    case "knowledge":
      return workspaceKnowledgeDir()
    case "notes":
      return workspaceNotesDir()
    case "personal":
      return personalDir(user)
    case "repos":
      return workspaceReposDir()
  }
}

function safeJoin(rootAbs: string, rel: string): string | null {
  const candidate = normalize(join(rootAbs, rel))
  const insideRel = relative(rootAbs, candidate)
  if (insideRel.startsWith("..") || insideRel.startsWith("/" + sep)) return null
  return candidate
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".bun"])

export async function vaultList(vault: VaultId, relPath: string, user: string): Promise<VaultEntry[]> {
  const root = vaultRoot(vault, user)
  const abs = safeJoin(root, relPath)
  if (!abs) return []
  let names: string[] = []
  try {
    names = await readdir(abs)
  } catch {
    return []
  }
  const out: VaultEntry[] = []
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue
    if (name === ".git" || name === ".DS_Store") continue
    const childRel = relPath ? `${relPath}/${name}` : name
    let isDir = false
    let size: number | undefined
    try {
      const s = await stat(join(abs, name))
      isDir = s.isDirectory()
      if (!isDir) size = s.size
    } catch {
      continue
    }
    out.push({ name, path: childRel, type: isDir ? "dir" : "file", size })
  }
  const isLoopatRoot = (e: VaultEntry) => vault === "personal" && e.type === "dir" && e.name === ".loopat" && relPath === ""
  out.sort((a, b) => {
    // .loopat/ pinned to the very bottom in personal vault root (platform-managed namespace)
    if (isLoopatRoot(a) !== isLoopatRoot(b)) return isLoopatRoot(a) ? 1 : -1
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return out
}

/**
 * Recursive flat list of files in a vault. Used for sidebar search.
 */
export async function vaultFlatList(vault: VaultId, user: string): Promise<VaultEntry[]> {
  const root = vaultRoot(vault, user)
  const out: VaultEntry[] = []
  const walk = async (abs: string, rel: string): Promise<void> => {
    let names: string[] = []
    try {
      names = await readdir(abs)
    } catch {
      return
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name) || name === ".git" || name === ".DS_Store") continue
      const childAbs = join(abs, name)
      const childRel = rel ? `${rel}/${name}` : name
      let s
      try {
        s = await stat(childAbs)
      } catch {
        continue
      }
      if (s.isDirectory()) {
        await walk(childAbs, childRel)
      } else {
        out.push({ name, path: childRel, type: "file", size: s.size })
      }
    }
  }
  await walk(root, "")
  return out
}

const MAX_BYTES = 1024 * 1024

/**
 * Anything under `personal/<user>/.loopat/vaults/<vault>/...` is a secret
 * value. The worktree holds plaintext (so the sandbox can use it) but the API
 * surface MUST NEVER hand it back to the browser — editing means overwriting
 * with a new value the user types, never decrypt-and-view.
 */
function isSecretPath(vault: VaultId, relPath: string): boolean {
  if (vault !== "personal") return false
  if (!relPath.startsWith(".loopat/vaults/")) return false
  // Need at least one path segment under the vault name to be a real file
  // (`.loopat/vaults/prod` is the vault dir itself, not a secret).
  const rest = relPath.slice(".loopat/vaults/".length)
  return rest.includes("/")
}

export async function vaultRead(
  vault: VaultId,
  relPath: string,
  user: string,
): Promise<{ content: string; size: number; truncated: boolean; secret?: boolean } | null> {
  const root = vaultRoot(vault, user)
  const abs = safeJoin(root, relPath)
  if (!abs) return null
  try {
    const s = await stat(abs)
    if (!s.isFile()) return null
    // Secrets: never return the plaintext, even to the authenticated user.
    // Edit means "overwrite", never "decrypt and view".
    if (isSecretPath(vault, relPath)) {
      return { content: "", size: s.size, truncated: false, secret: true }
    }
    const truncated = s.size > MAX_BYTES
    const buf = await readFile(abs)
    const slice = truncated ? buf.subarray(0, MAX_BYTES) : buf
    return { content: slice.toString("utf8"), size: s.size, truncated }
  } catch {
    return null
  }
}

export async function vaultWrite(
  vault: VaultId,
  relPath: string,
  content: string,
  user: string,
): Promise<{ ok: boolean; commit?: string; error?: string }> {
  const root = vaultRoot(vault, user)
  const abs = safeJoin(root, relPath)
  if (!abs) return { ok: false, error: "path escapes root" }
  try {
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content)
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "write failed" }
  }
  // auto-commit if root is a git repo
  if (existsSync(join(root, ".git"))) {
    try {
      const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z")
      const env = { ...process.env, GIT_AUTHOR_NAME: "loopat", GIT_AUTHOR_EMAIL: "auto@loopat.local", GIT_COMMITTER_NAME: "loopat", GIT_COMMITTER_EMAIL: "auto@loopat.local" }
      await execFileP("git", ["-C", root, "add", "--", relPath], { env })
      const { stdout } = await execFileP(
        "git",
        ["-C", root, "commit", "-m", `${relPath}: ${ts}`, "--allow-empty"],
        { env },
      )
      const m = stdout.match(/\b([0-9a-f]{7,})\b/)
      return { ok: true, commit: m?.[1] }
    } catch (e: any) {
      // file written but commit failed (e.g., no changes); still success
      return { ok: true, error: e?.stderr ?? e?.message }
    }
  }
  return { ok: true }
}

export async function vaultCreateFile(vault: VaultId, relPath: string, user: string): Promise<{ ok: boolean; error?: string }> {
  const root = vaultRoot(vault, user)
  const abs = safeJoin(root, relPath)
  if (!abs) return { ok: false, error: "path escapes root" }
  if (existsSync(abs)) return { ok: false, error: "exists" }
  try {
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, "")
  } catch (e: any) {
    return { ok: false, error: e?.message }
  }
  return { ok: true }
}

export async function vaultCreateFolder(vault: VaultId, relPath: string, user: string): Promise<{ ok: boolean; error?: string }> {
  const root = vaultRoot(vault, user)
  const abs = safeJoin(root, relPath)
  if (!abs) return { ok: false, error: "path escapes root" }
  if (existsSync(abs)) return { ok: false, error: "exists" }
  try {
    await mkdir(abs, { recursive: true })
  } catch (e: any) {
    return { ok: false, error: e?.message }
  }
  return { ok: true }
}

export async function vaultDelete(vault: VaultId, relPath: string, user: string): Promise<{ ok: boolean; error?: string }> {
  const root = vaultRoot(vault, user)
  const abs = safeJoin(root, relPath)
  if (!abs) return { ok: false, error: "path escapes root" }
  try {
    const s = await stat(abs)
    if (s.isDirectory()) {
      await rm(abs, { recursive: true, force: true })
    } else {
      await unlink(abs)
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "delete failed" }
  }
  return { ok: true }
}

export type RepoEntry = {
  name: string
  path: string
  remote?: string
}

export type Backlink = {
  path: string  // file path that links to the target
  preview: string  // first line of context around the link
}

/**
 * Scan all .md files in the vault for `[[<basename of path>]]` references
 * and return matching files with a short preview.
 */
export async function vaultBacklinks(vault: VaultId, targetPath: string, user: string): Promise<Backlink[]> {
  const root = vaultRoot(vault, user)
  // basename without .md extension is the wikilink target
  const baseName = targetPath.split("/").pop()?.replace(/\.md$/, "") ?? targetPath
  const aliases = new Set<string>([baseName, targetPath, targetPath.replace(/\.md$/, "")])
  const out: Backlink[] = []
  const walk = async (dir: string): Promise<void> => {
    let names: string[] = []
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name) || name === ".git") continue
      const p = join(dir, name)
      let s
      try {
        s = await stat(p)
      } catch {
        continue
      }
      if (s.isDirectory()) {
        await walk(p)
        continue
      }
      if (!name.endsWith(".md")) continue
      const rel = relative(root, p)
      if (rel === targetPath) continue
      let body = ""
      try {
        body = await readFile(p, "utf8")
      } catch {
        continue
      }
      // find any [[X]] where X matches one of aliases
      const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g
      let m: RegExpExecArray | null
      while ((m = re.exec(body)) !== null) {
        const target = m[1].trim()
        if (aliases.has(target)) {
          // grab the line
          const lineStart = body.lastIndexOf("\n", m.index) + 1
          const lineEnd = body.indexOf("\n", m.index)
          const line = body.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim()
          out.push({ path: rel, preview: line.slice(0, 200) })
          break
        }
      }
    }
  }
  await walk(root)
  return out
}

// ── Focus model ──
//
// Storage: notes/focus/<name>.md  (one file per focus, including inbox.md)
// Format: ccx-style markdown task tree.
//   - `# [ ] Title #topic1 #topic2`  ← top-level task = focus title; topics inline
//   - `> pinned: true` / `> priority: P0`  ← meta lines (blockquote)
//   - `## [ ] Subtask` ... up to any depth via `#` count
//   - `- [ ] Leaf task` (bullet) also accepted as a leaf
//
// Concepts:
//   - Focus = a file in focus/; identified by filename slug
//   - Topic = #xxx tokens anywhere in the markdown (or in loop title); cross-
//     entity association key. Topics are NEVER renamed by the system; users
//     rename via batch operation if needed.

export type FocusMeta = {
  /** filename without .md */
  name: string
  /** display title — text of the first `#` line, sans checkbox + topics */
  title: string
  /** parsed `> pinned: true` */
  pinned: boolean
  /** parsed `> priority: <string>` — free-form (P0/P1/high/low/…) */
  priority?: string
  /** unique #xxx tokens found anywhere in the file */
  topics: string[]
  /** count of `[ ]` / `[x]` tasks at any depth */
  doneCount: number
  totalCount: number
  /** epoch ms of last write */
  mtimeMs: number
}

const TOPIC_RE = /(?<![\w])#([A-Za-z0-9][\w-]*)/g
function extractTopics(text: string): string[] {
  const out = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = TOPIC_RE.exec(text)) !== null) {
    out.add(m[1].toLowerCase())
  }
  return [...out]
}

const TASK_HEADER_RE = /^(#+)\s*\[([ xX])\]\s*(.*)$/
const TASK_BULLET_RE = /^\s*-\s*\[([ xX])\]\s*(.*)$/
const META_RE = /^>\s*([\w-]+):\s*(.*)$/
const H1_PLAIN_RE = /^#\s+(.*)$/

function stripTopicsFromTitle(t: string): string {
  return t.replace(TOPIC_RE, "").trim()
}

/** Parse a single focus md file. */
function parseFocusFile(name: string, body: string, mtimeMs: number): FocusMeta {
  const lines = body.split("\n")
  let title = name
  let pinned = false
  let priority: string | undefined
  let done = 0
  let total = 0
  let titleSet = false

  for (const line of lines) {
    // task header (# [ ] xxx, ## [ ] xxx, ...) — counts toward done/total + first one is title
    const hm = line.match(TASK_HEADER_RE)
    if (hm) {
      const checked = hm[2].toLowerCase() === "x"
      total++
      if (checked) done++
      if (!titleSet) {
        title = stripTopicsFromTitle(hm[3]) || name
        titleSet = true
      }
      continue
    }
    // bullet task (leaf)
    const bm = line.match(TASK_BULLET_RE)
    if (bm) {
      const checked = bm[1].toLowerCase() === "x"
      total++
      if (checked) done++
      continue
    }
    // plain `# Title` (no checkbox) — also acceptable as title, lower priority
    if (!titleSet) {
      const tm = line.match(H1_PLAIN_RE)
      if (tm) {
        title = stripTopicsFromTitle(tm[1]) || name
        titleSet = true
        continue
      }
    }
    // meta blockquote (> key: value) — applies to the focus as a whole when
    // appearing near the top before any subtask divergence
    const mm = line.match(META_RE)
    if (mm) {
      const k = mm[1].toLowerCase()
      const v = mm[2].trim()
      if (k === "pinned") {
        pinned = v.toLowerCase() === "true" || v === "1" || v === "yes"
      } else if (k === "priority") {
        priority = v
      }
    }
  }

  const topics = extractTopics(body)
  return { name, title, pinned, priority, topics, doneCount: done, totalCount: total, mtimeMs }
}

export async function listFocuses(): Promise<FocusMeta[]> {
  const dir = join(workspaceNotesDir(), "focus")
  let entries: string[] = []
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const out: FocusMeta[] = []
  for (const f of entries) {
    if (!f.endsWith(".md")) continue
    const path = join(dir, f)
    let body = ""
    let mtimeMs = 0
    try {
      body = await readFile(path, "utf8")
      const s = await stat(path)
      mtimeMs = s.mtimeMs
    } catch {
      continue
    }
    out.push(parseFocusFile(f.slice(0, -3), body, mtimeMs))
  }
  // Pinned first; within group: priority asc (P0 < P1 < ... < no-priority); then by name
  const prioRank = (p?: string) => {
    if (!p) return 99
    const m = p.match(/^p?(\d+)$/i)
    return m ? parseInt(m[1], 10) : 50
  }
  out.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    const pa = prioRank(a.priority)
    const pb = prioRank(b.priority)
    if (pa !== pb) return pa - pb
    return a.name.localeCompare(b.name)
  })
  return out
}

export async function readFocus(name: string): Promise<{ body: string; mtimeMs: number } | null> {
  const safe = name.replace(/[/\\]/g, "")
  const path = join(workspaceNotesDir(), "focus", safe + ".md")
  try {
    const body = await readFile(path, "utf8")
    const s = await stat(path)
    return { body, mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}

export async function writeFocus(name: string, body: string): Promise<boolean> {
  const safe = name.replace(/[/\\]/g, "")
  if (!safe || safe.startsWith(".")) return false
  const dir = join(workspaceNotesDir(), "focus")
  const path = join(dir, safe + ".md")
  await mkdir(dir, { recursive: true })
  await writeFile(path, body)
  return true
}

/** Aggregate all topics across focuses + loop titles. */
export type TopicAggregate = {
  name: string
  focuses: string[]   // focus names containing this topic
  loops: { id: string; title: string }[]
}

export async function listTopics(loopTitles: { id: string; title: string }[]): Promise<TopicAggregate[]> {
  const map = new Map<string, TopicAggregate>()
  const focuses = await listFocuses()
  for (const f of focuses) {
    for (const t of f.topics) {
      let entry = map.get(t)
      if (!entry) {
        entry = { name: t, focuses: [], loops: [] }
        map.set(t, entry)
      }
      entry.focuses.push(f.name)
    }
  }
  for (const { id, title } of loopTitles) {
    const topics = extractTopics(title)
    for (const t of topics) {
      let entry = map.get(t)
      if (!entry) {
        entry = { name: t, focuses: [], loops: [] }
        map.set(t, entry)
      }
      entry.loops.push({ id, title })
    }
  }
  return [...map.values()].sort((a, b) => {
    const wa = a.focuses.length + a.loops.length
    const wb = b.focuses.length + b.loops.length
    if (wa !== wb) return wb - wa
    return a.name.localeCompare(b.name)
  })
}

export type RepoDetail = RepoEntry & {
  branch?: string
  status: "online" | "offline"
  readme?: string
}

export async function readRepoDetail(name: string): Promise<RepoDetail | null> {
  const path = join(workspaceReposDir(), name)
  try {
    const s = await stat(path)
    if (!s.isDirectory()) return null
  } catch {
    return null
  }
  let remote: string | undefined
  let branch: string | undefined
  let online: "online" | "offline" = "online"
  try {
    const { stdout } = await execFileP("git", ["-C", path, "remote", "get-url", "origin"])
    remote = stdout.trim()
  } catch {
    online = "offline"
  }
  try {
    const { stdout } = await execFileP("git", ["-C", path, "symbolic-ref", "--short", "HEAD"])
    branch = stdout.trim()
  } catch {}
  let readme: string | undefined
  for (const candidate of ["README.md", "readme.md", "README", "Readme.md"]) {
    try {
      const buf = await readFile(join(path, candidate), "utf8")
      readme = buf
      break
    } catch {}
  }
  return { name, path, remote, branch, status: online, readme }
}

export async function pullRepo(name: string): Promise<{ ok: boolean; output?: string; error?: string }> {
  const path = join(workspaceReposDir(), name)
  try {
    const s = await stat(path)
    if (!s.isDirectory()) return { ok: false, error: "not found" }
  } catch {
    return { ok: false, error: "not found" }
  }
  if (!existsSync(join(path, ".git"))) return { ok: false, error: "not a git repo" }
  try {
    const { stdout, stderr } = await execFileP("git", ["-C", path, "pull", "--ff-only"], { timeout: 60_000 })
    return { ok: true, output: `${stdout}${stderr}`.trim() }
  } catch (e: any) {
    const msg = (e?.stderr || e?.stdout || e?.message || "pull failed").toString().trim()
    return { ok: false, error: msg }
  }
}

export async function listRepos(): Promise<RepoEntry[]> {
  const root = workspaceReposDir()
  let names: string[] = []
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  const out: RepoEntry[] = []
  for (const name of names) {
    const p = join(root, name)
    let target = p
    try {
      const s = await stat(p)
      if (!s.isDirectory()) continue
      target = p
    } catch {
      continue
    }
    let remote: string | undefined
    try {
      const { stdout } = await execFileP("git", ["-C", target, "remote", "get-url", "origin"])
      remote = stdout.trim()
    } catch {}
    out.push({ name, path: target, remote })
  }
  return out
}
