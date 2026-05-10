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
  workspaceKnowledgeLoopatDir,
  workspaceNotesDir,
  workspaceReposDir,
  workspaceRepoDir,
  personalDir,
  personalMemoryDir,
  teamMemoryDir,
  workspaceDoctrinePath,
  TEMPLATES_DIR,
} from "./paths"
import type { RepoSpec } from "./config"
import { existsSync as existsSyncBase } from "node:fs"
import { loadConfig } from "./config"

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

async function isEmptyOrMissing(dir: string): Promise<boolean> {
  if (!existsSyncBase(dir)) return true
  try {
    const names = await readdir(dir)
    return names.length === 0
  } catch {
    return true
  }
}

/**
 * If the dir is empty / missing AND a clone URL is set, clone it. On any
 * failure (network, auth, etc.) fall through to mkdir so the workspace can
 * still come up. Returns whether the dir came from a remote clone — caller
 * uses that to decide whether to git init locally.
 */
async function cloneOrMkdir(dir: string, url: string | undefined): Promise<{ cloned: boolean }> {
  if (url && (await isEmptyOrMissing(dir))) {
    try {
      // remove the empty placeholder if it exists, git clone wants to create
      try { await rm(dir, { recursive: true, force: true }) } catch {}
      await mkdir(join(dir, ".."), { recursive: true })
      await execFileP("git", ["clone", "--", url, dir])
      console.log(`[loopat] cloned ${url} → ${dir}`)
      return { cloned: true }
    } catch (e: any) {
      console.warn(`[loopat] clone failed (${url}): ${e?.stderr ?? e?.message ?? e} — falling back to empty dir`)
    }
  }
  await mkdir(dir, { recursive: true })
  return { cloned: false }
}

async function ensureRepos(specs: RepoSpec[]) {
  for (const r of specs) {
    if (!r?.name || !r?.git) continue
    const dir = workspaceRepoDir(r.name)
    if (existsSyncBase(dir)) continue
    try {
      await mkdir(workspaceReposDir(), { recursive: true })
      await execFileP("git", ["clone", "--", r.git, dir])
      console.log(`[loopat] cloned ${r.git} → ${dir}`)
    } catch (e: any) {
      console.warn(`[loopat] repo clone failed (${r.git}): ${e?.stderr ?? e?.message ?? e}`)
    }
  }
}

export async function ensureWorkspaceDirs() {
  await mkdir(workspaceDir(), { recursive: true })
  await mkdir(loopsDir(), { recursive: true })
  await mkdir(workspaceReposDir(), { recursive: true })
  await mkdir(personalDir(ME), { recursive: true })

  // knowledge / notes / repos: clone from config'd remote if present
  const cfg = await loadConfig()
  const k = await cloneOrMkdir(workspaceKnowledgeDir(), cfg.knowledge?.git || undefined)
  const n = await cloneOrMkdir(workspaceNotesDir(), cfg.notes?.git || undefined)
  if (cfg.repos?.length) await ensureRepos(cfg.repos)

  // memory dirs + stub indices (idempotent)
  const pm = personalMemoryDir(ME)
  const tm = teamMemoryDir()
  await mkdir(pm, { recursive: true })
  await mkdir(tm, { recursive: true })
  const pmIdx = `${pm}/MEMORY.md`
  const tmIdx = `${tm}/MEMORY.md`
  if (!existsSyncBase(pmIdx)) await writeFile(pmIdx, PERSONAL_MEMORY_INDEX_STUB)
  if (!existsSyncBase(tmIdx)) await writeFile(tmIdx, TEAM_MEMORY_INDEX_STUB)

  // doctrine lives inside knowledge as `loopat/CLAUDE.md` — copy the bundled
  // template if not already present (a cloned knowledge repo with its own
  // CLAUDE.md wins; otherwise we seed from server/templates/).
  const doctrine = workspaceDoctrinePath()
  if (!existsSyncBase(doctrine)) {
    await mkdir(workspaceKnowledgeLoopatDir(), { recursive: true })
    const tpl = join(TEMPLATES_DIR, "CLAUDE.md")
    if (existsSyncBase(tpl)) await copyFile(tpl, doctrine)
    else console.warn(`[loopat] doctrine template missing at ${tpl}`)
  }

  // git init notes + personal so vaultWrite auto-commits work locally. Skip
  // notes if we cloned (already a repo). Knowledge stays plain unless cloned.
  if (!n.cloned) await gitInitIfMissing(workspaceNotesDir())
  await gitInitIfMissing(personalDir(ME))
  // suppress unused warning for k.cloned (kept for symmetry / future use)
  void k
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
