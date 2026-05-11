/**
 * Workspace-level file APIs for Context tab vaults (knowledge / notes /
 * personal / repos). Auto-commits on write per user's design:
 * "每次修改自动 commit, log 记录动作"。
 */
import { readdir, readFile, writeFile, stat, mkdir } from "node:fs/promises"
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

export async function vaultRead(vault: VaultId, relPath: string, user: string): Promise<{ content: string; size: number; truncated: boolean } | null> {
  const root = vaultRoot(vault, user)
  const abs = safeJoin(root, relPath)
  if (!abs) return null
  try {
    const s = await stat(abs)
    if (!s.isFile()) return null
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

export type FocusData = {
  pinned: string[]
  listed: string[]
  inbox: string[]
}

function parseList(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean)
}

function parseSections(body: string): { pinned: string[]; listed: string[] } {
  // Split on `## <name>` headers; collect entries under "pinned" and "listed"
  const lines = body.split("\n")
  let current: string | null = null
  const sections = new Map<string, string[]>()
  for (const line of lines) {
    const m = line.match(/^##\s+(\w+)/)
    if (m) {
      current = m[1].toLowerCase()
      if (!sections.has(current)) sections.set(current, [])
      continue
    }
    if (current) {
      const t = line.trim()
      if (t.startsWith("- ")) {
        const name = t.slice(2).trim().split("—")[0].trim()
        if (name) sections.get(current)!.push(name)
      }
    }
  }
  return {
    pinned: sections.get("pinned") ?? [],
    listed: sections.get("listed") ?? [],
  }
}

export async function readFocusData(): Promise<FocusData> {
  const focusBody = await readFile(join(workspaceNotesDir(), "focus.md"), "utf8").catch(() => "")
  const inboxBody = await readFile(join(workspaceNotesDir(), "inbox.md"), "utf8").catch(() => "")
  const { pinned, listed } = parseSections(focusBody)
  const inbox = parseList(inboxBody)
  return { pinned, listed, inbox }
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
