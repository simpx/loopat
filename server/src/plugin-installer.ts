/**
 * Resolve which plugins a loop should run with, returning local paths suitable
 * for the Agent SDK's `plugins: [{type: 'local', path: ...}]` option.
 *
 * Background — why this isn't an "installer":
 *
 *   The Agent SDK only loads plugins through its `plugins` option, which
 *   becomes one `--plugin-dir <path>` per entry on the spawned CC process
 *   (see SDK sdk.mjs). It does NOT read settings.json's `enabledPlugins`,
 *   does NOT read `installed_plugins.json`, does NOT participate in
 *   `/plugin install` lifecycle (that command itself is "isn't available in
 *   this environment" in headless mode). So writing CC-native install state
 *   to disk in the loop's .claude/ is pointless — SDK ignores it.
 *
 *   Instead loopat plays the role of the installer at the OUTER layer: it
 *   resolves "which plugins" (from builtin + workspace + personal claude.json
 *   declarations), materializes them in a server-side cache (one copy shared
 *   across loops), and at spawn hands the SDK the list of local paths. The
 *   loop's .claude/plugins/ stays untouched and CC-owned (though CC won't
 *   actually use it in SDK mode).
 *
 * Server-side cache layout — `${LOOPAT_HOME}/plugin-cache/`:
 *   <market>/_marketplace/                          ← marketplace clone (managed by marketplace-cache.ts)
 *   <market>/_marketplace/plugins/<plugin>/          ← plugin source for "./..." relative entries
 *
 * Bound into the sandbox same-to-same via bwrap, so paths in this file
 * (host paths) are valid inside the sandbox too — SDK passes them through
 * to the sandboxed CC and `--plugin-dir <host-path>` resolves.
 */
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  builtinMarketplaceDir,
  builtinMarketplaceManifestPath,
} from "./paths"
import { loadPersonalClaudeJson, loadWorkspaceClaudeJson, type MarketplaceSource } from "./config"
import {
  ensureMarketplaceCached,
  marketplaceHeadSha,
  readMarketplaceCatalog,
  refreshMarketplaceCache,
  resolvePluginFromCatalog,
} from "./marketplace-cache"

/** Entry in a marketplace.json plugins[] array (subset we read). */
type CatalogPluginEntry = {
  name: string
  description?: string
  version?: string
  /** Either a relative path string ("./plugins/foo") or a source object. */
  source: string | { source: string; [k: string]: any }
}

/** Resolved plugin — a path the SDK can hand to CC via --plugin-dir. */
export type ResolvedLoopPlugin = {
  /** Display name (manifest's `name`, used for logging / dedup). */
  name: string
  /** Marketplace this plugin came from (used for dedup + diagnostics). */
  marketplace: string
  /** Host path to the plugin's root dir (contains .claude-plugin/plugin.json).
   *  Must be sandbox-visible via the corresponding ro-bind (LOOPAT_INSTALL_DIR
   *  for builtin, serverPluginCacheRoot for workspace/personal). */
  path: string
}

async function readJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch {
    return null
  }
}

/** Resolve all builtin plugins (loopat-builtin marketplace, local source). */
async function resolveBuiltinPlugins(): Promise<ResolvedLoopPlugin[]> {
  const catalog = await readJson<{ name: string; plugins: CatalogPluginEntry[] }>(builtinMarketplaceManifestPath())
  if (!catalog) {
    console.warn(`[plugins] builtin marketplace catalog missing: ${builtinMarketplaceManifestPath()}`)
    return []
  }
  const out: ResolvedLoopPlugin[] = []
  for (const entry of catalog.plugins) {
    const src = typeof entry.source === "string" ? entry.source : null
    if (!src || !src.startsWith("./")) {
      console.warn(`[plugins] builtin ${entry.name}: unsupported source ${JSON.stringify(entry.source)}`)
      continue
    }
    const path = join(builtinMarketplaceDir(), src)
    if (!existsSync(path)) {
      console.warn(`[plugins] builtin ${entry.name}: path missing ${path}`)
      continue
    }
    out.push({ name: entry.name, marketplace: catalog.name, path })
  }
  return out
}

/**
 * Walk workspace + personal claude.json's extraKnownMarketplaces + enabledPlugins
 * and resolve each enabled plugin to a path. Personal entries override workspace
 * by key (same precedence as MCP merge). Missing or unresolvable entries are
 * warned + skipped, not thrown — one bad plugin doesn't kill the spawn.
 */
async function resolveCatalogPlugins(user: string): Promise<ResolvedLoopPlugin[]> {
  const workspace = await loadWorkspaceClaudeJson()
  const personal = await loadPersonalClaudeJson(user)
  const marketSources: Record<string, MarketplaceSource> = {}
  for (const [name, entry] of Object.entries(workspace.extraKnownMarketplaces ?? {})) {
    marketSources[name] = entry.source
  }
  for (const [name, entry] of Object.entries(personal.extraKnownMarketplaces ?? {})) {
    marketSources[name] = entry.source
  }
  const enabled: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(workspace.enabledPlugins ?? {})) enabled[k] = v
  for (const [k, v] of Object.entries(personal.enabledPlugins ?? {})) enabled[k] = v

  const out: ResolvedLoopPlugin[] = []
  for (const [key, on] of Object.entries(enabled)) {
    if (!on) continue
    const at = key.lastIndexOf("@")
    if (at < 0) {
      console.warn(`[plugins] enabledPlugins key "${key}" missing @marketplace suffix; skipped`)
      continue
    }
    const pluginName = key.slice(0, at)
    const marketName = key.slice(at + 1)
    const source = marketSources[marketName]
    if (!source) {
      console.warn(`[plugins] ${key}: marketplace "${marketName}" not declared in extraKnownMarketplaces`)
      continue
    }
    try {
      const marketRoot = await ensureMarketplaceCached(marketName, source)
      const catalog = await readMarketplaceCatalog(marketRoot)
      if (!catalog) {
        console.warn(`[plugins] ${marketName}: catalog unreadable at ${marketRoot}`)
        continue
      }
      const entry = catalog.plugins.find((p) => p.name === pluginName)
      if (!entry) {
        console.warn(`[plugins] ${marketName}: plugin "${pluginName}" not in catalog`)
        continue
      }
      const headSha = await marketplaceHeadSha(marketRoot)
      const resolved = await resolvePluginFromCatalog(marketRoot, entry, headSha)
      if (!resolved) continue
      out.push({ name: pluginName, marketplace: marketName, path: resolved.hostPath })
    } catch (e: any) {
      console.warn(`[plugins] resolve ${key} failed: ${e?.message ?? e}`)
    }
  }
  return out
}

/**
 * Boot-time prewarm: ensure every marketplace declared in workspace
 * claude.json is cloned + fresh, so loop creates after boot hit warm cache
 * and don't pay clone latency. Failures are warned, not thrown — bad URL
 * doesn't block server boot.
 *
 * Personal claude.json is NOT prewarmed at boot (per-user state, lazy at
 * spawn — most users won't have personal marketplaces anyway).
 */
export async function prewarmWorkspaceMarketplaces(): Promise<void> {
  const workspace = await loadWorkspaceClaudeJson()
  const markets = workspace.extraKnownMarketplaces ?? {}
  const names = Object.keys(markets)
  if (names.length === 0) return
  console.log(`[plugins] prewarming ${names.length} marketplace(s): ${names.join(", ")}`)
  for (const [name, entry] of Object.entries(markets)) {
    try {
      const root = await refreshMarketplaceCache(name, entry.source)
      const catalog = await readMarketplaceCatalog(root)
      const have = catalog?.plugins?.length ?? 0
      console.log(`[plugins]   ${name}: ${have} plugin(s) available`)
    } catch (e: any) {
      console.warn(`[plugins]   ${name}: ${e?.message ?? e}`)
    }
  }
}

/**
 * Main entry — called by session.ts at spawn time. Returns the list of
 * plugins to hand to the SDK's `plugins` option.
 *
 * Resolution happens at spawn (not create) so admin changes to workspace
 * claude.json take effect on next spawn without explicit "loop resync".
 * Resolution is cheap when the server cache is warm (just readJson +
 * existsSync per plugin).
 */
export async function resolveLoopPlugins(user: string): Promise<ResolvedLoopPlugin[]> {
  return [
    ...(await resolveBuiltinPlugins()),
    ...(await resolveCatalogPlugins(user)),
  ]
}
