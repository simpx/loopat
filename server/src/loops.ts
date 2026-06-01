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
  workspaceOriginsDir,
  workspaceOriginPath,
  personalDir,
  personalKnowledgeDir,
  personalNotesDir,
  personalReposDir,
  personalRepoDir,
  personalVaultDir,
  uiNotesDir,
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
import { loadConfig, loadPersonalConfig, loadKnowledgeConfig } from "./config"
import { ensurePersonalKeypair } from "./personal-keys"
import { composeLoopClaudeConfig, writeLoopSettings } from "./compose"
import { getProvider } from "./git-host"
import { loadExtensionProviders } from "./providers" // also registers built-in providers

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
  /**
   * Context-setup problems captured at loop creation (e.g. the per-user
   * knowledge/notes clone failed — bad/again-missing key, no access). Surfaced
   * as a banner in the loop UI so the user isn't left with a silently-empty
   * context. Empty/absent = context set up cleanly.
   */
  contextWarnings?: string[]
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
   * Free-form key/value metadata attached by the caller of the v1 Loop API.
   * Not interpreted by loopat; not exposed to the sandbox. Used by external
   * integrations (e.g. a bot framework storing "slack_thread: C123:1234").
   * Capped at 16 KB JSON-serialized.
   */
  metadata?: Record<string, unknown>
  /**
    * If true, this loop's chat (and only the chat) is readable by anonymous
    * visitors at `/share/:id`. Everything else (workspace, files, kanban, ...)
    * still requires auth. Only the loop's `createdBy` may toggle it.
    */
  public?: boolean
  publicAt?: string
  /**
   * Workspace serve config. When shareEnabled, the loop's workdir is accessible
   * via one of three modes:
   *
   *  - "static"    — serve container streams workdir files via subdomain
   *  - "port"      — serve container HTTP-proxies to sharePort via subdomain
   *  - "direct"    — port-proxy container TCP/UDP-relays a fixed external
   *                  port (shareExternalPort) to sharePort
   *  - "ephemeral" — the loop container itself publishes sharePort via
   *                  `-p :<sharePort>`, kernel-assigned host port that
   *                  changes on every container restart. No port-proxy.
   *                  Read the current host port via `podman port`.
   */
  shareEnabled?: boolean
  shareMode?: "static" | "port" | "ephemeral"
  shareAlias?: string
  sharePort?: number
  /** External port for direct TCP/UDP access (see port-proxy). */
  shareExternalPort?: number
  /** Protocol for shareExternalPort: "tcp" (default), "udp", or "static". */
  shareProtocol?: "tcp" | "udp" | "static"
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
  /**
   * Last metadata received from the external runtime gateway. Written by
   * `recordExternalMeta` on each turn so the UI / admin can see which
   * external platform and user this loop serves. Only present on loops
   * created via the gateway SSE API.
   */
  lastExternalMeta?: {
    source: string | null
    userId: string | null
    metadata: Record<string, unknown> | null
    traceId: string | null
    at: string
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

/**
 * Derive the ephemeral `-p` set to pass into the loop's container at create
 * time. Returns an empty list unless the loop is in "ephemeral" share mode
 * with a valid internal port. Static mode and the legacy "port"/"direct"
 * modes don't touch the loop container's own port mappings (they go via
 * the serve / port-proxy containers instead).
 */
export function loopEphemeralPorts(
  meta: Pick<LoopMeta, "shareEnabled" | "shareMode" | "sharePort" | "shareProtocol">,
): { internalPort: number; protocol?: "tcp" | "udp" }[] {
  if (!meta.shareEnabled || meta.shareMode !== "ephemeral" || !meta.sharePort) return []
  const proto = meta.shareProtocol === "udp" ? "udp" : "tcp"
  return [{ internalPort: meta.sharePort, protocol: proto }]
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
 * Materialize a context repo (knowledge / notes) with an `origin` to pull/push.
 * Remote backend: clone the configured git url. Local backend (no url): loopat
 * hosts the remote itself — a bare repo at origins/<name>.git becomes `origin`
 * (docs/context-flow.md "solo"). Either way the working dir ends up a git repo
 * with `origin` set, so the symmetric pull/push model just works.
 */
async function ensureContextRepo(dir: string, name: string, url?: string): Promise<void> {
  if (url && (await isEmptyOrMissing(dir))) {
    try {
      try { await rm(dir, { recursive: true, force: true }) } catch {}
      await mkdir(join(dir, ".."), { recursive: true })
      await execFileP("git", ["clone", "--", url, dir])
      console.log(`[loopat] cloned ${url} → ${dir}`)
      return
    } catch (e: any) {
      console.warn(`[loopat] clone failed (${url}): ${e?.stderr ?? e?.message ?? e} — falling back to local origin`)
    }
  }
  // Local backend: loopat-hosted bare origin.
  const bare = workspaceOriginPath(name)
  if (!existsSyncBase(join(bare, "HEAD"))) {
    await mkdir(workspaceOriginsDir(), { recursive: true })
    try {
      await execFileP("git", ["init", "--bare", "-b", "main", bare])
    } catch (e: any) {
      console.warn(`[loopat] bare init failed (${bare}): ${e?.message ?? e}`)
    }
  }
  if (await isEmptyOrMissing(dir)) {
    try { await rm(dir, { recursive: true, force: true }) } catch {}
    await mkdir(join(dir, ".."), { recursive: true })
    try {
      await execFileP("git", ["clone", "--", bare, dir])
    } catch {
      await mkdir(dir, { recursive: true })
      await execFileP("git", ["-C", dir, "init", "-q", "-b", "main"]).catch(() => {})
      await execFileP("git", ["-C", dir, "remote", "add", "origin", bare]).catch(() => {})
    }
  } else if (existsSyncBase(join(dir, ".git"))) {
    const hasOrigin = await execFileP("git", ["-C", dir, "remote", "get-url", "origin"]).then(() => true).catch(() => false)
    if (!hasOrigin) await execFileP("git", ["-C", dir, "remote", "add", "origin", bare]).catch(() => {})
  } else {
    // non-empty dir that isn't a git repo yet (e.g. a freshly-scaffolded
    // personal/) → init in place and point it at the local bare origin.
    await execFileP("git", ["-C", dir, "init", "-q", "-b", "main"]).catch(() => {})
    await execFileP("git", ["-C", dir, "remote", "add", "origin", bare]).catch(() => {})
  }
}

/**
 * The personal repo is self-describing: its `.loopat/config.json` declares the
 * authoritative kn/notes remotes, and a loop connects to them with the user's
 * OWN key from the selected vault (`vaults/<vault>/mounts/home/.ssh/id`), not
 * the host's ssh. Called at loop creation, which has the user + vault in hand.
 *
 * The startup clone (driven by host config.json) stays as a display mirror;
 * here the personal-declared url wins and becomes the context repo's origin.
 *
 * It sets the origin, fetches with the vault key (host-side), AND persists a
 * `core.sshCommand` pointing at the vault key's SANDBOX path so the AI's
 * promote (git push from inside the sandbox) authenticates as the user with no
 * interactive host-key prompt. Host-side git overrides that config via
 * GIT_SSH_COMMAND (env beats config), so the sandbox path is never used here.
 */
export async function ensureUserContext(user: string, vault: string = "default"): Promise<string[]> {
  const errors: string[] = []
  const cfg = await loadPersonalConfig(user, vault)
  const sshEnv = { ...process.env, GIT_SSH_COMMAND: sshCommandForUser(user, vault) }
  // Sandbox-side promote: core.sshCommand points at the vault key's SANDBOX path
  // (/loopat/home/<user>/.ssh/id, where the vault home-mount lands) with
  // accept-new, so the AI's `git push` inside the sandbox authenticates as the
  // user without an interactive host-key prompt. Host-side ops override this
  // with GIT_SSH_COMMAND (env beats config), so the sandbox path is never used
  // server-side.
  const sandboxKey = `/loopat/home/${user}/.ssh/id`
  // Clone-or-sync a PER-USER context main repo from `url` with the vault key.
  // STRICT, per the context model: personal wins even when empty — an empty url
  // means the dir is REMOVED so the loop sees nothing (no fallback to any
  // workspace default). Returns whether the repo exists afterwards.
  const ensurePerUserRepo = async (dir: string, url: string | undefined, label: string): Promise<boolean> => {
    if (!url) {
      try { await rm(dir, { recursive: true, force: true }) } catch {}
      return false
    }
    if (existsSyncBase(join(dir, ".git"))) {
      const has = await execFileP("git", ["-C", dir, "remote", "get-url", "origin"]).then(() => true).catch(() => false)
      await execFileP("git", ["-C", dir, "remote", has ? "set-url" : "add", "origin", url]).catch(() => {})
    } else {
      try { await rm(dir, { recursive: true, force: true }) } catch {}
      await mkdir(join(dir, ".."), { recursive: true })
      try {
        await execFileP("git", ["clone", "--", url, dir], { env: sshEnv, timeout: 60_000 })
        console.log(`[loopat] cloned per-user context ${url} → ${dir}`)
      } catch (e: any) {
        // Concise reason for the UI warning: prefer the meaningful failure line
        // (e.g. "Permission denied (publickey)") over git's trailing boilerplate
        // ("…and the repository exists."), which reads as a false all-clear.
        const lines = (e?.stderr ?? e?.message ?? String(e)).toString().split("\n").map((s: string) => s.trim()).filter(Boolean)
        const reason = lines.find((l: string) => /permission denied|fatal:|not found|could not read|access denied|authentication failed|host key/i.test(l)) ?? lines.pop() ?? "clone failed"
        console.warn(`[loopat] per-user context clone failed (${url}): ${e?.stderr ?? e?.message ?? e}`)
        errors.push(`${label}: couldn't clone ${url} — ${reason}`)
        return false
      }
    }
    await execFileP("git", ["-C", dir, "config", "core.sshCommand",
      `ssh -i ${sandboxKey} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null`]).catch(() => {})
    await execFileP("git", ["-C", dir, "fetch", "--quiet", "origin"], { env: sshEnv, timeout: 30_000 }).catch(() => {})
    return true
  }
  // knowledge is the entry pointer (personal-declared url); clone it first, then
  // read ITS .loopat/config.json for the notes remote + repo roster — notes and
  // repos now live inside the per-user knowledge repo, not in personal config.
  const hasKnowledge = await ensurePerUserRepo(personalKnowledgeDir(user), cfg.knowledge?.git, "knowledge")
  const kcfg = hasKnowledge ? await loadKnowledgeConfig(user) : { notes: undefined, repos: [] as RepoSpec[] }
  await ensurePerUserRepo(personalNotesDir(user), kcfg.notes?.git, "notes")
  await writeReposManifest(personalReposDir(user), kcfg.repos ?? [])
  return errors
}

/**
 * Repos are clone-on-demand — they can be large, so we don't pre-clone the
 * whole set. Instead write a manifest (REPOS.md) listing the full roster, and
 * clone a repo only when it's actually needed. Per docs/context-flow.md the AI
 * can also clone any listed repo by hand into context/repos/<name>.
 */
async function writeReposManifest(reposDir: string, specs: RepoSpec[]) {
  await mkdir(reposDir, { recursive: true })
  const body = [
    "# repos — clone on demand",
    "",
    "Full roster below. Only already-cloned repos exist as subdirectories;",
    "clone any other on demand: `git clone <git> /loopat/context/repos/<name>`.",
    "",
    ...specs.filter((r) => r?.name && r?.git).map((r) => `- **${r.name}** — \`${r.git}\``),
    "",
  ].join("\n")
  await writeFile(join(reposDir, "REPOS.md"), body)
}

/**
 * Clone a single registered repo if it isn't present yet. Returns whether the
 * repo dir exists afterwards. Used by loop creation and any on-demand path.
 */
async function ensureRepoCloned(user: string, name: string, sshCommand?: string): Promise<boolean> {
  const dir = personalRepoDir(user, name)
  if (existsSyncBase(dir)) return true
  // The roster lives in the user's OWN knowledge repo (per-user, no fallback).
  const kcfg = await loadKnowledgeConfig(user)
  const spec = kcfg.repos?.find((r) => r.name === name)
  if (!spec?.git) return false
  try {
    await mkdir(personalReposDir(user), { recursive: true })
    const env = sshCommand ? { ...process.env, GIT_SSH_COMMAND: sshCommand } : process.env
    await execFileP("git", ["clone", "--", spec.git, dir], { env })
    console.log(`[loopat] cloned on demand ${spec.git} → ${dir}`)
    return true
  } catch (e: any) {
    console.warn(`[loopat] repo clone failed (${spec.git}): ${e?.stderr ?? e?.message ?? e}`)
    return false
  }
}

export async function ensureWorkspaceDirs() {
  await mkdir(workspaceDir(), { recursive: true })
  await mkdir(loopsDir(), { recursive: true })
  await mkdir(workspaceReposDir(), { recursive: true })

  // WORKSPACE-DEFAULT clone (bootstrap display + seed source only — loops use the
  // per-user knowledge/notes, see ensureUserContext). knowledge is the entry
  // pointer; clone it, then read its .loopat/config.json for notes + repo roster.
  const cfg = await loadConfig()
  await ensureContextRepo(workspaceKnowledgeDir(), "knowledge", cfg.knowledge?.git || undefined)
  const kcfg = await loadKnowledgeConfig()
  await ensureContextRepo(workspaceNotesDir(), "notes", kcfg.notes?.git || undefined)
  await writeReposManifest(workspaceReposDir(), kcfg.repos ?? [])

  // workspace memory dir + stub
  const tm = workspaceMemoryDir()
  await mkdir(tm, { recursive: true })
  const tmIdx = `${tm}/MEMORY.md`
  if (!existsSyncBase(tmIdx)) await writeFile(tmIdx, TEAM_MEMORY_INDEX_STUB)

  // knowledge / notes are already git repos with `origin` (ensureContextRepo).

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

  // personal gets a loopat-hosted bare origin too (local backend), so its
  // promote is `push origin` like every other context repo. A later import of
  // the user's own remote repo (importPersonalFromRepo) replaces this origin.
  await ensureContextRepo(dir, `personal-${userId}`, undefined)

  const { publicKey } = await ensurePersonalKeypair(userId)
  return { publicKey }
}

/**
 * Provider-agnostic personal onboarding (docs/identity.md integration contract).
 * Uses a host-side credential (token, never enters a sandbox) via the selected
 * GitHostProvider to create the personal repo + register the deploy key, then
 * reuses importPersonalFromRepo to clone + handle git-crypt (empty repo →
 * auto-init and return the generated key; existing → needsCryptKey).
 *
 * The token only *sets things up*; runtime git uses the deploy key / vault.
 * `provider` selects the git platform (default "github"); add platforms by
 * implementing GitHostProvider (see git-host.ts / providers.ts).
 */
export async function setupPersonalViaProvider(opts: {
  userId: string
  provider?: string
  token: string
  baseUrl?: string
  repoName: string
  cryptKey?: string
}): Promise<
  | { ok: true; repo: string; repoUrl: string; created: boolean; autoInitialized?: boolean; cryptKey?: string }
  | { ok: false; error: string; needsCryptKey?: boolean }
> {
  await loadExtensionProviders() // ensure external (internal-platform) providers are registered
  const provider = getProvider(opts.provider ?? "github")
  if (!provider) return { ok: false, error: `unknown git host provider: ${opts.provider}` }
  const cred = { token: opts.token, baseUrl: opts.baseUrl }

  let login: string
  let email: string | undefined
  try {
    const auth = await provider.authenticate(cred)
    login = auth.login
    email = auth.email
  } catch (e: any) {
    return { ok: false, error: `${provider.id} auth failed: ${e?.message ?? e}` }
  }

  let repo: { url: string; created: boolean }
  try {
    repo = await provider.ensureRepo(cred, opts.repoName, { private: true })
  } catch (e: any) {
    return { ok: false, error: `ensure repo failed: ${e?.message ?? e}` }
  }

  // Set up git auth per the provider's mode.
  let cloneUrl = repo.url
  if (provider.gitAuthMode === "ssh-deploy-key") {
    // GitHub-style: register a loopat-generated deploy key; git clones via ssh.
    const { publicKey } = await ensurePersonalKeypair(opts.userId)
    if (publicKey && provider.registerDeployKey) {
      try {
        await provider.registerDeployKey(cred, { owner: login, name: opts.repoName }, `loopat:${opts.userId}`, publicKey, false)
      } catch (e: any) {
        return { ok: false, error: `register deploy key failed: ${e?.message ?? e}` }
      }
    }
  } else {
    // https-token git: https://<login>:<token>@host/path — GitLab/Code use the
    // username + private_token as basic auth (GitHub PAT works the same way).
    // Normalize http→https. (MVP: the token lands in the worktree's .git/config —
    // fine for a private, user-owned personal repo; a credential-helper pass can
    // harden it later.)
    cloneUrl = repo.url.replace(
      /^https?:\/\//,
      `https://${encodeURIComponent(login)}:${encodeURIComponent(opts.token)}@`,
    )
  }

  // Clone + git-crypt via the existing import path (commit author from the
  // platform identity — some hosts reject non-corporate emails).
  // Internal-setup hook (optional): the provider may seed default files into
  // the fresh repo (provider configs, ssh keys, …). Only fires on auto-init.
  const seed = provider.seedDefaults
    ? (repoDir: string) =>
        provider.seedDefaults!({
          repoDir,
          vaultDir: join(repoDir, ".loopat", "vaults", "default"),
          userId: opts.userId,
          login,
        })
    : undefined
  const imp = await importPersonalFromRepo(opts.userId, cloneUrl, opts.cryptKey, { name: login, email }, seed)
  if (!imp.ok) return { ok: false, error: imp.error, needsCryptKey: imp.needsCryptKey }
  return {
    ok: true,
    repo: `${login}/${opts.repoName}`,
    repoUrl: repo.url,
    created: repo.created,
    autoInitialized: imp.autoInitialized,
    cryptKey: imp.cryptKey,
  }
}

/** Back-compat thin wrapper — GitHub is just the default provider. */
export async function setupPersonalViaGithub(opts: {
  userId: string
  token: string
  repoName: string
  baseUrl?: string
  cryptKey?: string
}) {
  return setupPersonalViaProvider({ ...opts, provider: "github" })
}

/** List the user's repos via a provider (onboarding picker), "personal"-named
 *  first. Empty when the provider can't list or the call fails. */
export async function listPersonalReposViaProvider(opts: {
  provider?: string
  token: string
  baseUrl?: string
}): Promise<{ name: string; path: string }[]> {
  await loadExtensionProviders()
  const provider = getProvider(opts.provider ?? "github")
  if (!provider?.listRepos) return []
  let repos: { name: string; path: string }[]
  try {
    repos = await provider.listRepos({ token: opts.token, baseUrl: opts.baseUrl })
  } catch {
    return []
  }
  return repos.sort((a, b) => (b.name.includes("personal") ? 1 : 0) - (a.name.includes("personal") ? 1 : 0))
}

/** Validate a token by authenticating it against the provider. The onboarding
 *  picker calls this to fail fast on a bad token instead of silently showing
 *  an empty repo list. */
export async function authenticateViaProvider(opts: {
  provider?: string
  token: string
  baseUrl?: string
}): Promise<{ ok: true; login: string } | { ok: false; error: string }> {
  await loadExtensionProviders()
  const provider = getProvider(opts.provider ?? "github")
  if (!provider) return { ok: false, error: `unknown git host provider: ${opts.provider}` }
  try {
    const auth = await provider.authenticate({ token: opts.token, baseUrl: opts.baseUrl })
    return { ok: true, login: auth.login }
  } catch (e: any) {
    return { ok: false, error: `${provider.id} auth failed: ${e?.message ?? e}` }
  }
}

/** The provider's optional token-help hint (URL/text), for the onboarding UI. */
export async function providerTokenHelp(providerId?: string): Promise<string | null> {
  await loadExtensionProviders()
  return getProvider(providerId ?? "github")?.tokenHelp ?? null
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
  author?: { name?: string; email?: string },
  seed?: (repoDir: string) => Promise<void>,
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

  // https-token urls carry their own auth (https://user:token@…) and need no
  // ssh deploy key; ssh urls require the loopat-managed deploy key.
  const isHttps = /^https?:\/\//.test(repoUrl)
  const priv = hostDeployKeyPath(userId)
  if (!isHttps && !existsSyncBase(priv)) {
    return { ok: false, error: "deploy keypair missing — re-register" }
  }

  // Clone into a tmp dir. ssh uses the deploy key (StrictHostKeyChecking=
  // accept-new, no pre-populated known_hosts on first run); https auths via url.
  const tmp = await mkdtemp(join(tmpdir(), `loopat-import-${userId}-`))
  // Bootstrap: first clone of the personal repo uses the host deploy-key (no
  // vault key exists yet). Every later op uses the user's vault key.
  const cloneEnv = isHttps ? { ...process.env } : { ...process.env, GIT_SSH_COMMAND: personalSshCommand(userId) }
  try {
    await execFileP("git", ["clone", "--", repoUrl, tmp], { env: cloneEnv })
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

  const init = await autoInitGitCrypt(tmp, userId, author, seed)
  if (!init.ok) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    return { ok: false, error: init.error }
  }

  const swap = await swapPersonalDir(userId, tmp)
  if (!swap.ok) return swap
  return { ok: true, autoInitialized: true, cryptKey: init.cryptKey }
}

/**
 * TEAM key: the ssh command a git op uses to reach SHARED context — knowledge /
 * notes / repos — as the user, with their OWN key from the selected vault
 * (`vaults/<vault>/mounts/home/.ssh/id`). If the key isn't there the op simply
 * fails: we deliberately do NOT fall back to the host deploy-key, so a loop
 * never borrows access it wasn't granted. Authorization tracks the personal
 * repo (which declares the team it connects to), not the host
 * (see behavior/02-personal-permissions.md).
 */
function sshCommandForUser(userId: string, vault: string = "default"): string {
  const vaultKey = join(personalVaultDir(userId, vault), "mounts", "home", ".ssh", "id")
  return `ssh -i ${vaultKey} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null`
}

/**
 * PERSONAL key: reaching the user's OWN personal repo (clone / pull / push) uses
 * the host-managed per-user deploy-key — permanently, not just at bootstrap.
 * personal access is a separate concern from the vault key (which reaches the
 * team): the deploy-key + git-crypt key are the two external credentials that
 * unlock a personal repo, both held in host-secrets/<user>; the vault key lives
 * INSIDE the (now-unlocked) personal repo and only reaches the team. This avoids
 * the recursion of "use a key stored in the repo to reach the repo itself".
 */
function personalSshCommand(userId: string): string {
  return `ssh -i ${hostDeployKeyPath(userId)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null`
}

async function swapPersonalDir(
  userId: string,
  tmp: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const dir = personalDir(userId)
  try {
    await mkdir(join(dir, ".."), { recursive: true })
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
  author?: { name?: string; email?: string },
  seed?: (repoDir: string) => Promise<void>,
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
    await execFileP("git", ["-C", repoDir, "config", "user.email", author?.email ?? "loopat@local"])
    await execFileP("git", ["-C", repoDir, "config", "user.name", author?.name ?? "loopat"])
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

  // Internal-setup hook: let the provider seed default files (provider configs,
  // ssh keys, …) into the working tree now. git-crypt is initialized, so
  // anything written under .loopat/vaults/** is encrypted, and the scaffold
  // commit below picks it up via `git add .loopat`. Non-fatal.
  if (seed) {
    try {
      await seed(repoDir)
    } catch (e: any) {
      console.warn(`[loopat] seedDefaults hook failed: ${e?.message ?? e}`)
    }
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
      env: { ...process.env, GIT_SSH_COMMAND: personalSshCommand(userId) },
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
        env: { ...process.env, GIT_SSH_COMMAND: personalSshCommand(userId) },
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
      env: { ...process.env, GIT_SSH_COMMAND: personalSshCommand(userId) },
    })
  } catch (e: any) {
    const stderr = (e?.stderr ?? "").toString().trim()
    return { ok: false, error: `push failed: ${stderr || e?.message || e}` }
  }
  return { ok: true }
}

/**
 * ff-only sync core — the loop-outside (no-AI) rule from docs/context-flow.md:
 * rebase a checkout's local commits onto origin/<branch>. A clean rebase means
 * local is now origin + local commits, linear, ready to ff-push. A real
 * same-spot conflict is *held back*: we abort (local commits preserved —
 * nothing is lost) and report the files so the caller can surface the choice
 * (discard local / take remote / resolve in a loop). Never a blind merge.
 */
async function rebaseOntoOrigin(
  dir: string,
  branch: string,
  sshCommand?: string,
): Promise<{ ok: true } | { ok: false; error: string } | { ok: false; conflict: true; files: string[] }> {
  const fetchEnv: Record<string, string> = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  if (sshCommand) fetchEnv.GIT_SSH_COMMAND = sshCommand
  try {
    await execFileP("git", ["-C", dir, "fetch", "origin"], { env: fetchEnv, timeout: 30_000 })
  } catch (e: any) {
    return { ok: false, error: `fetch failed: ${e?.stderr ?? e?.message ?? e}` }
  }
  // No upstream branch yet (empty remote) → nothing to rebase onto.
  try {
    await execFileP("git", ["-C", dir, "rev-parse", "--verify", "--quiet", `origin/${branch}`])
  } catch {
    return { ok: true }
  }
  try { await execFileP("git", ["-C", dir, "rebase", "--abort"]) } catch {}
  try {
    await execFileP("git", ["-C", dir, "rebase", `origin/${branch}`], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
    return { ok: true }
  } catch (e: any) {
    const stderr = (e?.stderr ?? "").toString()
    let files: string[] = []
    try {
      const { stdout } = await execFileP("git", ["-C", dir, "diff", "--name-only", "--diff-filter=U"])
      files = stdout.split("\n").filter((l) => l.trim())
    } catch {}
    try { await execFileP("git", ["-C", dir, "rebase", "--abort"]) } catch {}
    if (files.length > 0 || /CONFLICT/.test(stderr)) return { ok: false, conflict: true, files }
    return { ok: false, error: `rebase failed: ${stderr || e?.message || e}` }
  }
}

/**
 * Stage + commit local changes. Preserves the repo's existing author (set at
 * import from the platform identity — some hosts reject non-corporate emails);
 * only falls back to a local identity if none is configured.
 */
async function commitLocalChanges(
  dir: string,
  message: string,
): Promise<{ ok: true; committed: boolean } | { ok: false; error: string }> {
  try {
    try { await execFileP("git", ["-C", dir, "config", "user.email"]) }
    catch { await execFileP("git", ["-C", dir, "config", "user.email", "loopat@local"]) }
    try { await execFileP("git", ["-C", dir, "config", "user.name"]) }
    catch { await execFileP("git", ["-C", dir, "config", "user.name", "loopat"]) }
    await execFileP("git", ["-C", dir, "add", "-A"])
  } catch (e: any) {
    return { ok: false, error: `git add failed: ${e?.stderr ?? e?.message ?? e}` }
  }
  let staged = false
  try { await execFileP("git", ["-C", dir, "diff", "--cached", "--quiet"]) } catch { staged = true }
  if (!staged) return { ok: true, committed: false }
  try {
    await execFileP("git", ["-C", dir, "commit", "-m", message])
  } catch (e: any) {
    return { ok: false, error: `commit failed: ${e?.stderr ?? e?.message ?? e}` }
  }
  return { ok: true, committed: true }
}

/**
 * Pull = align this checkout to origin (the SoT). Commits local edits, rebases
 * them onto origin/<branch> (held back on real conflict). With `force`, discards
 * local entirely and takes the remote — the "take remote" escape hatch.
 */
export type PersonalPullResult =
  | { ok: true; message: string }
  | { ok: false; error: string; conflict?: boolean; files?: string[]; needsStash?: boolean }

export async function pullPersonalFromRemote(
  userId: string,
  opts?: { force?: boolean },
): Promise<PersonalPullResult> {
  const force = opts?.force ?? false
  const dir = personalDir(userId)
  if (!existsSyncBase(join(dir, ".git"))) {
    return { ok: false, error: "personal/ is not a git repo" }
  }
  let hasOrigin = false
  try { await execFileP("git", ["-C", dir, "remote", "get-url", "origin"]); hasOrigin = true } catch {}
  if (!hasOrigin) return { ok: false, error: "no remote configured" }

  let branch = "main"
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "symbolic-ref", "--short", "HEAD"])
    if (stdout.trim()) branch = stdout.trim()
  } catch {}

  if (force) {
    // "Take the remote": discard ALL local state, re-align to origin. Doubles as
    // the escape hatch for a wedged repo (stuck rebase/merge, dirty index).
    const silent = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }
    try {
      try { await execFileP("git", ["-C", dir, "rebase", "--abort"], { env: silent }) } catch {}
      try { await execFileP("git", ["-C", dir, "merge", "--abort"], { env: silent }) } catch {}
      await execFileP("git", ["-C", dir, "fetch", "origin"], {
        env: { ...silent, GIT_SSH_COMMAND: personalSshCommand(userId) }, timeout: 30_000,
      })
      await execFileP("git", ["-C", dir, "reset", "--hard", `origin/${branch}`], { env: silent })
      await execFileP("git", ["-C", dir, "clean", "-fd"], { env: silent })
      return { ok: true, message: `reset to origin/${branch}` }
    } catch (e: any) {
      return { ok: false, error: `force pull failed: ${e?.stderr ?? e?.message ?? e}` }
    }
  }

  // Normal pull: commit local edits so the tree is clean, then rebase onto origin.
  const c = await commitLocalChanges(dir, "loopat: local personal edits")
  if (!c.ok) return { ok: false, error: c.error }
  const reb = await rebaseOntoOrigin(dir, branch, personalSshCommand(userId))
  if (!reb.ok) {
    if ("conflict" in reb) return { ok: false, error: "conflict with remote", conflict: true, files: reb.files }
    return { ok: false, error: reb.error }
  }
  return { ok: true, message: `aligned to origin/${branch}` }
}

/**
 * Push = land this checkout on origin (the SoT). Commits local edits, rebases
 * onto origin/<branch> (held back on a real conflict — never a blind merge),
 * then ff-pushes. Outside a loop there's no AI, so a conflict is surfaced
 * (`conflict` + `files`), not swallowed.
 */
export type PersonalPushResult =
  | { ok: true; message: string }
  | { ok: false; error: string; conflict?: boolean; files?: string[]; needsPull?: boolean }

export async function pushPersonalToRemote(
  userId: string,
): Promise<PersonalPushResult> {
  const dir = personalDir(userId)
  if (!existsSyncBase(join(dir, ".git"))) {
    return { ok: false, error: "personal/ is not a git repo" }
  }
  let hasOrigin = false
  try { await execFileP("git", ["-C", dir, "remote", "get-url", "origin"]); hasOrigin = true } catch {}
  if (!hasOrigin) return { ok: false, error: "no remote configured" }

  let branch = "main"
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "symbolic-ref", "--short", "HEAD"])
    if (stdout.trim()) branch = stdout.trim()
  } catch {}

  const c = await commitLocalChanges(dir, "loopat: sync personal vault")
  if (!c.ok) return { ok: false, error: c.error }
  const reb = await rebaseOntoOrigin(dir, branch, personalSshCommand(userId))
  if (!reb.ok) {
    if ("conflict" in reb) return { ok: false, error: "conflict with remote", conflict: true, files: reb.files }
    return { ok: false, error: reb.error }
  }
  try {
    await execFileP("git", ["-C", dir, "push", "origin", `HEAD:${branch}`], {
      env: { ...process.env, GIT_SSH_COMMAND: personalSshCommand(userId) },
    })
  } catch (e: any) {
    const stderr = (e?.stderr ?? "").toString().trim()
    // We just rebased onto origin, so a rejection means the remote moved again
    // between rebase and push (rare) — caller can simply retry.
    return { ok: false, error: `push failed: ${stderr || e?.message || e}`, needsPull: true }
  }
  return { ok: true, message: c.committed ? "committed and pushed" : "pushed" }
}

/**
 * UI-loop notes worktree: a per-user checkout of notes, opened from origin/main,
 * for editing team notes outside any AI loop (the no-AI "UI loop"). Disposable —
 * rebuilt from origin if missing.
 */
export async function ensureUiNotesWorktree(user: string): Promise<void> {
  // Ensure the user's per-user notes main repo is cloned from their declared
  // remote first (notes is per-user now), then open the UI worktree from it.
  await ensureUserContext(user).catch(() => {})
  await ensurePerUserContextWorktree(personalNotesDir(user), uiNotesDir(user), `ui/${user}`)
}

/**
 * Save = land this user's notes edits on origin/main (the SoT). Commits, rebases
 * onto origin/main (held back on a real conflict), ff-pushes HEAD:main. notes
 * uses the host's default git auth (team origin), not a personal deploy key.
 */
export async function syncUiNotes(user: string): Promise<PersonalPushResult> {
  const dir = uiNotesDir(user)
  await ensureUiNotesWorktree(user)
  const branch = await remoteDefaultBranch(dir)
  const c = await commitLocalChanges(dir, "loopat: edit notes")
  if (!c.ok) return { ok: false, error: c.error }
  const userSsh = sshCommandForUser(user)
  const reb = await rebaseOntoOrigin(dir, branch, userSsh)
  if (!reb.ok) {
    if ("conflict" in reb) return { ok: false, error: "conflict with remote", conflict: true, files: reb.files }
    return { ok: false, error: reb.error }
  }
  try {
    await execFileP("git", ["-C", dir, "push", "origin", `HEAD:${branch}`], {
      env: { ...process.env, GIT_SSH_COMMAND: userSsh },
    })
  } catch (e: any) {
    const stderr = (e?.stderr ?? "").toString().trim()
    return { ok: false, error: `push failed: ${stderr || e?.message || e}`, needsPull: true }
  }
  return { ok: true, message: c.committed ? "saved & pushed" : "pushed" }
}

/**
 * Refresh = the pull half of the notes UI loop: fetch + ff-only merge
 * origin/main into the user's worktree. Skips silently if the worktree has
 * diverged (committed-but-unpushed local edits) — those reconcile on save.
 */
export async function ffUpdateUiNotes(
  user: string,
): Promise<{ ok: true } | { ok: false; diverged?: boolean; error: string }> {
  const dir = uiNotesDir(user)
  await ensureUiNotesWorktree(user)
  const branch = await remoteDefaultBranch(dir)
  try {
    await execFileP("git", ["-C", dir, "fetch", "origin"], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: sshCommandForUser(user) }, timeout: 30_000,
    })
  } catch (e: any) {
    return { ok: false, error: `fetch failed: ${e?.stderr ?? e?.message ?? e}` }
  }
  // No upstream yet → nothing to pull.
  try {
    await execFileP("git", ["-C", dir, "rev-parse", "--verify", "--quiet", `origin/${branch}`])
  } catch {
    return { ok: true }
  }
  try {
    await execFileP("git", ["-C", dir, "merge", "--ff-only", `origin/${branch}`], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
    return { ok: true }
  } catch {
    // Not ff (local unpushed commits). Leave it; the next save rebases.
    return { ok: false, diverged: true, error: "diverged — save your edits first" }
  }
}

/**
 * How many commits the user's notes worktree is behind origin/main (after a
 * fetch). Drives the "remote updated" hint. 0 = up to date.
 */
export async function notesBehind(user: string): Promise<number> {
  const dir = uiNotesDir(user)
  await ensureUiNotesWorktree(user)
  const branch = await remoteDefaultBranch(dir)
  try {
    await execFileP("git", ["-C", dir, "fetch", "origin"], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: sshCommandForUser(user) }, timeout: 30_000,
    })
  } catch {
    return 0
  }
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "rev-list", "--count", `HEAD..origin/${branch}`])
    return parseInt(stdout.trim(), 10) || 0
  } catch {
    return 0
  }
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
export async function inspectRepoSync(dir: string, user?: string): Promise<RepoSyncStatus> {
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
      const env = user ? { ...process.env, GIT_SSH_COMMAND: sshCommandForUser(user) } : process.env
      await execFileP("git", ["-C", dir, "fetch", "--quiet", "origin"], { env, timeout: 15_000 })
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
export async function pullRepoFromRemote(dir: string, user?: string): Promise<RepoSyncResult> {
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
    const env = user ? { ...process.env, GIT_SSH_COMMAND: sshCommandForUser(user) } : process.env
    await execFileP("git", ["-C", dir, "fetch", "origin"], { env, timeout: 30_000 })
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
export async function pushRepoToRemote(dir: string, user?: string): Promise<RepoSyncResult> {
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
    const env = user ? { ...process.env, GIT_SSH_COMMAND: sshCommandForUser(user) } : process.env
    await execFileP("git", ["-C", dir, "push", "origin", `HEAD:${branch}`], { env })
  } catch (e: any) {
    const stderr = (e?.stderr ?? "").toString().trim()
    return { ok: false, error: `push failed: ${stderr || e?.message || e}` }
  }

  return { ok: true, message: `pushed to origin/${branch}` }
}

/**
 * Promote a just-written knowledge `.loopat/config.json` (repos/notes roster)
 * back to the knowledge repo's origin: stage + commit + push with the vault key.
 * The config was written by saveKnowledgeConfig(user, …) into the per-user
 * knowledge clone. "nothing to commit" is success (idempotent save).
 */
export async function promoteKnowledgeConfig(user: string): Promise<RepoSyncResult> {
  const dir = personalKnowledgeDir(user)
  if (!existsSyncBase(join(dir, ".git"))) return { ok: false, error: "knowledge repo not cloned" }
  await execFileP("git", ["-C", dir, "add", ".loopat/config.json"]).catch(() => {})
  try {
    await execFileP("git", ["-C", dir, "-c", "user.email=loopat@local", "-c", "user.name=loopat",
      "commit", "-m", "chore(loopat): update .loopat/config.json (repos/notes roster)"])
  } catch (e: any) {
    if (/nothing to commit/i.test((e?.stdout ?? e?.stderr ?? "").toString())) return { ok: true, message: "no change" }
    return { ok: false, error: `commit failed: ${e?.stderr ?? e?.message ?? e}` }
  }
  return await pushRepoToRemote(dir, user)
}

/**
 * The user's per-vault SSH public keys — the keys a loop authenticates to TEAM
 * repos with (knowledge / notes / repos), one per vault. This is what the user
 * must register on the team git host. Distinct from the deploy key (host-
 * secrets, personal-repo only). Reads vaults/<v>/mounts/home/.ssh/id.pub, or
 * derives it from the private key.
 */
export async function listVaultPublicKeys(user: string): Promise<{ vault: string; publicKey: string }[]> {
  const { listVaults } = await import("./vaults")
  const out: { vault: string; publicKey: string }[] = []
  for (const vault of listVaults(user)) {
    const sshDir = join(personalVaultDir(user, vault), "mounts", "home", ".ssh")
    const pubPath = join(sshDir, "id.pub")
    const keyPath = join(sshDir, "id")
    let pub = ""
    if (existsSyncBase(pubPath)) {
      pub = (await readFile(pubPath, "utf8")).trim()
    } else if (existsSyncBase(keyPath)) {
      try { const { stdout } = await execFileP("ssh-keygen", ["-y", "-f", keyPath]); pub = stdout.trim() } catch {}
    }
    if (pub) out.push({ vault, publicKey: pub })
  }
  return out
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
  try { await execFileP("git", ["-C", repo, "worktree", "prune"]) } catch {}
  // ① pull (docs/context-flow.md): open the worktree from origin's default
  // branch so the loop starts from latest consensus, not a stale local HEAD.
  const start = await remoteStartPoint(repo)
  // -B (not -b): reset the branch if it lingers from a removed worktree, so a
  // rebuild always re-opens cleanly from the start point.
  const tail = ["-B", branchName, path]
  if (start) tail.push(start)

  // git-crypt + worktree: the git-crypt key lives in the MAIN repo's
  // `.git/git-crypt`, but a worktree's gitdir is separate and has no key — so a
  // normal `worktree add` checkout runs the smudge filter, can't find the key,
  // and fails ("Unable to open key file"). For a git-crypt repo, add WITHOUT
  // checkout, then `git-crypt unlock` the worktree with the host key: that
  // installs the key into the worktree's gitdir AND decrypts the working tree.
  if (existsSyncBase(join(repo, ".git", "git-crypt"))) {
    // git-crypt + worktree: a worktree's gitdir has no git-crypt key, so the
    // checkout's smudge filter crashes ("Unable to open key file") — and
    // git-crypt doesn't support worktrees anyway (it wants a `.git` dir). We
    // don't NEED the worktree's vaults decrypted: the sandbox's vault mounts
    // read the MAIN repo's already-unlocked `personal/.loopat/vaults`. So
    // neutralize the smudge filter (`smudge=cat`, `required=false`) — the
    // git-crypt'd files (vaults/**) land encrypted-as-is, everything else
    // (memory, etc.) checks out plainly.
    await execFileP("git", ["-C", repo, "-c", "filter.git-crypt.smudge=cat", "-c", "filter.git-crypt.required=false", "worktree", "add", ...tail])
  } else {
    await execFileP("git", ["-C", repo, "worktree", "add", ...tail])
  }
}

/**
 * ① pull, per docs/context-flow.md: a loop starts from consensus. Best-effort
 * fetch origin, then return `origin/main` as the worktree start-point so the
 * loop opens from the latest shared state. Returns null to fall back to local
 * HEAD (solo / offline / no remote / no origin/main yet).
 */
/** The remote's default branch (origin/HEAD) — e.g. main or master. Falls back
 *  to "main". loopat must NOT assume "main": team repos are often on "master". */
async function remoteDefaultBranch(dir: string): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
    const b = stdout.trim().replace(/^origin\//, "")
    if (b) return b
  } catch {}
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "ls-remote", "--symref", "origin", "HEAD"])
    const m = stdout.match(/ref:\s+refs\/heads\/(\S+)\s+HEAD/)
    if (m?.[1]) return m[1]
  } catch {}
  return "main"
}

async function remoteStartPoint(repo: string, sshCommand?: string): Promise<string | null> {
  try {
    await execFileP("git", ["-C", repo, "remote", "get-url", "origin"])
  } catch {
    return null
  }
  try {
    const env = sshCommand ? { ...process.env, GIT_SSH_COMMAND: sshCommand } : process.env
    await execFileP("git", ["-C", repo, "fetch", "--quiet", "origin"], { env, timeout: 15_000 })
  } catch {}
  const branch = await remoteDefaultBranch(repo)
  try {
    await execFileP("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `origin/${branch}^{commit}`])
    return `origin/${branch}`
  } catch {
    return null
  }
}

/**
 * Worktree from a PER-USER context main repo. When the main repo is absent (the
 * user declared no remote for this context — see ensureUserContext's strict
 * rule), the loop gets an EMPTY dir, never a fallback to a workspace default.
 */
async function ensurePerUserContextWorktree(repo: string, path: string, branch: string) {
  if (!existsSyncBase(join(repo, ".git"))) {
    try { await rm(path, { recursive: true, force: true }) } catch {}
    await mkdir(path, { recursive: true })
    return
  }
  await ensureContextWorktree(repo, path, branch)
}

export async function ensureContextMounts(id: string, createdBy: string) {
  await mkdir(loopContextDir(id), { recursive: true })
  // knowledge / notes are per-user (cloned by ensureUserContext from the user's
  // personal-declared remotes). Each worktree opens from origin/main — a fresh
  // pull of consensus; the local main repo is just the fetch cache + worktree
  // host (docs/context-flow.md). Empty when the user declared no remote.
  await ensurePerUserContextWorktree(personalKnowledgeDir(createdBy), loopContextKnowledge(id), `loop/${id}`)
  await ensurePerUserContextWorktree(personalNotesDir(createdBy), loopContextNotes(id), `loop/${id}`)
  // personal is also a per-loop worktree — same shape, wired to the user's
  // private remote. ensureContextWorktree falls back to a symlink when
  // personal/ isn't a git repo yet.
  await ensureContextWorktree(personalDir(createdBy), loopContextPersonal(id), `loop/${id}`)
  await mkdir(personalReposDir(createdBy), { recursive: true })
  await ensureSymlink(loopContextRepos(id), personalReposDir(createdBy))
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

  // Pull the per-user knowledge/notes FIRST: clones the user's knowledge repo
  // (from personal.knowledge) and reads its .loopat/config.json for the notes
  // remote + repo roster — which the workdir clone-on-demand below depends on.
  // Surface any clone failures (bad key / no access) as a loop banner so the
  // user isn't left with a silently-empty context.
  const ctxWarnings = await ensureUserContext(opts.createdBy, opts.vault ?? "default").catch(
    (e: any) => { console.warn(`[loopat] ensureUserContext(${opts.createdBy}): ${e?.message ?? e}`); return [`context init failed: ${e?.message ?? e}`] },
  )
  if (ctxWarnings.length) meta.contextWarnings = ctxWarnings

  // workdir = git worktree add (if repo selected) OR plain mkdir
  if (opts.repo) {
    // clone + fetch as the user (their vault key), not the host's ssh.
    const userSsh = sshCommandForUser(opts.createdBy, opts.vault ?? "default")
    // clone-on-demand: pull the repo down only now that a loop actually needs it
    if (!(await ensureRepoCloned(opts.createdBy, opts.repo, userSsh))) {
      throw new Error(`repo "${opts.repo}" not found / clone failed`)
    }
    const repoPath = personalRepoDir(opts.createdBy, opts.repo)
    const branch = `loop/${(await shortBranchSlug(meta.title))}-${id.slice(0, 6)}`
    try {
      // ① pull (docs/context-flow.md): base the workdir branch on origin/main
      // (best-effort fetch) so it starts from latest consensus; fall back to
      // local HEAD when there's no remote / no origin/main.
      const start = await remoteStartPoint(repoPath, userSsh)
      const wtArgs = ["-C", repoPath, "worktree", "add", "-b", branch, loopWorkdir(id)]
      if (start) wtArgs.push(start)
      await execFileP("git", wtArgs)
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

  // (ensureUserContext already ran above, before the workdir clone.)
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
