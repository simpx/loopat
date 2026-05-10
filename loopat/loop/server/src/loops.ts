import { mkdir, readdir, readFile, writeFile, stat, symlink, lstat, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { existsSync } from "node:fs"
import {
  ME,
  loopsDir,
  loopDir,
  loopWorkdir,
  loopClaudeDir,
  loopContextDir,
  loopContextKnowledge,
  loopContextNotes,
  loopContextPersonal,
  loopMetaPath,
  workspaceKnowledgeDir,
  workspaceNotesDir,
  workspaceReposDir,
  workspaceRepoDir,
  personalDir,
} from "./paths"

const execFileP = promisify(execFile)

export type LoopMeta = {
  id: string
  title: string
  createdAt: string
  repo?: string
  branch?: string
}

export async function ensureWorkspaceDirs() {
  await mkdir(loopsDir(), { recursive: true })
  await mkdir(workspaceKnowledgeDir(), { recursive: true })
  await mkdir(workspaceNotesDir(), { recursive: true })
  await mkdir(workspaceReposDir(), { recursive: true })
  await mkdir(personalDir(ME), { recursive: true })
}

async function ensureSymlink(link: string, target: string) {
  try {
    await lstat(link)
  } catch {
    await symlink(target, link, "dir")
  }
}

export async function ensureContextMounts(id: string) {
  await mkdir(loopContextDir(id), { recursive: true })
  await ensureSymlink(loopContextKnowledge(id), workspaceKnowledgeDir())
  await ensureSymlink(loopContextNotes(id), workspaceNotesDir())
  await ensureSymlink(loopContextPersonal(id), personalDir(ME))
}

export async function listLoops(): Promise<LoopMeta[]> {
  try {
    const ids = await readdir(loopsDir())
    const metas = await Promise.all(
      ids.map(async (id) => {
        try {
          const raw = await readFile(loopMetaPath(id), "utf8")
          return JSON.parse(raw) as LoopMeta
        } catch {
          return null
        }
      })
    )
    return metas.filter((m): m is LoopMeta => m !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  } catch (e: any) {
    if (e?.code === "ENOENT") return []
    throw e
  }
}

async function shortBranchSlug(title: string): Promise<string> {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
  return base || "loop"
}

export async function createLoop(opts: { title: string; repo?: string }): Promise<LoopMeta> {
  await ensureWorkspaceDirs()
  const id = randomUUID()
  const meta: LoopMeta = {
    id,
    title: opts.title.trim() || "untitled",
    createdAt: new Date().toISOString(),
  }
  await mkdir(loopDir(id), { recursive: true })
  await mkdir(loopClaudeDir(id), { recursive: true })

  // workdir = git worktree add (if repo selected) OR plain mkdir
  if (opts.repo) {
    const repoPath = workspaceRepoDir(opts.repo)
    if (!existsSync(repoPath)) {
      throw new Error(`repo "${opts.repo}" not found in context/repos/`)
    }
    const branch = `loop/${(await shortBranchSlug(meta.title))}-${id.slice(0, 6)}`
    try {
      // best-effort worktree add (creates a new branch off origin/HEAD or current HEAD)
      await execFileP("git", ["-C", repoPath, "worktree", "add", "-b", branch, loopWorkdir(id)])
      meta.repo = opts.repo
      meta.branch = branch
    } catch (e: any) {
      // fallback: plain mkdir (let user know)
      console.warn(`[loopat] git worktree add failed for repo=${opts.repo}: ${e?.stderr ?? e?.message}`)
      await mkdir(loopWorkdir(id), { recursive: true })
    }
  } else {
    await mkdir(loopWorkdir(id), { recursive: true })
  }

  await ensureContextMounts(id)
  await writeFile(loopMetaPath(id), JSON.stringify(meta, null, 2))
  return meta
}

export async function getLoop(id: string): Promise<LoopMeta | null> {
  try {
    const raw = await readFile(loopMetaPath(id), "utf8")
    return JSON.parse(raw) as LoopMeta
  } catch {
    return null
  }
}

export async function loopExists(id: string): Promise<boolean> {
  try {
    const s = await stat(loopDir(id))
    return s.isDirectory()
  } catch {
    return false
  }
}

export async function backfillAllMounts(): Promise<number> {
  let count = 0
  try {
    const ids = await readdir(loopsDir())
    for (const id of ids) {
      try {
        await ensureContextMounts(id)
        count++
      } catch {}
    }
  } catch {}
  return count
}
