/**
 * Resolve which plugins a loop should run with — read straight from the
 * loop's chosen sandbox dir, then add platform-shipped builtins. Output
 * goes into the Agent SDK's `plugins: [{type:'local', path:...}]` option
 * (one --plugin-dir per entry on the spawned CC).
 *
 * Architecture:
 *
 *   Per sandbox under knowledge/.loopat/sandboxes/<name>/:
 *     .claude/                            ← admin uses `claude plugin install`
 *       settings.json                      to populate; CC writes all this
 *       .claude.json                       natively. .gitignore drops the
 *       plugins/
 *         installed_plugins.json           cache/ + marketplaces/ (per-server
 *         known_marketplaces.json           state, not committable).
 *         cache/<m>/<p>/<v>/               ← actual plugin files
 *         marketplaces/<m>/                ← marketplace clones
 *     mise.toml / mise.lock / sandbox.json / CLAUDE.md  ← team-shared
 *
 *   Loopat reads `installed_plugins.json` and forwards each entry's
 *   `installPath` to the SDK. No marketplace logic, no install logic —
 *   CC does all that, loopat just enumerates the result.
 *
 *   The builtin `loopat` plugin (server/templates/plugins/loopat/) is
 *   platform-shipped and always included regardless of sandbox.
 */
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { TEMPLATES_DIR, workspaceLoopatSandboxDir } from "./paths"
import { resolveSandboxChain } from "./sandboxes"

export type ResolvedLoopPlugin = {
  /** Display name (`plugin@marketplace` or just `plugin` for builtins). */
  name: string
  /** Host path to plugin root (contains .claude-plugin/plugin.json). Must be
   *  sandbox-visible via existing bwrap binds (LOOPAT_INSTALL_DIR for
   *  builtins; knowledge bind for sandbox-installed plugins). */
  path: string
}

/** Platform-shipped plugins. Always loaded into every loop. */
function resolveBuiltinPlugins(): ResolvedLoopPlugin[] {
  return [
    { name: "loopat@builtin", path: join(TEMPLATES_DIR, "plugins", "loopat") },
  ]
}

type InstalledPluginsFile = {
  version: number
  plugins: Record<string, Array<{ installPath: string; version: string }>>
}

type KnownMarketplacesFile = Record<string, { installLocation?: string }>

type MarketplaceCatalog = {
  plugins?: Array<{ name: string; source: string | { source: string; [k: string]: any } }>
}

async function readJsonOpt<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch {
    return null
  }
}

/**
 * Resolve the marketplace source path for a plugin, if the marketplace is
 * locally cloned AND the plugin uses a relative "./..." source. This is the
 * path that handles symlinks correctly — `claude plugin install` doesn't
 * follow symlinks when copying to its cache, so for plugins with symlinked
 * subdirs (common in dashscope-skills) the cache is incomplete.
 *
 * Returns null when the marketplace isn't local, the catalog can't be read,
 * the plugin's source isn't a relative path, or the resolved dir is missing.
 * Callers fall back to the installed cache path in those cases.
 */
async function resolveMarketplaceSourcePath(
  km: KnownMarketplacesFile | null,
  marketName: string,
  pluginName: string,
): Promise<string | null> {
  const market = km?.[marketName]
  if (!market?.installLocation) return null
  const catalog = await readJsonOpt<MarketplaceCatalog>(
    join(market.installLocation, ".claude-plugin", "marketplace.json"),
  )
  const entry = catalog?.plugins?.find((p) => p.name === pluginName)
  if (!entry) return null
  const src = entry.source
  if (typeof src !== "string" || !src.startsWith("./")) return null
  const path = join(market.installLocation, src)
  return existsSync(path) ? path : null
}

/** Read ONE sandbox's installed_plugins.json + map each to a usable path. */
async function readSandboxOwnPlugins(sandboxName: string): Promise<ResolvedLoopPlugin[]> {
  const claudeDir = join(workspaceLoopatSandboxDir(sandboxName), ".claude")
  const ip = await readJsonOpt<InstalledPluginsFile>(join(claudeDir, "plugins", "installed_plugins.json"))
  if (!ip) return []
  const km = await readJsonOpt<KnownMarketplacesFile>(join(claudeDir, "plugins", "known_marketplaces.json"))
  const out: ResolvedLoopPlugin[] = []
  for (const [key, entries] of Object.entries(ip.plugins ?? {})) {
    const entry = entries?.[0]
    if (!entry) continue
    const atIdx = key.lastIndexOf("@")
    const pluginName = atIdx < 0 ? key : key.slice(0, atIdx)
    const marketName = atIdx < 0 ? "" : key.slice(atIdx + 1)
    // Prefer marketplace source path (handles symlinks). Cache is a fallback
    // for non-local marketplaces (git-subdir / url / npm sources).
    const sourcePath = marketName ? await resolveMarketplaceSourcePath(km, marketName, pluginName) : null
    if (sourcePath) {
      out.push({ name: key, path: sourcePath })
      continue
    }
    if (entry.installPath && existsSync(entry.installPath)) {
      out.push({ name: key, path: entry.installPath })
      continue
    }
    console.warn(`[plugins] sandbox "${sandboxName}" plugin "${key}": no resolvable path (cache + marketplace both missing)`)
  }
  return out
}

/**
 * Walk the sandbox's extends chain (oldest ancestor first) and merge plugins
 * by `name@market` key — child entries shadow parent entries naturally.
 */
async function resolveSandboxPlugins(sandboxName: string): Promise<ResolvedLoopPlugin[]> {
  const chain = await resolveSandboxChain(sandboxName)
  const merged = new Map<string, ResolvedLoopPlugin>()
  for (const name of chain) {
    for (const p of await readSandboxOwnPlugins(name)) {
      merged.set(p.name, p) // later in chain (closer to leaf) wins
    }
  }
  return [...merged.values()]
}

/**
 * Main entry — called at loop spawn. Always returns builtins; adds the
 * sandbox's plugins on top if a sandbox is selected.
 */
export async function resolveLoopPlugins(sandboxName: string | undefined): Promise<ResolvedLoopPlugin[]> {
  return [
    ...resolveBuiltinPlugins(),
    ...(sandboxName ? await resolveSandboxPlugins(sandboxName) : []),
  ]
}
