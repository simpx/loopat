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
  ME,
} from "./paths"

const execFileP = promisify(execFile)

export type VaultId = "knowledge" | "notes" | "personal" | "repos"

export type VaultEntry = {
  name: string
  path: string
  type: "file" | "dir"
  size?: number
}

export function vaultRoot(vault: VaultId): string {
  switch (vault) {
    case "knowledge":
      return workspaceKnowledgeDir()
    case "notes":
      return workspaceNotesDir()
    case "personal":
      return personalDir(ME)
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

export async function vaultList(vault: VaultId, relPath: string): Promise<VaultEntry[]> {
  const root = vaultRoot(vault)
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
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return out
}

const MAX_BYTES = 1024 * 1024

export async function vaultRead(vault: VaultId, relPath: string): Promise<{ content: string; size: number; truncated: boolean } | null> {
  const root = vaultRoot(vault)
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
): Promise<{ ok: boolean; commit?: string; error?: string }> {
  const root = vaultRoot(vault)
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

export async function vaultCreateFile(vault: VaultId, relPath: string): Promise<{ ok: boolean; error?: string }> {
  const root = vaultRoot(vault)
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
