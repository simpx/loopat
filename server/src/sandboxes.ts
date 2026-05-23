/**
 * Sandbox catalog: each sandbox is a SUBDIRECTORY under
 * `knowledge/.loopat/sandboxes/` containing a `mise.toml` (the runtime
 * declaration mise reads) plus an optional `mise.lock` (version pinning).
 *
 * Why dir-per-sandbox rather than `<name>.toml` files: mise's lockfile
 * generation is tightly coupled to cwd-discovered configs named `mise.toml`.
 * Trying to use `MISE_OVERRIDE_CONFIG_FILENAMES` with `<name>.toml` quietly
 * skips lockfile writes. Giving each sandbox its own dir lets mise work
 * natively and leaves room for future siblings (mcp.json, AGENTS.md).
 *
 * UI / API surface still treats each sandbox as a single name (e.g.
 * "default"); the dir + `mise.toml` filename are implementation detail.
 *
 * Naming note: "sandbox" is the user-facing primitive (the runtime
 * environment a loop activates). Implementation-side "snapshot" refers to
 * the per-loop frozen copy, and "bwrap process" refers to the actual running
 * sandboxing container. See docs/sandbox.md.
 *
 * Personal sandbox catalog (`personal/<user>/.loopat/sandboxes/`) is
 * intentionally deferred — see the plan's "future extension anchors".
 */
import { execFile } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import {
  workspaceKnowledgeDir,
  workspaceLoopatSandboxDir,
  workspaceLoopatSandboxPath,
  workspaceLoopatSandboxLockPath,
  workspaceLoopatSandboxMetaPath,
  workspaceLoopatSandboxesDir,
} from "./paths"

const execFileP = promisify(execFile)

export type SandboxEntry = {
  name: string
}

/**
 * Loopat-side sandbox metadata, lives in `sandbox.json` alongside mise.toml.
 * Kept separate so mise.toml stays purely about runtime/tools.
 *
 * - `shell`: term spawn shell — bare name (PATH lookup against mise installs)
 *   or absolute path. Falls back to /bin/bash when undefined.
 * - `extends`: optional sibling sandbox name to inherit from. Child's
 *   plugins / mcpServers / extraKnownMarketplaces union with parent (child
 *   wins on same key). CLAUDE.md concatenates (parent → child). mise.toml
 *   falls back to parent if child has none.
 *
 * Future: autostart services, hook scripts, etc.
 */
export type SandboxMeta = {
  shell?: string
  extends?: string
}

/** Hard cap on extends chain length — defensive, not enforced as "must be ≤". */
const MAX_EXTENDS_DEPTH = 5

/**
 * Walk the extends chain for `name`, returning sandbox names from oldest
 * ancestor (chain[0]) to the child itself (chain[chain.length-1]). Order
 * matters: callers iterate in this order so child writes shadow parent
 * writes naturally (later wins). Cycles + over-depth chains are warned and
 * truncated, never thrown.
 */
export async function resolveSandboxChain(name: string): Promise<string[]> {
  const stack: string[] = []
  const seen = new Set<string>()
  let cur: string | undefined = name
  while (cur && stack.length < MAX_EXTENDS_DEPTH) {
    if (!isValidSandboxName(cur)) {
      console.warn(`[sandbox] invalid extends target "${cur}" in chain for "${name}"; stopping`)
      break
    }
    if (seen.has(cur)) {
      console.warn(`[sandbox] extends cycle at "${cur}" in chain for "${name}"; stopping`)
      break
    }
    seen.add(cur)
    stack.push(cur)
    const meta = await readSandboxMeta(cur)
    cur = meta?.extends
  }
  if (cur && stack.length >= MAX_EXTENDS_DEPTH) {
    console.warn(`[sandbox] extends chain for "${name}" exceeded depth ${MAX_EXTENDS_DEPTH}; truncated at "${stack[stack.length - 1]}"`)
  }
  return stack.reverse() // child last → oldest-first
}

/** Read sandbox.json for the named sandbox. Returns null if missing or malformed. */
export async function readSandboxMeta(name: string): Promise<SandboxMeta | null> {
  if (!isValidSandboxName(name)) return null
  const p = workspaceLoopatSandboxMetaPath(name)
  if (!existsSync(p)) return null
  try {
    const raw = await readFile(p, "utf8")
    return JSON.parse(raw) as SandboxMeta
  } catch {
    return null
  }
}

/**
 * Read sandbox.json from a per-loop snapshot path (resolved by caller). Tiny
 * helper since term.ts also needs this without going through the catalog.
 */
export async function readSandboxMetaFromPath(path: string): Promise<SandboxMeta | null> {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(await readFile(path, "utf8")) as SandboxMeta
  } catch {
    return null
  }
}

/** Strict sandbox-name format: filename-safe, no path traversal. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
export function isValidSandboxName(name: string): boolean {
  return NAME_RE.test(name)
}

/** Plugin info surfaced to the UI — derived from a sandbox's installed_plugins.json. */
export type SandboxInstalledPlugin = {
  /** Full `name@marketplace` key (as stored in installed_plugins.json). */
  key: string
  /** Plugin name only (before "@"). */
  name: string
  /** Marketplace name (after "@"). */
  marketplace: string
  version: string
  gitCommitSha: string
  installPath: string
  /** True when installPath dir is present on disk. */
  cachePresent: boolean
}

export type SandboxMarketplaceCatalogEntry = {
  name: string
  description?: string
  /** True when this plugin is in installed_plugins.json for the sandbox. */
  installed: boolean
}

export type SandboxMarketplace = {
  name: string
  source: any /* {source:"git"|"github"|"local"|...; url?:string; repo?:string; path?:string} */
  installLocation?: string
  lastUpdated?: string
  /** Plugin entries from the marketplace's marketplace.json (if local copy
   *  is present after `claude plugin marketplace add`). Empty when CC
   *  hasn't cloned the marketplace yet. */
  catalogPlugins: SandboxMarketplaceCatalogEntry[]
}

export type SandboxPluginInventory = {
  plugins: SandboxInstalledPlugin[]
  marketplaces: SandboxMarketplace[]
}

/**
 * Run a `claude plugin ...` subcommand against a sandbox's .claude/. Output
 * (combined stdout + stderr) is returned for the UI to surface; non-zero
 * exit becomes ok:false.
 *
 * Used by the admin UI to install / uninstall / update plugins and add
 * marketplaces without SSH.
 */
export async function runSandboxClaudeCommand(
  name: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; output: string; error?: string }> {
  if (!isValidSandboxName(name)) return { ok: false, output: "", error: "invalid sandbox name" }
  const { resolveClaudeBinary } = await import("./claude-binary")
  const claudeBin = resolveClaudeBinary()
  const claudeConfigDir = `${workspaceLoopatSandboxDir(name)}/.claude`
  await mkdir(claudeConfigDir, { recursive: true })
  try {
    const { stdout, stderr } = await execFileP(claudeBin, args, {
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeConfigDir },
      timeout: opts.timeoutMs ?? 120_000,
    })
    return { ok: true, output: (stdout || "") + (stderr || "") }
  } catch (e: any) {
    return {
      ok: false,
      output: ((e?.stdout as string) || "") + ((e?.stderr as string) || ""),
      error: e?.message ?? String(e),
    }
  }
}

/** Read the plugin inventory CC wrote into a sandbox's .claude/ dir,
 *  enriched with each marketplace's catalog so the UI can offer "install"
 *  buttons for plugins the admin hasn't installed yet. */
export async function readSandboxPluginInventory(name: string): Promise<SandboxPluginInventory> {
  if (!isValidSandboxName(name)) return { plugins: [], marketplaces: [] }
  const claudeDir = `${workspaceLoopatSandboxDir(name)}/.claude`
  const readJson = async (p: string): Promise<any | null> => {
    if (!existsSync(p)) return null
    try { return JSON.parse(await readFile(p, "utf8")) } catch { return null }
  }
  const ip = await readJson(`${claudeDir}/plugins/installed_plugins.json`)
  const km = await readJson(`${claudeDir}/plugins/known_marketplaces.json`) ?? {}
  const installedKeys = new Set(Object.keys((ip?.plugins ?? {}) as Record<string, any>))
  const plugins: SandboxInstalledPlugin[] = []
  for (const [key, entries] of Object.entries((ip?.plugins ?? {}) as Record<string, any[]>)) {
    const e = entries?.[0]
    if (!e) continue
    const at = key.lastIndexOf("@")
    plugins.push({
      key,
      name: at < 0 ? key : key.slice(0, at),
      marketplace: at < 0 ? "" : key.slice(at + 1),
      version: e.version ?? "",
      gitCommitSha: e.gitCommitSha ?? "",
      installPath: e.installPath ?? "",
      cachePresent: e.installPath ? existsSync(e.installPath) : false,
    })
  }
  const marketplaces: SandboxMarketplace[] = []
  for (const [mName, v] of Object.entries(km as Record<string, any>)) {
    const catalog = v.installLocation
      ? await readJson(`${v.installLocation}/.claude-plugin/marketplace.json`)
      : null
    const catalogPlugins: SandboxMarketplaceCatalogEntry[] = []
    for (const p of (catalog?.plugins ?? []) as any[]) {
      if (!p?.name) continue
      catalogPlugins.push({
        name: p.name,
        description: typeof p.description === "string" ? p.description : undefined,
        installed: installedKeys.has(`${p.name}@${mName}`),
      })
    }
    marketplaces.push({
      name: mName,
      source: v.source,
      installLocation: v.installLocation,
      lastUpdated: v.lastUpdated,
      catalogPlugins,
    })
  }
  return { plugins, marketplaces }
}

/** List all sandboxes (subdirs containing a mise.toml). */
export async function listSandboxes(): Promise<SandboxEntry[]> {
  const root = workspaceLoopatSandboxesDir()
  if (!existsSync(root)) return []
  const entries: SandboxEntry[] = []
  for (const name of await readdir(root)) {
    if (!isValidSandboxName(name)) continue
    let st
    try {
      st = statSync(`${root}/${name}`)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    if (!existsSync(workspaceLoopatSandboxPath(name))) continue
    entries.push({ name })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries
}

/**
 * Pick a default sandbox for programmatic loop spawns (distill, kanban,
 * chat-thread). When exactly one sandbox exists, there's no real choice —
 * use it. With 0 or 2+, return undefined (caller falls back to host PATH).
 * Interactive flows do their own picking in the UI.
 */
export async function pickDefaultSandbox(): Promise<string | undefined> {
  const xs = await listSandboxes()
  return xs.length === 1 ? xs[0].name : undefined
}

/** Resolve sandbox name to its mise.toml path. Returns null if missing. */
export function resolveSandboxFile(name: string): string | null {
  const p = workspaceLoopatSandboxPath(name)
  return existsSync(p) ? p : null
}

/**
 * Files inside a sandbox dir that the editor UI can read/write. Whitelist
 * so a malicious `?file=../../../etc/passwd` can't escape — only these
 * basenames resolve to a path inside the sandbox dir.
 */
export type SandboxFile = "mise.toml" | "sandbox.json" | "CLAUDE.md"
const SANDBOX_FILES: readonly SandboxFile[] = ["mise.toml", "sandbox.json", "CLAUDE.md"]
export function isValidSandboxFile(file: string): file is SandboxFile {
  return (SANDBOX_FILES as readonly string[]).includes(file)
}

function sandboxFilePath(name: string, file: SandboxFile): string {
  return `${workspaceLoopatSandboxDir(name)}/${file}`
}

/** Read one file from a sandbox. Returns null if missing. */
export async function readSandboxFile(name: string, file: SandboxFile): Promise<string | null> {
  const p = sandboxFilePath(name, file)
  if (!existsSync(p)) return null
  return await readFile(p, "utf8")
}

/** Write one file into a sandbox, creating the sandbox dir if needed. */
export async function writeSandboxFile(name: string, file: SandboxFile, content: string): Promise<void> {
  const dir = workspaceLoopatSandboxDir(name)
  await mkdir(dir, { recursive: true })
  await writeFile(sandboxFilePath(name, file), content)
}

/**
 * Remove a sandbox from the catalog. Per-loop snapshots already copied are
 * untouched — they continue to work standalone (decoupling is the whole
 * point of the snapshot model). Caller has already validated the name.
 */
export async function deleteSandbox(name: string): Promise<void> {
  await rm(workspaceLoopatSandboxDir(name), { recursive: true, force: true })
}

/**
 * Synthetic git identity for auto-commits the loopat system makes on the
 * user's behalf. The actor is "loopat" (the platform), not the logged-in
 * user — UI edits are policy decisions about the workspace's shared sandbox
 * catalog, not personal commits. Push (when wired) uses the per-user deploy
 * key separately; this just controls author/committer fields.
 */
const COMMIT_AUTHOR_NAME = "loopat"
const COMMIT_AUTHOR_EMAIL = "loopat@localhost"

/**
 * Auto-commit sandbox changes in the knowledge repo. Stages only the
 * sandbox's dir, commits as the loopat identity. Returns the new short sha
 * or null when skipped (no git, nothing to commit, or commit failed).
 *
 * Called after every write / delete from the UI so getSandboxVersion()
 * always has a fresh sha to compare against — that's what powers the
 * "→ <sha>" refresh link on the loop page.
 */
export async function commitSandboxChange(
  name: string,
  action: { kind: "update"; file: SandboxFile } | { kind: "delete" } | { kind: "create" },
): Promise<{ ok: boolean; sha?: string; error?: string }> {
  const repoRoot = workspaceKnowledgeDir()
  if (!existsSync(`${repoRoot}/.git`)) return { ok: false, error: "knowledge dir is not a git repo" }
  const sandboxPath = `.loopat/sandboxes/${name}`
  try {
    // -A picks up both modifications and deletions inside the sandbox dir.
    // Scoping to the sandbox path keeps unrelated dirty files in knowledge
    // out of this commit.
    await execFileP("git", ["-C", repoRoot, "add", "-A", "--", sandboxPath], { timeout: 5000 })
    // git diff --cached exit 0 = no staged changes → nothing to commit.
    const diffRes = await execFileP(
      "git",
      ["-C", repoRoot, "diff", "--cached", "--quiet", "--", sandboxPath],
      { timeout: 5000 },
    ).then(() => ({ code: 0 })).catch((e: any) => ({ code: e?.code ?? 1 }))
    if (diffRes.code === 0) return { ok: true } // no-op write (content unchanged)
    const msg =
      action.kind === "update" ? `sandboxes/${name}: update ${action.file}`
      : action.kind === "create" ? `sandboxes/${name}: create`
      : `sandboxes/${name}: delete`
    await execFileP(
      "git",
      [
        "-C", repoRoot,
        "-c", `user.name=${COMMIT_AUTHOR_NAME}`,
        "-c", `user.email=${COMMIT_AUTHOR_EMAIL}`,
        "commit", "-m", msg, "--", sandboxPath,
      ],
      { timeout: 10000 },
    )
    const r = await execFileP("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"], { timeout: 5000 })
    return { ok: true, sha: r.stdout.trim() }
  } catch (e: any) {
    const stderr = (e?.stderr ?? "").toString().trim()
    return { ok: false, error: stderr || e?.message || "git commit failed" }
  }
}

/**
 * Short commit id of the most recent commit in the knowledge repo that
 * touched this sandbox's directory. Used as the sandbox's "version" —
 * convenient because it gives a clickable audit trail straight to the git
 * diff.
 *
 * Returns null when: sandbox dir missing, knowledge dir isn't a git repo,
 * or the sandbox was never committed (uncommitted edits via UI).
 */
export async function getSandboxVersion(name: string): Promise<string | null> {
  if (!isValidSandboxName(name)) return null
  if (!existsSync(workspaceLoopatSandboxDir(name))) return null
  const repoRoot = workspaceKnowledgeDir()
  if (!existsSync(`${repoRoot}/.git`)) return null
  try {
    const r = await execFileP(
      "git",
      ["-C", repoRoot, "log", "-1", "--format=%h", "--", `.loopat/sandboxes/${name}`],
      { timeout: 5000 },
    )
    const sha = r.stdout.trim()
    return sha || null
  } catch {
    return null
  }
}

/**
 * Resolve loose version specs ("latest", "22", etc.) to exact pinned versions
 * by running `mise install` in the sandbox's dir with lockfile enabled.
 * Writes to `<sandbox-dir>/mise.lock`. Idempotent — fast when nothing to
 * install.
 *
 * mise's lockfile write requires (a) cwd-discovered config named `mise.toml`
 * and (b) the lockfile already existing. We satisfy both: cwd = sandbox dir,
 * and we `touch mise.lock` first. `MISE_TRUSTED_CONFIG_PATHS` skips the
 * interactive trust prompt for our managed dir.
 */
export async function lockSandbox(name: string): Promise<{ ok: boolean; error?: string }> {
  const tomlPath = resolveSandboxFile(name)
  if (!tomlPath) return { ok: false, error: `sandbox "${name}" not found` }
  const sandboxDir = workspaceLoopatSandboxDir(name)
  const lockPath = workspaceLoopatSandboxLockPath(name)
  // touch — mise won't write to a lockfile that doesn't exist yet.
  if (!existsSync(lockPath)) {
    await writeFile(lockPath, "")
  }
  const env = {
    ...process.env,
    MISE_TRUSTED_CONFIG_PATHS: sandboxDir,
    MISE_LOCKFILE: "true",
  }
  try {
    await execFileP("mise", ["install"], { env, cwd: sandboxDir })
    return { ok: true }
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      return { ok: false, error: "mise not found on host" }
    }
    const msg = (e?.stderr ?? e?.message ?? String(e)).toString().trim()
    return { ok: false, error: msg.split("\n").slice(-5).join("\n") }
  }
}
