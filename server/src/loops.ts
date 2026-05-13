import { mkdir, mkdtemp, readdir, readFile, rename, writeFile, stat, symlink, lstat, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  loopsDir,
  loopDir,
  loopWorkdir,
  loopClaudeDir,
  loopContextDir,
  loopContextKnowledge,
  loopContextNotes,
  loopContextPersonal,
  loopContextRepos,
  loopMetaPath,
  workspaceDir,
  workspaceKnowledgeDir,
  workspaceNotesDir,
  workspaceReposDir,
  workspaceRepoDir,
  personalDir,
  personalMemoryDir,
  teamMemoryDir,
  hostDeployKeyPath,
  personalGitCryptKeyPath,
} from "./paths"
import type { RepoSpec } from "./config"
import { existsSync as existsSyncBase } from "node:fs"
import { loadConfig } from "./config"
import { ensurePersonalKeypair } from "./personal-keys"

const execFileP = promisify(execFile)

export type LoopMeta = {
  id: string
  title: string
  createdAt: string
  createdBy: string
  driver?: string
  repo?: string
  branch?: string
  config?: {
    default_model?: string
    default_model_source?: "personal" | "workspace"
  }
  /**
   * Archive = "hide + read-only". Hidden from default list, all writes
   * (sendUserText / clear / setProvider / writeTerm / answerQuestions /
   * vault writes) reject. Reads stay open (attach, history, files, term
   * view). Lossless — `unarchive` flips back. See docs/design notes.
   */
  archived?: boolean
  archivedAt?: string
}

const PERSONAL_MEMORY_INDEX_STUB = `# Personal memory index

Each line points at a memory file in this directory. Maintained by Claude.

`

const TEAM_MEMORY_INDEX_STUB = `# Team memory index

Cross-loop, cross-user memory shared via the notes git repo. One line per entry.
Promote here only when the insight is workspace-wide (a convention, an
operational fact, a non-obvious gotcha). Routine observations belong in
\`/loopat/context/personal/memory/\` instead.

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

  // knowledge / notes / repos: clone from config'd remote if present
  const cfg = await loadConfig()
  const k = await cloneOrMkdir(workspaceKnowledgeDir(), cfg.knowledge?.git || undefined)
  const n = await cloneOrMkdir(workspaceNotesDir(), cfg.notes?.git || undefined)
  if (cfg.repos?.length) await ensureRepos(cfg.repos)

  // team memory dir + stub
  const tm = teamMemoryDir()
  await mkdir(tm, { recursive: true })
  const tmIdx = `${tm}/MEMORY.md`
  if (!existsSyncBase(tmIdx)) await writeFile(tmIdx, TEAM_MEMORY_INDEX_STUB)

  // git init notes so vaultWrite auto-commits work locally. Skip if cloned
  // (already a repo). Knowledge stays plain unless cloned.
  if (!n.cloned) await gitInitIfMissing(workspaceNotesDir())
  // suppress unused warning for k.cloned (kept for symmetry / future use)
  void k
}

/**
 * Provision a freshly-registered user's personal/ tree. NEVER clones the
 * user's remote repo here — the server has no credentials for private repos
 * at register time. We:
 *   1. mkdir + `git init` an empty personal/<user>/
 *   2. seed `memory/MEMORY.md` so SDK auto-recall sees something
 *   3. generate a loopat-managed ed25519 keypair under
 *      `host-secrets/<user>/deploy-key` (deploy-key flow, host-only)
 *
 * If `personalRepo` was given at register, the user goes through a separate
 * confirm step (see `importPersonalFromRepo`) AFTER they paste the public key
 * as a deploy key on the remote.
 *
 * Returns the public key so the UI can show it.
 */
export async function provisionUserPersonal(userId: string): Promise<{ publicKey: string | null }> {
  const dir = personalDir(userId)
  await mkdir(dir, { recursive: true })

  const pm = personalMemoryDir(userId)
  await mkdir(pm, { recursive: true })
  const pmIdx = `${pm}/MEMORY.md`
  if (!existsSyncBase(pmIdx)) await writeFile(pmIdx, PERSONAL_MEMORY_INDEX_STUB)

  await gitInitIfMissing(dir)

  const { publicKey } = await ensurePersonalKeypair(userId)
  return { publicKey }
}

/**
 * Detect whether `personal/<user>/` is "fresh" — i.e. only has the
 * scaffolding we put there (`.git`, `memory/`). If yes, it's safe to wipe +
 * clone over the top. Anything else means we refuse to overwrite.
 *
 * Note: host-secrets/<user>/ lives OUTSIDE personal/<user>/ so it's not
 * part of this check and survives import without preservation logic.
 */
export async function isPersonalFresh(userId: string): Promise<boolean> {
  const dir = personalDir(userId)
  try {
    const entries = await readdir(dir)
    const SCAFFOLD = new Set([".git", "memory"])
    return entries.every((e) => SCAFFOLD.has(e))
  } catch {
    return true
  }
}

/**
 * One-shot clone using the user's loopat-managed deploy key. Replaces the
 * fresh-scaffolded `personal/<user>/` with the cloned repo.
 *
 * If the cloned repo has `.gitattributes` with git-crypt entries, `cryptKey`
 * (base64-encoded git-crypt key) must be provided — we run `git-crypt unlock`
 * against it to decrypt the worktree. Save the key under host-secrets/ so
 * subsequent `git pull` / re-clone can re-unlock without re-prompting.
 *
 * Returns { ok: false, error } on any failure; on failure personal/<user>/
 * is left untouched (we clone into a temp dir first).
 */
export async function importPersonalFromRepo(
  userId: string,
  repoUrl: string,
  cryptKey?: string,
): Promise<
  | { ok: true; needsCryptKey?: boolean }
  | { ok: false; error: string; needsCryptKey?: boolean; secretsExposed?: boolean; exposedFiles?: string[] }
> {
  if (!repoUrl?.trim()) return { ok: false, error: "repoUrl required" }

  // Refuse if the user has already populated personal/. We don't want to nuke
  // their work. They can `rm -rf` manually and retry if that's really intended.
  if (!(await isPersonalFresh(userId))) {
    return { ok: false, error: "personal/ is not empty — refusing to overwrite" }
  }

  const priv = hostDeployKeyPath(userId)
  if (!existsSyncBase(priv)) {
    return { ok: false, error: "deploy keypair missing — re-register" }
  }

  // Clone into a tmp dir using the user's deploy key. StrictHostKeyChecking=
  // accept-new because we have no pre-populated known_hosts for github/gitlab
  // on first run; UserKnownHostsFile=/dev/null avoids polluting any host file.
  const tmp = await mkdtemp(join(tmpdir(), `loopat-import-${userId}-`))
  const gitSsh = `ssh -i ${priv} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null`
  try {
    await execFileP("git", ["clone", "--", repoUrl, tmp], {
      env: { ...process.env, GIT_SSH_COMMAND: gitSsh },
    })
  } catch (e: any) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    const msg = (e?.stderr || e?.message || String(e)).toString().trim().split("\n").slice(-3).join(" ")
    return { ok: false, error: `clone failed: ${msg}` }
  }

  // Exposure check: refuse to adopt a repo whose .loopat/secrets/** are
  // plaintext in git. Force user to set up git-crypt FIRST (and rotate the
  // already-exposed secrets). If we proceeded, loopat would silently take
  // ownership of leaked data — bad outcome, hard to undo.
  const exposed = await detectExposedSecrets(tmp)
  if (exposed.length > 0) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    return {
      ok: false,
      error: "secrets are exposed (plaintext) in this repo's git history",
      secretsExposed: true,
      exposedFiles: exposed.slice(0, 20),
    }
  }

  // Detect git-crypt: presence of `filter=git-crypt` in any tracked
  // .gitattributes. If yes, require cryptKey and unlock the worktree.
  const isEncrypted = await detectGitCryptEnabled(tmp)
  if (isEncrypted) {
    if (!cryptKey?.trim()) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
      return { ok: false, error: "repo uses git-crypt — paste your git-crypt key to unlock", needsCryptKey: true }
    }
    const unlockResult = await unlockWithCryptKey(tmp, userId, cryptKey)
    if (!unlockResult.ok) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
      return { ok: false, error: unlockResult.error }
    }
  }

  // Replace personal/<user>/ with the clone. host-secrets/<user>/ is outside
  // this dir so nothing to preserve.
  const dir = personalDir(userId)
  try {
    await rm(dir, { recursive: true, force: true })
    await rename(tmp, dir)
    // Top up memory/ index if remote didn't ship one
    const pm = personalMemoryDir(userId)
    await mkdir(pm, { recursive: true })
    const pmIdx = `${pm}/MEMORY.md`
    if (!existsSyncBase(pmIdx)) await writeFile(pmIdx, PERSONAL_MEMORY_INDEX_STUB)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: `swap failed: ${e?.message ?? e}` }
  }
}

// git-crypt's per-file magic header (10 bytes): \x00 G I T C R Y P T \x00
const GIT_CRYPT_MAGIC = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0x00])

/**
 * Returns tracked files under `.loopat/secrets/**` that are stored as
 * plaintext (i.e., the worktree blob doesn't start with the git-crypt magic
 * header). Reads the worktree directly: in a fresh clone where git-crypt
 * isn't unlocked, the worktree contents ARE the raw blobs, so non-encrypted
 * files are visibly plaintext here.
 */
async function detectExposedSecrets(repoDir: string): Promise<string[]> {
  let stdout = ""
  try {
    const r = await execFileP("git", ["-C", repoDir, "ls-files", "-z", ".loopat/secrets"])
    stdout = r.stdout
  } catch {
    return []
  }
  const files = stdout.split("\0").filter(Boolean)
  const exposed: string[] = []
  for (const f of files) {
    try {
      const buf = await readFile(join(repoDir, f))
      if (buf.length === 0) continue // empty file is not "exposed", just useless
      if (!buf.subarray(0, GIT_CRYPT_MAGIC.length).equals(GIT_CRYPT_MAGIC)) {
        exposed.push(f)
      }
    } catch {
      // unreadable — skip
    }
  }
  return exposed
}

async function detectGitCryptEnabled(repoDir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP("git", ["-C", repoDir, "ls-files", "-z"])
    const files = stdout.split("\0").filter((f) => f.endsWith(".gitattributes"))
    for (const f of files) {
      try {
        const content = await readFile(join(repoDir, f), "utf8")
        if (/filter=git-crypt/.test(content)) return true
      } catch {}
    }
    return false
  } catch {
    return false
  }
}

/**
 * Persist cryptKey (base64) to host-secrets/<user>/git-crypt.key and run
 * `git-crypt unlock` against the cloned repo. On failure, removes the saved
 * keyfile so a retry can paste a different key.
 */
async function unlockWithCryptKey(
  repoDir: string,
  userId: string,
  cryptKeyB64: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { saveGitCryptKey, gitCryptKeyExists } = await import("./git-crypt-key")
  try {
    const keyBuf = Buffer.from(cryptKeyB64.trim(), "base64")
    if (keyBuf.length < 32) {
      return { ok: false, error: "invalid git-crypt key (too short — must be base64-encoded export-key output)" }
    }
    await saveGitCryptKey(userId, keyBuf)
  } catch (e: any) {
    return { ok: false, error: `failed to save git-crypt key: ${e?.message ?? e}` }
  }
  const keyPath = personalGitCryptKeyPath(userId)
  try {
    await execFileP("git-crypt", ["unlock", keyPath], { cwd: repoDir })
    return { ok: true }
  } catch (e: any) {
    if (await gitCryptKeyExists(userId)) {
      const { rm: rmFile } = await import("node:fs/promises")
      await rmFile(keyPath, { force: true }).catch(() => {})
    }
    const stderr = (e?.stderr ?? "").toString().trim()
    if (/not the file you generated/i.test(stderr) || /Invalid key file/i.test(stderr)) {
      return { ok: false, error: "git-crypt unlock failed: wrong key (HMAC mismatch)" }
    }
    if (/command not found/i.test(stderr) || e?.code === "ENOENT") {
      return { ok: false, error: "git-crypt not installed on host (apt install git-crypt)" }
    }
    return { ok: false, error: `git-crypt unlock failed: ${stderr || e?.message || e}` }
  }
}

async function ensureSymlink(link: string, target: string) {
  try {
    await lstat(link)
  } catch {
    await symlink(target, link, "dir")
  }
}

export async function ensureContextMounts(id: string, createdBy: string) {
  await mkdir(loopContextDir(id), { recursive: true })
  await ensureSymlink(loopContextKnowledge(id), workspaceKnowledgeDir())
  await ensureSymlink(loopContextNotes(id), workspaceNotesDir())
  await ensureSymlink(loopContextPersonal(id), personalDir(createdBy))
  await ensureSymlink(loopContextRepos(id), workspaceReposDir())
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

export async function createLoop(opts: { title: string; repo?: string; createdBy: string }): Promise<LoopMeta> {
  await ensureWorkspaceDirs()
  const id = randomUUID()
  const meta: LoopMeta = {
    id,
    title: opts.title.trim() || "untitled",
    createdAt: new Date().toISOString(),
    createdBy: opts.createdBy,
  }
  await mkdir(loopDir(id), { recursive: true })
  await mkdir(loopClaudeDir(id), { recursive: true })
  // Write per-loop settings.json so SDK auto-memory points at the virtual
  // /loopat/context/personal/memory/ path (which exists inside outer sandbox).
  const settings = {
    autoMemoryEnabled: true,
    autoMemoryDirectory: "/loopat/context/personal/memory",
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

  await ensureContextMounts(id, meta.createdBy)
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

export async function patchLoopMeta(id: string, patch: Partial<LoopMeta>): Promise<LoopMeta | null> {
  const meta = await getLoop(id)
  if (!meta) return null
  const updated = { ...meta, ...patch }
  await writeFile(loopMetaPath(id), JSON.stringify(updated, null, 2))
  return updated
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
        const meta = await getLoop(id)
        if (!meta?.createdBy) {
          console.warn(`[loopat] loop ${id}: meta missing createdBy — skipping mount backfill`)
          continue
        }
        await ensureContextMounts(id, meta.createdBy)
        count++
      } catch {}
    }
  } catch {}
  return count
}
