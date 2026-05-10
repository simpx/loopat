import { mkdir, readdir, readFile, writeFile, stat, symlink, lstat, rm, copyFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { existsSync } from "node:fs"
import { join } from "node:path"
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
  workspaceDir,
  workspaceKnowledgeDir,
  workspaceNotesDir,
  workspaceReposDir,
  workspaceRepoDir,
  personalDir,
  personalMemoryDir,
  teamMemoryDir,
  workspaceDoctrinePath,
  TEMPLATES_DIR,
} from "./paths"
import { existsSync as existsSyncBase } from "node:fs"

const execFileP = promisify(execFile)

export type LoopMeta = {
  id: string
  title: string
  createdAt: string
  repo?: string
  branch?: string
}

const PERSONAL_MEMORY_INDEX_STUB = `# Personal memory index

Each line points at a memory file in this directory. Maintained by Claude.

`

const TEAM_MEMORY_INDEX_STUB = `# Team memory index

Cross-loop, cross-user memory shared via the notes git repo. One line per entry.
Promote here only when the insight is workspace-wide (a convention, an
operational fact, a non-obvious gotcha). Routine observations belong in
\`/personal/memory/\` instead.

`

async function gitInitIfMissing(dir: string) {
  if (existsSyncBase(join(dir, ".git"))) return
  try {
    await execFileP("git", ["-C", dir, "init", "-q", "-b", "main"])
  } catch (e: any) {
    console.warn(`[loopat] git init failed for ${dir}: ${e?.message ?? e}`)
  }
}

export async function ensureWorkspaceDirs() {
  await mkdir(workspaceDir(), { recursive: true })
  await mkdir(loopsDir(), { recursive: true })
  await mkdir(workspaceKnowledgeDir(), { recursive: true })
  await mkdir(workspaceNotesDir(), { recursive: true })
  await mkdir(workspaceReposDir(), { recursive: true })
  await mkdir(personalDir(ME), { recursive: true })
  // memory dirs + stub indices (idempotent)
  const pm = personalMemoryDir(ME)
  const tm = teamMemoryDir()
  await mkdir(pm, { recursive: true })
  await mkdir(tm, { recursive: true })
  const pmIdx = `${pm}/MEMORY.md`
  const tmIdx = `${tm}/MEMORY.md`
  if (!existsSyncBase(pmIdx)) await writeFile(pmIdx, PERSONAL_MEMORY_INDEX_STUB)
  if (!existsSyncBase(tmIdx)) await writeFile(tmIdx, TEAM_MEMORY_INDEX_STUB)
  // doctrine (workspace-level CLAUDE.md): copy template if missing
  const doctrine = workspaceDoctrinePath()
  if (!existsSyncBase(doctrine)) {
    const tpl = join(TEMPLATES_DIR, "CLAUDE.md")
    if (existsSyncBase(tpl)) await copyFile(tpl, doctrine)
    else console.warn(`[loopat] doctrine template missing at ${tpl}`)
  }
  // local auto-commit story: notes + personal init'd as repos so vaultWrite
  // can stamp commits. knowledge/ stays plain (read-only by Claude convention).
  await gitInitIfMissing(workspaceNotesDir())
  await gitInitIfMissing(personalDir(ME))
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
  // Write per-loop settings.json so SDK auto-memory points at the virtual
  // /personal/memory/ path (which exists inside outer sandbox).
  const settings = {
    autoMemoryEnabled: true,
    autoMemoryDirectory: "/personal/memory",
  }
  await writeFile(`${loopClaudeDir(id)}/settings.json`, JSON.stringify(settings, null, 2))

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
