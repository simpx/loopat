/**
 * Workspace-level file APIs for Context tab vaults (knowledge / notes /
 * personal / repos). Auto-commits on write per user's design:
 * "每次修改自动 commit, log 记录动作"。
 */
import { readdir, readFile, writeFile, stat, lstat, mkdir, rm, unlink, symlink } from "node:fs/promises"
// Re-using readFile for parsing focus/inbox markdown.
import { existsSync } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { homedir } from "node:os"
import { join, normalize, relative, resolve as resolvePath, sep, dirname } from "node:path"
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

const TOPIC_RE = /(?<![\w])#([A-Za-z0-9][\w-]*)/g
function extractTopics(text: string): string[] {
  const out = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = TOPIC_RE.exec(text)) !== null) {
    out.add(m[1].toLowerCase())
  }
  return [...out]
}

/** Aggregate all topics across loop titles. */
export type TopicAggregate = {
  name: string
  loops: { id: string; title: string }[]
}

export async function listTopics(loopTitles: { id: string; title: string }[]): Promise<TopicAggregate[]> {
  const map = new Map<string, TopicAggregate>()
  for (const { id, title } of loopTitles) {
    const topics = extractTopics(title)
    for (const t of topics) {
      let entry = map.get(t)
      if (!entry) {
        entry = { name: t, loops: [] }
        map.set(t, entry)
      }
      entry.loops.push({ id, title })
    }
  }
  return [...map.values()].sort((a, b) => {
    const wb = b.loops.length
    const wa = a.loops.length
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

const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

function isRepoUrl(source: string): boolean {
  return /:\/\//.test(source) || /^git@/.test(source)
}

function expandHome(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

export function deriveRepoName(source: string): string {
  let s = source.trim().replace(/[?#].*$/, "")
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "")
  const m = s.match(/[/:]([^/:]+)$/)
  return (m ? m[1] : s).trim()
}

/**
 * Register a repo under workspaceReposDir(). Source can be either:
 *   - a git URL (http/https/ssh/git@) → `git clone` into the target
 *   - a local filesystem path → symlink into the target
 * Symlinks are preferred for local working trees so edits in the source
 * tree show up in loops without re-cloning.
 */
export async function addRepo(opts: { name: string; source: string }): Promise<{ ok: boolean; name?: string; kind?: "clone" | "symlink"; error?: string }> {
  const source = (opts.source || "").trim()
  if (!source) return { ok: false, error: "source required" }
  const name = (opts.name || "").trim()
  if (!REPO_NAME_RE.test(name)) {
    return { ok: false, error: "invalid name (letters/digits/_.-, max 64, must start with alnum)" }
  }
  const root = workspaceReposDir()
  const target = join(root, name)
  try {
    await lstat(target)
    return { ok: false, error: "already exists" }
  } catch {}
  await mkdir(root, { recursive: true })
  if (isRepoUrl(source)) {
    try {
      await execFileP("git", ["clone", source, target], { timeout: 300_000 })
      return { ok: true, name, kind: "clone" }
    } catch (e: any) {
      const msg = (e?.stderr || e?.stdout || e?.message || "clone failed").toString().trim()
      return { ok: false, error: msg }
    }
  }
  const abs = resolvePath(expandHome(source))
  try {
    const s = await stat(abs)
    if (!s.isDirectory()) return { ok: false, error: "source path is not a directory" }
  } catch {
    return { ok: false, error: "source path does not exist" }
  }
  try {
    await symlink(abs, target)
    return { ok: true, name, kind: "symlink" }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "symlink failed" }
  }
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
