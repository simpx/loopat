import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, writeFile, stat, symlink, lstat, rm } from "node:fs/promises"
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
  workspaceMemoryDir,
  hostDeployKeyPath,
  personalGitCryptKeyPath,
  loopHistoryPath,
  loopChatHistoryPath,
  loopKindClaudePath,
} from "./paths"
import type { RepoSpec } from "./config"
import { existsSync as existsSyncBase } from "node:fs"
import { loadConfig } from "./config"
import { ensurePersonalKeypair } from "./personal-keys"
import { composeLoopClaudeConfig, writeLoopSettings } from "./compose"

const execFileP = promisify(execFile)

export type LoopMeta = {
  id: string
  title: string
  createdAt: string
  createdBy: string
  /**
   * Active driver. New loops set this to `createdBy` on creation. Legacy
   * loops created before drivers existed may omit it; callers should use
   * `effectiveDriver()` rather than reading this field directly.
   *
   * The driver is the user whose personal config (apiKey, vault, env) the
   * sandbox runs under, and the only user permitted to write (send messages,
   * change provider, write terminal, etc.). Non-driver users are read-only —
   * same set of writes blocked by `archived`. See request-for-drive flow.
   */
  driver?: string
  /**
   * Chronological log of driver assignments. First entry is creation time
   * (driver = createdBy). Each subsequent entry is a successful handoff via
   * POST /api/loops/:id/drive. Used by the chat UI to splice "driving by X
   * since <ts>" markers into the message timeline. Legacy loops may omit
   * this; on the next handoff a fresh history starts from there.
   */
  driverHistory?: Array<{ driver: string; since: string }>
  /**
   * RFD ("Request For Drive") state. When set, the current driver has
   * released control: the sandbox is torn down, and any authenticated user
   * may take over via POST /api/loops/:id/drive. Cleared when someone drives.
   */
  rfdRequestedAt?: string
  rfdRequestedBy?: string
  /**
   * One-shot flag written by POST /api/loops/:id/drive, consumed by the next
   * sendUserText. While set, the next user message is prefixed with a
   * handoff preamble so the model knows the user it's talking to has just
   * changed. Cleared atomically when consumed.
   */
  pendingDriverNote?: { from: string; to: string; at: string }
  repo?: string
  branch?: string
  config?: {
    default_model?: string
    default_model_source?: "personal" | "workspace"
    default_model_id?: string
    permission_mode?: string
    /**
     * Active profiles for this loop (post-2026-05 composition model).
     * Profiles live in `<LOOPAT_HOME>/context/profiles/<name>/`; each has a
     * profile.json (lists plugin specs) + sibling CLAUDE.md + optional
     * knowledge/. On spawn, loopat orchestrates `claude plugin install` for
     * the union of plugins, concats CLAUDE.mds, mounts knowledge.
     *
     * Order matters: CLAUDE.md fragments concat in declared order (later
     * shadows earlier). "base" profile is always implicit if present, even
     * when this list is empty. Personal CLAUDE.md appends last.
     *
     * Empty / undefined = no profile-driven plugins, base CLAUDE.md only
     * (if it exists), personal CLAUDE.md only. CC still runs.
     *
     * See docs/composition.md.
     */
    profiles?: string[]
    /**
     * Vault selected for this loop. The named vault under
     * `personal/<user>/.loopat/vaults/<vault>/` provides this loop's
     * credentials at runtime. Default: "default". The act of choosing here
     * is the security boundary — other vaults are not exposed inside the
     * sandbox. Set to null only by very old loops created before vaults
     * existed; bwrap treats absent/null as "default" for backward compat.
     */
    vault?: string
    /**
     * If true, /loopat/context/knowledge/ is bound rw instead of ro. Set
     * for loops that exist to distill notes into knowledge.
     */
    knowledge_rw?: boolean
    /**
     * Admin-only flag: bind the entire LOOPAT_HOME/loops/ tree read-only
     * at /loopat/loops/ so this loop can read every other loop's chat
     * history, workdir, meta, etc. — for cross-loop distill. Granted only
     * to admins at create time; cannot be toggled later.
     *
     * Privacy note: this exposes other users' chats and workdirs to the
     * driver of this loop. Don't ship a UI that lets non-admins flip it.
     */
    mount_all_loops?: boolean
    /** Session-scoped goal set via /goal. Displayed in UI and injected into the system prompt. */
    goal?: string
    goalSetAt?: string
    goalStatus?: "active" | "completed"
  }
  /**
   * Archive = "hide + read-only". Hidden from default list, all writes
   * (sendUserText / clear / setProvider / writeTerm / answerQuestions /
   * vault writes) reject. Reads stay open (attach, history, files, term
   * view). Lossless — `unarchive` flips back. See docs/design notes.
   */
  archived?: boolean
  archivedAt?: string
  /**
    * If true, this loop's chat (and only the chat) is readable by anonymous
    * visitors at `/share/:id`. Everything else (workspace, files, kanban, ...)
    * still requires auth. Only the loop's `createdBy` may toggle it.
    */
  public?: boolean
  publicAt?: string
  /**
   * Workspace serve config. When shareEnabled, the loop's workdir is accessible
   * via <id|alias>.<domain>. Two modes: "static" serves files, "port" forwards
   * HTTP to the configured sharePort (10000-20000). Mutually exclusive.
   */
  shareEnabled?: boolean
  shareMode?: "static" | "port"
  shareAlias?: string
  sharePort?: number
  /**
   * Set when the loop was spawned from a chat conversation. The snapshot of
   * the chat history is at loops/<id>/context/chat/<convId>.jsonl (mounted as
   * /loopat/context/chat/<convId>.jsonl inside the sandbox).
   */
  seededFrom?: {
    kind: "chat"
    convId: string
    messageCount: number
    snapshotAt: string
  }
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

/**
 * Who is currently driving this loop — `meta.driver` if set, else the
 * creator. Use this everywhere "whose credentials/permissions" matters.
 * Reserve direct `meta.createdBy` reads for "who owns this loop forever"
 * (archive, public toggle).
 */
export function effectiveDriver(meta: { createdBy: string; driver?: string }): string {
  return meta.driver ?? meta.createdBy
}

export function isDriver(meta: { createdBy: string; driver?: string }, userId: string): boolean {
  return effectiveDriver(meta) === userId
}

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

  // workspace memory dir + stub
  const tm = workspaceMemoryDir()
  await mkdir(tm, { recursive: true })
  const tmIdx = `${tm}/MEMORY.md`
  if (!existsSyncBase(tmIdx)) await writeFile(tmIdx, TEAM_MEMORY_INDEX_STUB)

  // git init notes so vaultWrite auto-commits work locally. Skip if cloned
  // (already a repo). Knowledge stays plain unless cloned.
  if (!n.cloned) await gitInitIfMissing(workspaceNotesDir())
  // suppress unused warning for k.cloned (kept for symmetry / future use)
  void k

  // Per-loop worktrees push back here via `git push . HEAD:<trunk>`. Allow
  // pushing to the currently checked-out branch (ref-only update). The
  // companion post-receive hook then resets the primary worktree to the
  // new ref so its working dir doesn't go stale. `updateInstead` would race
  // on the primary worktree under concurrent pushes — verified empirically.
  for (const dir of [workspaceNotesDir(), workspaceKnowledgeDir()]) {
    if (existsSyncBase(join(dir, ".git"))) {
      try {
        await execFileP("git", ["-C", dir, "config", "receive.denyCurrentBranch", "ignore"])
        const hooksDir = join(dir, ".git", "hooks")
        await mkdir(hooksDir, { recursive: true })
        const hookPath = join(hooksDir, "post-receive")
        await writeFile(hookPath, TRUNK_SYNC_HOOK)
        await chmod(hookPath, 0o755)
      } catch (e: any) {
        console.warn(`[loopat] failed to set up trunk-sync on ${dir}: ${e?.message ?? e}`)
      }
    }
  }
}

// post-receive hook for notes/knowledge primary repos. Pairs with
// receive.denyCurrentBranch=ignore: that lets loop worktrees push to the
// trunk ref but doesn't update primary's working dir, so this hook does it
// via reset --hard. Uses --git-common-dir because $GIT_DIR points at the
// pushing worktree's private gitdir, where HEAD = loop/<id>, not trunk.
const TRUNK_SYNC_HOOK = `#!/bin/sh
set -e
COMMON=$(git rev-parse --git-common-dir)
COMMON=$(cd "$COMMON" && pwd -P)
PRIMARY=$(dirname "$COMMON")
TRUNK_REF=$(sed -n 's|^ref: ||p' "$COMMON/HEAD")
[ -n "$TRUNK_REF" ] || exit 0

while read oldrev newrev refname; do
  if [ "$refname" = "$TRUNK_REF" ]; then
    git --git-dir="$COMMON" --work-tree="$PRIMARY" reset --hard "$newrev" >/dev/null
  fi
done
`

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
 * Two paths:
 *
 * 1. Default (auto-init). User provides a *clean* repo URL (no git-crypt
 *    config and no tracked `.loopat/vaults/**`). Server clones, runs
 *    `git-crypt init`, writes `.gitattributes` + `.gitignore`, commits the
 *    scaffold, and pushes. The newly-generated symmetric key is saved under
 *    `host-secrets/<user>/git-crypt.key` AND returned to the caller exactly
 *    once so the UI can show it for backup.
 *
 * 2. Recovery (BYOK). User pastes a base64-encoded git-crypt key in
 *    `cryptKey`. Repo must already be a git-crypt'd loopat repo (typical
 *    case: same user, new host). Server runs `git-crypt unlock`, stores the
 *    key under host-secrets/, swaps personal/ in.
 *
 * Anything in between (partially set-up repo, leftover plaintext secrets,
 * git-crypt configured but no key supplied, etc.) is refused with a precise
 * error so the user knows what to fix.
 *
 * Returns { ok: false, error } on any failure; on failure personal/<user>/
 * is left untouched (we clone into a temp dir first).
 */
export async function importPersonalFromRepo(
  userId: string,
  repoUrl: string,
  cryptKey?: string,
): Promise<
  | { ok: true; autoInitialized?: boolean; cryptKey?: string }
  | {
      ok: false
      error: string
      needsCryptKey?: boolean
      notClean?: boolean
      secretsExposed?: boolean
      exposedFiles?: string[]
    }
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
  const gitSsh = sshCommandForUser(userId)
  try {
    await execFileP("git", ["clone", "--", repoUrl, tmp], {
      env: { ...process.env, GIT_SSH_COMMAND: gitSsh },
    })
  } catch (e: any) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    const msg = (e?.stderr || e?.message || String(e)).toString().trim().split("\n").slice(-3).join(" ")
    return { ok: false, error: `clone failed: ${msg}` }
  }

  // Exposure check (always, regardless of path): refuse to adopt a repo whose
  // .loopat/vaults/** are plaintext in git. Even with BYOK this is bad —
  // if any single secret blob is plaintext, those secrets are already burned.
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

  const hasGitCrypt = await detectGitCryptEnabled(tmp)
  const trackedSecrets = await listTrackedSecretFiles(tmp)

  if (cryptKey?.trim()) {
    // ── BYOK / recovery path ──
    if (!hasGitCrypt) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
      return {
        ok: false,
        error:
          "you provided a crypt key but this repo has no git-crypt config — leave the key field empty to let loopat initialize the repo, or point at the right repo",
      }
    }
    const unlockResult = await unlockWithCryptKey(tmp, userId, cryptKey)
    if (!unlockResult.ok) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
      return { ok: false, error: unlockResult.error }
    }
    return await swapPersonalDir(userId, tmp)
  }

  // ── Default / auto-init path ──
  // Require a strictly clean repo: no git-crypt config, no tracked secrets.
  if (hasGitCrypt) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    return {
      ok: false,
      notClean: true,
      error:
        "this repo already has git-crypt configured — either point at a fresh empty repo, or paste your existing crypt key under Recovery to import it",
    }
  }
  if (trackedSecrets.length > 0) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    return {
      ok: false,
      notClean: true,
      error: `\`.loopat/vaults/\` in this repo isn't empty (${trackedSecrets.length} file(s) tracked) — use a fresh repo`,
    }
  }

  const init = await autoInitGitCrypt(tmp, userId)
  if (!init.ok) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    return { ok: false, error: init.error }
  }

  const swap = await swapPersonalDir(userId, tmp)
  if (!swap.ok) return swap
  return { ok: true, autoInitialized: true, cryptKey: init.cryptKey }
}

function sshCommandForUser(userId: string): string {
  const priv = hostDeployKeyPath(userId)
  return `ssh -i ${priv} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null`
}

async function swapPersonalDir(
  userId: string,
  tmp: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const dir = personalDir(userId)
  try {
    await rm(dir, { recursive: true, force: true })
    await rename(tmp, dir)
    const pm = personalMemoryDir(userId)
    await mkdir(pm, { recursive: true })
    const pmIdx = `${pm}/MEMORY.md`
    if (!existsSyncBase(pmIdx)) await writeFile(pmIdx, PERSONAL_MEMORY_INDEX_STUB)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: `swap failed: ${e?.message ?? e}` }
  }
}

/**
 * Server-side bootstrap for a clean personal repo: git-crypt init, write the
 * scaffold (`.gitattributes`, `.gitignore`, `.loopat/vaults/default/.gitkeep`),
 * commit, push, and stash the freshly-generated symmetric key under
 * host-secrets/<user>/. Returns the key base64-encoded so the UI can show it
 * to the user exactly once for backup.
 *
 * On any failure (clone tampered, push permission missing, git-crypt missing)
 * the saved host-secrets key is rolled back so a retry starts from scratch.
 */
async function autoInitGitCrypt(
  repoDir: string,
  userId: string,
): Promise<{ ok: true; cryptKey: string } | { ok: false; error: string }> {
  // git-crypt must be on the host; check early with a useful error
  try {
    await execFileP("git-crypt", ["--version"])
  } catch {
    return {
      ok: false,
      error: "git-crypt not installed on host (sudo apt install git-crypt / brew install git-crypt)",
    }
  }

  // Local-only commit author so this doesn't depend on global git config
  try {
    await execFileP("git", ["-C", repoDir, "config", "user.email", "loopat@local"])
    await execFileP("git", ["-C", repoDir, "config", "user.name", "loopat"])
  } catch (e: any) {
    return { ok: false, error: `git config failed: ${e?.message ?? e}` }
  }

  try {
    await execFileP("git-crypt", ["init"], { cwd: repoDir })
  } catch (e: any) {
    const stderr = (e?.stderr ?? "").toString().trim()
    return { ok: false, error: `git-crypt init failed: ${stderr || e?.message || e}` }
  }

  // Merge .gitattributes (preserve any existing lines, e.g. LFS / line endings).
  await appendLineIfMissing(
    join(repoDir, ".gitattributes"),
    ".loopat/vaults/** filter=git-crypt diff=git-crypt",
    (existing, line) => existing.includes(line),
  )

  // Merge .gitignore so host-only state under .loopat/host/ never gets pushed
  await appendLineIfMissing(
    join(repoDir, ".gitignore"),
    "/.loopat/host/",
    (existing, line) =>
      existing.split("\n").some((l) => l.trim() === line || l.trim() === ".loopat/host/"),
  )

  // Scaffold vaults/default/ so future writes land in a tracked directory.
  // New imports start in the new layout; legacy `secrets/` is only consulted
  // for users who imported before vaults existed.
  await mkdir(join(repoDir, ".loopat/vaults/default"), { recursive: true })
  await writeFile(join(repoDir, ".loopat/vaults/default/.gitkeep"), "")

  // Ship the memory index in the scaffold commit so cloning onto a second
  // host doesn't depend on swapPersonalDir's late top-up.
  await mkdir(join(repoDir, "memory"), { recursive: true })
  if (!existsSyncBase(join(repoDir, "memory/MEMORY.md"))) {
    await writeFile(join(repoDir, "memory/MEMORY.md"), PERSONAL_MEMORY_INDEX_STUB)
  }

  // Export the key BEFORE pushing so a push failure rolls back to a state
  // that knows whether we had the key at all
  let cryptKeyB64: string
  let keyBuf: Buffer
  try {
    const exportPath = join(repoDir, ".git", "git-crypt-export.key")
    await execFileP("git-crypt", ["export-key", exportPath], { cwd: repoDir })
    keyBuf = await readFile(exportPath)
    cryptKeyB64 = keyBuf.toString("base64")
    await rm(exportPath, { force: true })
  } catch (e: any) {
    const stderr = (e?.stderr ?? "").toString().trim()
    return { ok: false, error: `git-crypt export-key failed: ${stderr || e?.message || e}` }
  }

  // Persist to host-secrets BEFORE push so loop start-up code can find it
  // even if push partially succeeded. We undo on push failure below.
  const { saveGitCryptKey } = await import("./git-crypt-key")
  try {
    await saveGitCryptKey(userId, keyBuf)
  } catch (e: any) {
    return { ok: false, error: `failed to save git-crypt key: ${e?.message ?? e}` }
  }

  // Stage + commit
  try {
    await execFileP("git", [
      "-C",
      repoDir,
      "add",
      ".gitattributes",
      ".gitignore",
      ".loopat",
      "memory",
    ])
    await execFileP("git", [
      "-C",
      repoDir,
      "commit",
      "-m",
      "loopat: initialize personal vault (git-crypt enabled)",
    ])
  } catch (e: any) {
    await rollbackSavedKey(userId)
    const stderr = (e?.stderr ?? "").toString().trim()
    return { ok: false, error: `commit failed: ${stderr || e?.message || e}` }
  }

  // Determine target branch: prefer existing local HEAD (carries remote's
  // default); fall back to "main" for the empty-repo case where there's no
  // symbolic ref to follow.
  let branch = "main"
  try {
    const { stdout } = await execFileP("git", ["-C", repoDir, "symbolic-ref", "--short", "HEAD"])
    const v = stdout.trim()
    if (v) branch = v
  } catch {}

  try {
    await execFileP("git", ["-C", repoDir, "push", "origin", `HEAD:${branch}`], {
      env: { ...process.env, GIT_SSH_COMMAND: sshCommandForUser(userId) },
    })
  } catch (e: any) {
    await rollbackSavedKey(userId)
    const stderr = (e?.stderr ?? "").toString().trim()
    const hint = /denied|read.only|permission/i.test(stderr)
      ? " (does the deploy key have write access?)"
      : ""
    return { ok: false, error: `push failed${hint}: ${stderr || e?.message || e}` }
  }

  return { ok: true, cryptKey: cryptKeyB64 }
}

async function rollbackSavedKey(userId: string) {
  const { rm: rmFile } = await import("node:fs/promises")
  await rmFile(personalGitCryptKeyPath(userId), { force: true }).catch(() => {})
}

async function appendLineIfMissing(
  path: string,
  line: string,
  alreadyPresent: (existing: string, line: string) => boolean,
) {
  let existing = ""
  try {
    existing = await readFile(path, "utf8")
  } catch {}
  if (alreadyPresent(existing, line)) return
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n"
  await writeFile(path, existing + sep + line + "\n")
}

async function listTrackedSecretFiles(repoDir: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP("git", [
      "-C",
      repoDir,
      "ls-files",
      "-z",
      ".loopat/vaults",
    ])
    return stdout
      .split("\0")
      .filter(Boolean)
      // Scaffold marker files are not real content; ignore them.
      .filter((f) => !f.endsWith("/.gitkeep"))
  } catch {
    return []
  }
}

export type PersonalDirtyStatus = {
  uncommitted: number
  unpushed: number
  isGitRepo: boolean
  hasRemote: boolean
}

/**
 * Inspect personal/<user>/: how many uncommitted worktree changes, how many
 * commits not reachable from any remote-tracking branch. Used as the
 * pre-flight before a destructive delete.
 *
 * Returns counts only; the caller decides what "dirty" means (we treat
 * uncommitted > 0 || unpushed > 0 as dirty).
 */
export async function inspectPersonalDirty(userId: string): Promise<PersonalDirtyStatus> {
  const dir = personalDir(userId)
  if (!existsSyncBase(dir) || !existsSyncBase(join(dir, ".git"))) {
    return { uncommitted: 0, unpushed: 0, isGitRepo: false, hasRemote: false }
  }
  let hasRemote = false
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "remote"])
    hasRemote = stdout.trim().length > 0
  } catch {}

  // Refresh remote-tracking refs so "unpushed" reflects current remote state.
  // Best-effort — offline / no network is fine, we'll just over-report.
  if (hasRemote) {
    try {
      await execFileP("git", ["-C", dir, "fetch", "--quiet", "origin"], {
        env: { ...process.env, GIT_SSH_COMMAND: sshCommandForUser(userId) },
        timeout: 15_000,
      })
    } catch {}
  }

  let uncommitted = 0
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "status", "--porcelain"])
    uncommitted = stdout.split("\n").filter((l) => l.trim().length > 0).length
  } catch {}

  let unpushed = 0
  try {
    // Commits on HEAD not reachable from any remote-tracking branch.
    const { stdout } = await execFileP("git", [
      "-C",
      dir,
      "rev-list",
      "--count",
      "HEAD",
      "--not",
      "--remotes",
    ])
    unpushed = parseInt(stdout.trim(), 10) || 0
  } catch {
    // No commits at all on HEAD → rev-list errors; treat as 0
  }

  return { uncommitted, unpushed, isGitRepo: true, hasRemote }
}

/**
 * Stage + commit + push everything in personal/<user>/. Best-effort. If
 * there's nothing to commit but there are unpushed commits, just push.
 */
export async function syncPersonalToRemote(
  userId: string,
): Promise<{ ok: true } | { ok: false, error: string }> {
  const dir = personalDir(userId)
  if (!existsSyncBase(join(dir, ".git"))) {
    return { ok: false, error: "personal/ is not a git repo — nothing to sync to" }
  }

  // Author must be set for the commit step. Set locally so we don't rely
  // on the host's global git config.
  try {
    await execFileP("git", ["-C", dir, "config", "user.email", "loopat@local"])
    await execFileP("git", ["-C", dir, "config", "user.name", "loopat"])
  } catch (e: any) {
    return { ok: false, error: `git config failed: ${e?.message ?? e}` }
  }

  // Stage everything
  try {
    await execFileP("git", ["-C", dir, "add", "-A"])
  } catch (e: any) {
    return { ok: false, error: `git add failed: ${e?.stderr ?? e?.message ?? e}` }
  }

  // Commit if there's anything staged. `git diff --cached --quiet` exits
  // non-zero when there are staged changes, so we invert the check.
  let hadStaged = false
  try {
    await execFileP("git", ["-C", dir, "diff", "--cached", "--quiet"])
  } catch {
    hadStaged = true
  }
  if (hadStaged) {
    try {
      await execFileP("git", [
        "-C",
        dir,
        "commit",
        "-m",
        "loopat: sync personal vault before delete",
      ])
    } catch (e: any) {
      return { ok: false, error: `commit failed: ${e?.stderr ?? e?.message ?? e}` }
    }
  }

  // Determine target branch
  let branch = "main"
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "symbolic-ref", "--short", "HEAD"])
    const v = stdout.trim()
    if (v) branch = v
  } catch {}

  // Need an origin to push to. If there's no remote (e.g. the user never
  // imported, personal/ is the local-only scaffold), refuse — sync is
  // impossible. Caller can still force-delete.
  let hasOrigin = false
  try {
    await execFileP("git", ["-C", dir, "remote", "get-url", "origin"])
    hasOrigin = true
  } catch {}
  if (!hasOrigin) {
    return { ok: false, error: "no remote configured — nothing to sync to" }
  }

  try {
    await execFileP("git", ["-C", dir, "push", "origin", `HEAD:${branch}`], {
      env: { ...process.env, GIT_SSH_COMMAND: sshCommandForUser(userId) },
    })
  } catch (e: any) {
    const stderr = (e?.stderr ?? "").toString().trim()
    return { ok: false, error: `push failed: ${stderr || e?.message || e}` }
  }
  return { ok: true }
}

/**
 * Pull from remote. Best-effort: fetches and merges. If there are conflicts,
 * returns conflict details so the UI can let the user choose.
 */
export type PersonalPullResult =
  | { ok: true; message: string }
  | { ok: false; error: string; conflicts?: string[]; needsStash?: boolean }

export async function pullPersonalFromRemote(
  userId: string,
): Promise<PersonalPullResult> {
  const dir = personalDir(userId)
  if (!existsSyncBase(join(dir, ".git"))) {
    return { ok: false, error: "personal/ is not a git repo" }
  }

  let hasOrigin = false
  try {
    await execFileP("git", ["-C", dir, "remote", "get-url", "origin"])
    hasOrigin = true
  } catch {}
  if (!hasOrigin) {
    return { ok: false, error: "no remote configured" }
  }

  // Determine current branch
  let branch = "main"
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "symbolic-ref", "--short", "HEAD"])
    const v = stdout.trim()
    if (v) branch = v
  } catch {}

  // Check for uncommitted changes
  let uncommitted = 0
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "status", "--porcelain"])
    uncommitted = stdout.split("\n").filter((l) => l.trim().length > 0).length
  } catch {}

  if (uncommitted > 0) {
    // Stash changes before pull
    try {
      await execFileP("git", ["-C", dir, "stash", "push", "-m", "loopat: auto-stash before pull"])
    } catch (e: any) {
      return { ok: false, error: `stash failed: ${e?.stderr ?? e?.message ?? e}`, needsStash: true }
    }
  }

  // Fetch
  try {
    await execFileP("git", ["-C", dir, "fetch", "origin"], {
      env: { ...process.env, GIT_SSH_COMMAND: sshCommandForUser(userId) },
      timeout: 30_000,
    })
  } catch (e: any) {
    return { ok: false, error: `fetch failed: ${e?.stderr ?? e?.message ?? e}` }
  }

  // Merge
  try {
    await execFileP("git", ["-C", dir, "merge", `origin/${branch}`])
  } catch (e: any) {
    const stderr = (e?.stderr ?? "").toString()
    if (stderr.includes("CONFLICT")) {
      // Extract conflicted files
      const conflicts: string[] = []
      const lines = stderr.split("\n")
      for (const line of lines) {
        const match = line.match(/CONFLICT\s*\(.*?\):\s*Merge conflict in\s*(.+)/)
        if (match) conflicts.push(match[1].trim())
      }
      // Also check git status for conflicts
      try {
        const { stdout } = await execFileP("git", ["-C", dir, "diff", "--name-only", "--diff-filter=U"])
        const statusConflicts = stdout.split("\n").filter((l) => l.trim())
        conflicts.push(...statusConflicts)
      } catch {}
      return { ok: false, error: "merge conflicts", conflicts: [...new Set(conflicts)] }
    }
    return { ok: false, error: `merge failed: ${stderr || e?.message || e}` }
  }

  // Pop stash if we stashed earlier
  if (uncommitted > 0) {
    try {
      await execFileP("git", ["-C", dir, "stash", "pop"])
    } catch (e: any) {
      // Stash pop conflict — user will need to resolve manually
      return { ok: false, error: `pull succeeded but stash pop failed: ${e?.stderr ?? e?.message ?? e}. Your changes are still in stash.`, needsStash: true }
    }
  }

  return { ok: true, message: "pulled successfully" }
}

/**
 * Push to remote. Stages, commits, and pushes. Returns conflict/error details.
 */
export type PersonalPushResult =
  | { ok: true; message: string }
  | { ok: false; error: string; needsPull?: boolean }

export async function pushPersonalToRemote(
  userId: string,
): Promise<PersonalPushResult> {
  const dir = personalDir(userId)
  if (!existsSyncBase(join(dir, ".git"))) {
    return { ok: false, error: "personal/ is not a git repo" }
  }

  // Author must be set
  try {
    await execFileP("git", ["-C", dir, "config", "user.email", "loopat@local"])
    await execFileP("git", ["-C", dir, "config", "user.name", "loopat"])
  } catch (e: any) {
    return { ok: false, error: `git config failed: ${e?.message ?? e}` }
  }

  // Stage everything
  try {
    await execFileP("git", ["-C", dir, "add", "-A"])
  } catch (e: any) {
    return { ok: false, error: `git add failed: ${e?.stderr ?? e?.message ?? e}` }
  }

  // Commit if there's anything staged
  let hadStaged = false
  try {
    await execFileP("git", ["-C", dir, "diff", "--cached", "--quiet"])
  } catch {
    hadStaged = true
  }
  if (hadStaged) {
    try {
      await execFileP("git", ["-C", dir, "commit", "-m", "loopat: sync personal vault"])
    } catch (e: any) {
      return { ok: false, error: `commit failed: ${e?.stderr ?? e?.message ?? e}` }
    }
  }

  // Determine target branch
  let branch = "main"
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "symbolic-ref", "--short", "HEAD"])
    const v = stdout.trim()
    if (v) branch = v
  } catch {}

  // Need an origin
  let hasOrigin = false
  try {
    await execFileP("git", ["-C", dir, "remote", "get-url", "origin"])
    hasOrigin = true
  } catch {}
  if (!hasOrigin) {
    return { ok: false, error: "no remote configured" }
  }

  try {
    await execFileP("git", ["-C", dir, "push", "origin", `HEAD:${branch}`], {
      env: { ...process.env, GIT_SSH_COMMAND: sshCommandForUser(userId) },
    })
  } catch (e: any) {
    const stderr = (e?.stderr ?? "").toString().trim()
    if (stderr.includes("non-fast-forward") || stderr.includes("rejected") || stderr.includes("pull")) {
      return { ok: false, error: `push rejected: remote has newer commits`, needsPull: true }
    }
    return { ok: false, error: `push failed: ${stderr || e?.message || e}` }
  }

  return { ok: true, message: hadStaged ? "committed and pushed" : "pushed (no new changes)" }
}

// ── Generic repo sync (knowledge / notes / repos) ─────────────────────
//
// Distinct from personal sync above: these workspace-level repos use the
// host's default SSH config (whatever the server clone used at boot), NOT
// a per-user deploy key. Strict ff-only on both directions — by design no
// one edits these outside of loopat, so divergence is treated as an error
// to investigate, not auto-resolved.

export type RepoSyncStatus = {
  isGitRepo: boolean
  hasRemote: boolean
  branch: string
  ahead: number
  behind: number
  uncommitted: number
}

export type RepoSyncResult =
  | { ok: true; message: string }
  | { ok: false; error: string }

/**
 * Best-effort fetch then count ahead/behind vs origin/<branch>. Fetch
 * failures are tolerated (offline / auth glitch) — status still reflects
 * last-known remote state.
 */
export async function inspectRepoSync(dir: string): Promise<RepoSyncStatus> {
  if (!existsSyncBase(dir) || !existsSyncBase(join(dir, ".git"))) {
    return { isGitRepo: false, hasRemote: false, branch: "", ahead: 0, behind: 0, uncommitted: 0 }
  }

  let branch = ""
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "symbolic-ref", "--short", "HEAD"])
    branch = stdout.trim()
  } catch {}

  let hasRemote = false
  try {
    await execFileP("git", ["-C", dir, "remote", "get-url", "origin"])
    hasRemote = true
  } catch {}

  if (hasRemote) {
    try {
      await execFileP("git", ["-C", dir, "fetch", "--quiet", "origin"], { timeout: 15_000 })
    } catch {}
  }

  let uncommitted = 0
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "status", "--porcelain"])
    uncommitted = stdout.split("\n").filter((l) => l.trim().length > 0).length
  } catch {}

  let ahead = 0
  let behind = 0
  if (hasRemote && branch) {
    try {
      const { stdout } = await execFileP("git", [
        "-C", dir, "rev-list", "--left-right", "--count", `origin/${branch}...${branch}`,
      ])
      const m = stdout.trim().match(/^(\d+)\s+(\d+)$/)
      if (m) { behind = parseInt(m[1], 10); ahead = parseInt(m[2], 10) }
    } catch {}
  }

  return { isGitRepo: true, hasRemote, branch, ahead, behind, uncommitted }
}

/**
 * Fetch + ff-only merge into the current HEAD. Aborts on uncommitted
 * changes (we don't auto-stash workspace repos — caller decides) and on
 * any non-ff condition.
 */
export async function pullRepoFromRemote(dir: string): Promise<RepoSyncResult> {
  if (!existsSyncBase(join(dir, ".git"))) {
    return { ok: false, error: "not a git repo" }
  }

  let hasRemote = false
  try {
    await execFileP("git", ["-C", dir, "remote", "get-url", "origin"])
    hasRemote = true
  } catch {}
  if (!hasRemote) return { ok: false, error: "no remote configured" }

  let branch = ""
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "symbolic-ref", "--short", "HEAD"])
    branch = stdout.trim()
  } catch {}
  if (!branch) return { ok: false, error: "HEAD is detached" }

  let uncommitted = 0
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "status", "--porcelain"])
    uncommitted = stdout.split("\n").filter((l) => l.trim().length > 0).length
  } catch {}
  if (uncommitted > 0) {
    return { ok: false, error: `aborted: ${uncommitted} uncommitted change(s) in primary` }
  }

  try {
    await execFileP("git", ["-C", dir, "fetch", "origin"], { timeout: 30_000 })
  } catch (e: any) {
    return { ok: false, error: `fetch failed: ${e?.stderr ?? e?.message ?? e}` }
  }

  try {
    await execFileP("git", ["-C", dir, "merge", "--ff-only", `origin/${branch}`])
  } catch (e: any) {
    const stderr = (e?.stderr ?? "").toString().trim()
    return { ok: false, error: `merge --ff-only failed (diverged from origin/${branch}?): ${stderr || e?.message || e}` }
  }

  return { ok: true, message: `pulled origin/${branch}` }
}

/**
 * Push current HEAD branch to origin. Plain `git push` — git refuses
 * non-ff by default, which is exactly the abort-on-conflict behavior we
 * want. Caller pulls first if rejected.
 */
export async function pushRepoToRemote(dir: string): Promise<RepoSyncResult> {
  if (!existsSyncBase(join(dir, ".git"))) {
    return { ok: false, error: "not a git repo" }
  }

  let hasRemote = false
  try {
    await execFileP("git", ["-C", dir, "remote", "get-url", "origin"])
    hasRemote = true
  } catch {}
  if (!hasRemote) return { ok: false, error: "no remote configured" }

  let branch = ""
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "symbolic-ref", "--short", "HEAD"])
    branch = stdout.trim()
  } catch {}
  if (!branch) return { ok: false, error: "HEAD is detached" }

  try {
    await execFileP("git", ["-C", dir, "push", "origin", `HEAD:${branch}`])
  } catch (e: any) {
    const stderr = (e?.stderr ?? "").toString().trim()
    return { ok: false, error: `push failed: ${stderr || e?.message || e}` }
  }

  return { ok: true, message: `pushed to origin/${branch}` }
}

/**
 * Wipe personal/<user>/ AND the saved git-crypt key. Deploy keypair stays
 * (it's the SSH identity, reusable for the next import). Re-scaffolds an
 * empty git-init'd personal/<user>/ so workspace bind paths still resolve.
 */
export async function deletePersonalVault(userId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const dir = personalDir(userId)
  try {
    await rm(dir, { recursive: true, force: true })
  } catch (e: any) {
    return { ok: false, error: `rm personal/ failed: ${e?.message ?? e}` }
  }
  const { rm: rmFile } = await import("node:fs/promises")
  await rmFile(personalGitCryptKeyPath(userId), { force: true }).catch(() => {})

  // Re-scaffold empty so the workspace doesn't have a hole. Mirrors
  // provisionUserPersonal but without re-running deploy-key gen.
  try {
    await mkdir(dir, { recursive: true })
    const pm = personalMemoryDir(userId)
    await mkdir(pm, { recursive: true })
    const pmIdx = `${pm}/MEMORY.md`
    if (!existsSyncBase(pmIdx)) await writeFile(pmIdx, PERSONAL_MEMORY_INDEX_STUB)
    await gitInitIfMissing(dir)
  } catch (e: any) {
    return { ok: false, error: `re-scaffold failed: ${e?.message ?? e}` }
  }
  return { ok: true }
}

// git-crypt's per-file magic header (10 bytes): \x00 G I T C R Y P T \x00
const GIT_CRYPT_MAGIC = Buffer.from([0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0x00])

/**
 * Returns tracked files under `.loopat/vaults/**` that are stored as
 * plaintext (i.e., the worktree blob doesn't start with the git-crypt magic
 * header). Reads the worktree directly: in a fresh clone where git-crypt
 * isn't unlocked, the worktree contents ARE the raw blobs, so non-encrypted
 * files are visibly plaintext here.
 */
async function detectExposedSecrets(repoDir: string): Promise<string[]> {
  // Anything under `.loopat/vaults/` stored as plaintext is an exposure and
  // refuses import.
  //
  // Symlinks are skipped: git stores a symlink's target as the blob, and
  // git-crypt's filter doesn't (and can't) encrypt that. The target path
  // itself isn't a secret value — and walkVaultFiles refuses to bind any
  // symlink whose realpath escapes personal/<user>/.
  const exposed: string[] = []
  let stdout = ""
  try {
    const r = await execFileP("git", ["-C", repoDir, "ls-files", "-z", ".loopat/vaults"])
    stdout = r.stdout
  } catch {
    return exposed
  }
  const files = stdout.split("\0").filter(Boolean)
  for (const f of files) {
    if (f.endsWith("/.gitkeep")) continue
    try {
      const lst = await lstat(join(repoDir, f))
      if (lst.isSymbolicLink()) continue
      const buf = await readFile(join(repoDir, f))
      if (buf.length === 0) continue
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

/**
 * Idempotently materialize a per-loop git worktree of `repo` at `path` on
 * branch `branchName`. If the path already holds a worktree, no-op. If the
 * source isn't a git repo (e.g., knowledge without a remote), fall back to
 * a symlink so the path still resolves — those loops can't publish, but
 * read access still works.
 */
async function ensureContextWorktree(repo: string, path: string, branchName: string) {
  let stats: Awaited<ReturnType<typeof lstat>> | null = null
  try { stats = await lstat(path) } catch {}
  // Real dir with .git → already a worktree, leave it alone.
  if (stats?.isDirectory() && existsSyncBase(join(path, ".git"))) return

  // Source isn't a git repo — fall back to symlink (legacy shape).
  if (!existsSyncBase(join(repo, ".git"))) {
    try { await rm(path, { recursive: true, force: true }) } catch {}
    await ensureSymlink(path, repo)
    return
  }

  // Stale state (old symlink, empty dir, leftover from manual cleanup) → wipe + create.
  try { await rm(path, { recursive: true, force: true }) } catch {}
  await execFileP("git", ["-C", repo, "worktree", "add", "-b", branchName, path])
}

export async function ensureContextMounts(id: string, createdBy: string) {
  await mkdir(loopContextDir(id), { recursive: true })
  await ensureContextWorktree(workspaceKnowledgeDir(), loopContextKnowledge(id), `loop/${id}`)
  await ensureContextWorktree(workspaceNotesDir(), loopContextNotes(id), `loop/${id}`)
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

// refreshLoopSandbox removed entirely — profile model re-composes every spawn.

async function shortBranchSlug(title: string): Promise<string> {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
  return base || "loop"
}

export async function createLoop(opts: {
  title: string
  repo?: string
  createdBy: string
  profiles?: string[]
  vault?: string
  knowledgeRw?: boolean
  mountAllLoops?: boolean
}): Promise<LoopMeta> {
  await ensureWorkspaceDirs()
  const id = randomUUID()
  const createdAt = new Date().toISOString()
  const meta: LoopMeta = {
    id,
    title: opts.title.trim() || "untitled",
    createdAt,
    createdBy: opts.createdBy,
    driver: opts.createdBy,
    driverHistory: [{ driver: opts.createdBy, since: createdAt }],
  }
  if (opts.profiles && opts.profiles.length > 0) {
    meta.config = { ...(meta.config ?? {}), profiles: opts.profiles }
  }
  if (opts.vault && opts.vault !== "default") {
    meta.config = { ...(meta.config ?? {}), vault: opts.vault }
  }
  if (opts.knowledgeRw) {
    meta.config = { ...(meta.config ?? {}), knowledge_rw: true }
  }
  if (opts.mountAllLoops) {
    meta.config = { ...(meta.config ?? {}), mount_all_loops: true }
  }
  await mkdir(loopDir(id), { recursive: true })
  await mkdir(loopClaudeDir(id), { recursive: true })
  // Compose skills/agents + profile-chain doctrine into .claude/, write
  // settings.json (autoMemory). Plugin resolution happens at spawn time
  // (see session.ts) — SDK loads plugins via its `plugins` option, no
  // loop-local install state needed.
  await composeLoopClaudeConfig(id, opts.createdBy, opts.profiles)
  await writeLoopSettings(id)

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

  await ensureContextMounts(id, effectiveDriver(meta))
  await writeFile(loopMetaPath(id), JSON.stringify(meta, null, 2))
  return meta
}

/**
 * Spawn a child "distill loop" from a source loop. The child's workdir gets
 * a point-in-time snapshot of the source's conversation files plus a
 * project-tier CLAUDE.md telling the AI it's a distill loop. Knowledge is
 * rw so the child can publish sedimented insights. The source is not
 * touched. Any authenticated user may distill any loop — distill is a
 * read-only relationship.
 */
export async function distillLoop(sourceId: string, byUser: string): Promise<LoopMeta> {
  const source = await getLoop(sourceId)
  if (!source) throw new Error(`source loop ${sourceId} not found`)

  const shortId = source.id.slice(0, 6)
  const child = await createLoop({
    title: `distill: ${shortId} ${source.title}`,
    createdBy: byUser,
    knowledgeRw: true,
  })

  // Snapshot the source's conversation into the child's workdir.
  const sourceDir = join(loopWorkdir(child.id), "source")
  await mkdir(sourceDir, { recursive: true })
  for (const [from, to] of [
    [loopHistoryPath(sourceId), join(sourceDir, "messages.jsonl")],
    [loopChatHistoryPath(sourceId), join(sourceDir, "chat_history.jsonl")],
  ]) {
    if (existsSyncBase(from)) {
      await copyFile(from, to)
    }
  }

  // Drop the distill kind's project-tier CLAUDE.md into the workdir. Claude
  // Code auto-loads <workdir>/CLAUDE.md (settingSources includes "project").
  const tmpl = loopKindClaudePath("distill")
  if (existsSyncBase(tmpl)) {
    await copyFile(tmpl, join(loopWorkdir(child.id), "CLAUDE.md"))
  }

  return child
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
        await ensureContextMounts(id, effectiveDriver(meta))
        count++
      } catch {}
    }
  } catch {}
  return count
}
