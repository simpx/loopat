/**
 * Server-side marketplace cache. Shared across loops + users.
 *
 * Layout under ${LOOPAT_HOME}/plugin-cache/:
 *   <market>/_marketplace/           ← marketplace git clone (has .claude-plugin/marketplace.json)
 *   <market>/<plugin>/<sha>/         ← per-plugin checkout (for non-local sources, future)
 *
 * Step 3 scope: only "./..."-relative plugin sources are materialized — the
 * plugin lives INSIDE the marketplace clone, so we just compute its host
 * path inside _marketplace/ and return it. The plugin "sha" = the marketplace
 * HEAD git sha (so loop install records a meaningful gitCommitSha).
 *
 * Network: git clone/pull uses host default SSH (same as inspectRepoSync /
 * pullRepoFromRemote in loops.ts) — no per-user vault keys at fetch time.
 *
 * Concurrency: a process-wide async lock per marketplace prevents two
 * concurrent loop creates from racing on the same clone dir.
 */
import { existsSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { join } from "node:path"
import { serverMarketplaceCloneDir, serverPluginCacheRoot } from "./paths"
import type { MarketplaceSource } from "./config"

const execFileP = promisify(execFile)

/** Per-marketplace mutex so concurrent loop creates don't race the clone. */
const locks = new Map<string, Promise<void>>()
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((r) => (release = r))
  locks.set(key, prev.then(() => next))
  try {
    await prev
    return await fn()
  } finally {
    release()
    if (locks.get(key) === next) locks.delete(key)
  }
}

/**
 * Ensure `${LOOPAT_HOME}/plugin-cache/<market>/_marketplace/` exists. For
 * local sources: no-op, returns source.path. For git/github: clones once if
 * missing, then returns the cached path. **Does NOT refresh** — that's
 * refreshMarketplaceCache's job, called from boot prewarm + future admin
 * actions. Keeping loop create off the network path is what makes "create
 * loop" cheap (cache-hit symlinks only).
 *
 * Returns the host path to the marketplace root (contains
 * .claude-plugin/marketplace.json).
 */
export async function ensureMarketplaceCached(
  marketName: string,
  source: MarketplaceSource,
): Promise<string> {
  if (source.source === "local") {
    if (!existsSync(source.path)) {
      throw new Error(`local marketplace ${marketName} path missing: ${source.path}`)
    }
    return source.path
  }
  return withLock(marketName, async () => {
    const cloneDir = serverMarketplaceCloneDir(marketName)
    if (existsSync(join(cloneDir, ".git"))) return cloneDir
    const url = source.source === "github"
      ? `https://github.com/${source.repo}.git`
      : source.url
    await mkdir(serverPluginCacheRoot(), { recursive: true })
    await mkdir(cloneDir, { recursive: true })
    try {
      await execFileP("git", ["clone", "--depth=1", url, cloneDir])
    } catch (e: any) {
      throw new Error(`marketplace ${marketName} clone failed (${url}): ${e?.message ?? e}`)
    }
    return cloneDir
  })
}

/**
 * Refresh a cached marketplace (clone if missing, ff-only pull if present).
 * Called from boot prewarm — drift is admin's problem (we use the cached
 * version on stale-cache failure, not fail).
 */
export async function refreshMarketplaceCache(
  marketName: string,
  source: MarketplaceSource,
): Promise<string> {
  if (source.source === "local") return ensureMarketplaceCached(marketName, source)
  return withLock(marketName, async () => {
    const cloneDir = serverMarketplaceCloneDir(marketName)
    const url = source.source === "github"
      ? `https://github.com/${source.repo}.git`
      : source.url
    await mkdir(serverPluginCacheRoot(), { recursive: true })
    if (!existsSync(join(cloneDir, ".git"))) {
      await mkdir(cloneDir, { recursive: true })
      try {
        await execFileP("git", ["clone", "--depth=1", url, cloneDir])
      } catch (e: any) {
        throw new Error(`marketplace ${marketName} clone failed (${url}): ${e?.message ?? e}`)
      }
      return cloneDir
    }
    try {
      await execFileP("git", ["-C", cloneDir, "fetch", "--depth=1", "origin"])
      await execFileP("git", ["-C", cloneDir, "reset", "--hard", "FETCH_HEAD"])
    } catch (e: any) {
      console.warn(`[marketplace] ${marketName} refresh failed (${e?.message ?? e}); using stale cache`)
    }
    return cloneDir
  })
}

/** Read the marketplace.json catalog from a (cached) marketplace root. */
export type CatalogPlugin = {
  name: string
  description?: string
  version?: string
  source: string | { source: string; [k: string]: any }
}
export async function readMarketplaceCatalog(
  marketRoot: string,
): Promise<{ name: string; plugins: CatalogPlugin[] } | null> {
  const path = join(marketRoot, ".claude-plugin", "marketplace.json")
  if (!existsSync(path)) return null
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (e: any) {
    console.warn(`[marketplace] catalog parse failed at ${path}: ${e?.message ?? e}`)
    return null
  }
}

/** Marketplace HEAD git sha (best-effort) — empty string if not a git repo. */
export async function marketplaceHeadSha(marketRoot: string): Promise<string> {
  if (!existsSync(join(marketRoot, ".git"))) return ""
  try {
    const { stdout } = await execFileP("git", ["-C", marketRoot, "rev-parse", "HEAD"])
    return stdout.trim()
  } catch {
    return ""
  }
}

/**
 * Resolve a plugin's source from the marketplace catalog into a concrete
 * host path. Step 3: only "./..." relative paths supported (plugin lives in
 * marketplace clone). Other sources (sha-pinned url/git-subdir) → null +
 * warning; caller skips.
 */
export type ResolvedPlugin = {
  /** Host path to the plugin dir (contains .claude-plugin/plugin.json). */
  hostPath: string
  /** Version string for cache dir naming + installed_plugins.json. */
  version: string
  /** Git sha (for installed_plugins.json:gitCommitSha) — empty if unknown. */
  sha: string
}
export async function resolvePluginFromCatalog(
  marketRoot: string,
  entry: CatalogPlugin,
  marketHeadSha: string,
): Promise<ResolvedPlugin | null> {
  const src = entry.source
  if (typeof src !== "string" || !src.startsWith("./")) {
    console.warn(`[marketplace] plugin ${entry.name}: source ${JSON.stringify(src)} not yet supported`)
    return null
  }
  const hostPath = join(marketRoot, src)
  if (!existsSync(hostPath)) {
    console.warn(`[marketplace] plugin ${entry.name}: source path missing: ${hostPath}`)
    return null
  }
  // Version from catalog → plugin.json → marketplace HEAD sha (short) → fallback.
  let version = entry.version
  if (!version) {
    const pjPath = join(hostPath, ".claude-plugin", "plugin.json")
    if (existsSync(pjPath)) {
      try {
        const pj = JSON.parse(await readFile(pjPath, "utf8"))
        version = pj.version
      } catch {}
    }
  }
  if (!version) version = marketHeadSha ? marketHeadSha.slice(0, 12) : "0.0.0"
  return { hostPath, version, sha: marketHeadSha }
}
