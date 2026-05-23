/**
 * Plugin resolver — CC-native model (post-2026-05 refactor).
 *
 * Inputs: loop's merged settings.json (produced by compose.ts) at
 * `loops/<id>/.claude/settings.json`, containing `enabledPlugins` +
 * `extraKnownMarketplaces` (both CC-native fields).
 *
 * Flow at loop spawn:
 *   1. Read merged settings → get marketplace declarations + plugin specs
 *   2. Auto-register team's `.loopat/marketplace/` if it exists (convention)
 *   3. Register each `extraKnownMarketplaces` entry with CC (idempotent)
 *   4. For each enabledPlugins spec, `claude plugin install --scope=user`
 *      (cross-marketplace works — we drive each install explicitly)
 *   5. Resolve installed paths from CC's user-tier cache
 *   6. Return ResolvedLoopPlugin[] for SDK `plugins` option
 *
 * The SDK loads from absolute paths (bypasses CC's cache lookup), so
 * per-loop selection works regardless of what's globally enabled on the host.
 */
import { existsSync, statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { join, resolve as resolvePath } from "node:path"
import { promisify } from "node:util"
import { TEMPLATES_DIR, loopClaudeDir } from "./paths"

const execFileP = promisify(execFile)

export type ResolvedLoopPlugin = {
  /** `plugin@marketplace` (or `plugin@builtin`). */
  name: string
  /** Host path to plugin root (contains .claude-plugin/plugin.json). */
  path: string
}

/** Platform-shipped plugins. Always loaded. */
function resolveBuiltinPlugins(): ResolvedLoopPlugin[] {
  return [{ name: "loopat@builtin", path: join(TEMPLATES_DIR, "plugins", "loopat") }]
}

const USER_CLAUDE_DIR = join(homedir(), ".claude")
const USER_INSTALLED_PLUGINS = join(USER_CLAUDE_DIR, "plugins", "installed_plugins.json")
const USER_KNOWN_MARKETPLACES = join(USER_CLAUDE_DIR, "plugins", "known_marketplaces.json")

type InstalledPluginsFile = {
  version: number
  plugins: Record<string, Array<{ installPath: string; version: string; scope?: string }>>
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

async function runClaude(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const { stdout, stderr } = await execFileP("claude", args)
    return { ok: true, out: stdout, err: stderr }
  } catch (e: any) {
    return {
      ok: false,
      out: e?.stdout?.toString?.() ?? "",
      err: e?.stderr?.toString?.() ?? e?.message ?? String(e),
    }
  }
}

/**
 * Compare two marketplace sources (from settings.json and from CC's
 * known_marketplaces.json). Used to detect URL/path drift — if a team admin
 * changes the marketplace URL, members' host CC needs to re-register.
 */
export function sourcesMatch(declared: any, existing: any): boolean {
  if (declared === existing) return true
  if (!declared || !existing) return false
  if (typeof declared !== "object" || typeof existing !== "object") return false
  if (declared.source !== existing.source) return false
  switch (declared.source) {
    case "git":
    case "url":
      return declared.url === existing.url
    case "github":
      // Both shapes seen: `repo: "owner/name"` and `repository: "owner/name"`
      return (declared.repo ?? declared.repository) === (existing.repo ?? existing.repository)
    case "directory":
      return declared.path === existing.path
    default:
      // Unknown shape — fall back to JSON equality
      return JSON.stringify(declared) === JSON.stringify(existing)
  }
}

/**
 * Ensure a marketplace is registered with CC. Idempotent + URL-drift aware.
 *
 * Reads CC's known_marketplaces.json directly (no `claude plugin marketplace
 * list` subprocess — saves ~1s per spawn). Only shells out when add / remove
 * is actually needed.
 */
async function ensureMarketplace(
  name: string,
  addPath: string,
  declaredSource: any,
  km: KnownMarketplacesFile | null,
): Promise<void> {
  const existing = (km?.[name] as any)?.source
  if (existing) {
    if (sourcesMatch(declaredSource, existing)) {
      return // already registered with correct source — fast path, no subprocess
    }
    console.warn(
      `[plugins] marketplace "${name}" source drift; re-registering ` +
      `(was ${JSON.stringify(existing)}, want ${JSON.stringify(declaredSource)})`,
    )
    await runClaude(["plugin", "marketplace", "remove", name])
  }
  const add = await runClaude(["plugin", "marketplace", "add", addPath])
  if (!add.ok) {
    console.warn(`[plugins] failed to register marketplace "${name}": ${add.err}`)
  }
}

/**
 * Register each extraKnownMarketplaces entry from merged settings.
 * Skips entries CC already knows AND whose declared source matches.
 * Detects drift (e.g., team admin changed the URL) and re-registers.
 */
async function ensureExtraMarketplaces(
  extras: Record<string, { source?: any }> | undefined,
  loopId: string,
  km: KnownMarketplacesFile | null,
): Promise<void> {
  if (!extras) return
  for (const [name, entry] of Object.entries(extras)) {
    const src = entry?.source as any
    let addPath: string | undefined
    // Normalize the declared source into a canonical shape for drift comparison
    // AND pick the addPath to pass to `claude plugin marketplace add`.
    let normalized: any = src
    if (typeof src === "string") {
      addPath = src
      normalized = { source: "github", repo: src } // best-effort shorthand
    } else if (src?.source === "directory" && typeof src.path === "string") {
      addPath = resolvePath(loopClaudeDir(loopId), src.path)
      normalized = { source: "directory", path: addPath }
    } else if (src?.source === "github" && typeof src.repo === "string") {
      addPath = src.repo
      normalized = { source: "github", repo: src.repo }
    } else if ((src?.source === "git" || src?.source === "url") && typeof src.url === "string") {
      addPath = src.url
      normalized = { source: src.source, url: src.url }
    }
    if (!addPath) {
      console.warn(`[plugins] extraKnownMarketplaces["${name}"]: unsupported source shape, skip`)
      continue
    }
    await ensureMarketplace(name, addPath, normalized, km)
  }
}

/**
 * Install each spec via `claude plugin install --scope=user`. Reads
 * installed_plugins.json directly to short-circuit (no `claude plugin list`
 * subprocess — saves ~1s per spawn).
 */
async function ensurePluginsInstalled(
  specs: string[],
  ip: InstalledPluginsFile | null,
): Promise<void> {
  if (specs.length === 0) return
  const installedKeys = new Set(Object.keys(ip?.plugins ?? {}))
  for (const spec of specs) {
    if (installedKeys.has(spec)) continue
    const r = await runClaude(["plugin", "install", spec, "--scope=user"])
    if (!r.ok) {
      console.warn(`[plugins] install failed for "${spec}": ${r.err.trim().split("\n").slice(-2).join(" | ")}`)
    }
  }
}

/**
 * Resolve a `name@marketplace` spec to a host path. Prefers the marketplace's
 * source path (preserves symlinks); falls back to CC cache.
 */
async function resolveSpecPath(
  spec: string,
  ip: InstalledPluginsFile | null,
  km: KnownMarketplacesFile | null,
): Promise<string | null> {
  if (!ip) return null
  const entry = ip.plugins?.[spec]?.[0]
  if (!entry?.installPath) return null

  const atIdx = spec.lastIndexOf("@")
  if (atIdx >= 0) {
    const pluginName = spec.slice(0, atIdx)
    const marketName = spec.slice(atIdx + 1)
    const market = km?.[marketName]
    if (market?.installLocation) {
      const catalog = await readJsonOpt<MarketplaceCatalog>(
        join(market.installLocation, ".claude-plugin", "marketplace.json"),
      )
      const cat = catalog?.plugins?.find((p) => p.name === pluginName)
      const src = typeof cat?.source === "string" ? cat.source : null
      if (src?.startsWith("./")) {
        const p = join(market.installLocation, src)
        if (existsSync(p)) return p
      }
    }
  }
  return existsSync(entry.installPath) ? entry.installPath : null
}

/**
 * In-memory cache keyed by loopId, invalidated when the loop's settings.json
 * mtime changes. Compose rewrites settings.json on every spawn, so re-spawns
 * naturally bust the cache. Multiple callers within one spawn cycle
 * (session.ts spawn + slash-command seed, /api/mcp-servers, etc.) share the
 * cached result — cuts attach time from ~6s to ~50ms when nothing changed.
 */
type ResolveCacheEntry = { mtime: number; plugins: ResolvedLoopPlugin[] }
const resolveCache = new Map<string, ResolveCacheEntry>()

/**
 * Main entry — called at loop spawn after compose has written the loop's
 * merged settings.json. Reads enabledPlugins + extraKnownMarketplaces from
 * that file, orchestrates marketplace registration + plugin install, then
 * returns absolute paths for the SDK's `plugins` option.
 *
 * Result cached by settings.json mtime; bypasses CC CLI subprocess calls
 * (reads ~/.claude/plugins/{installed,known_marketplaces}.json directly).
 */
export async function resolveLoopPlugins(loopId: string): Promise<ResolvedLoopPlugin[]> {
  const settingsPath = join(loopClaudeDir(loopId), "settings.json")
  const mtime = existsSync(settingsPath) ? statSync(settingsPath).mtimeMs : 0

  const cached = resolveCache.get(loopId)
  if (cached && cached.mtime === mtime) return cached.plugins

  const builtins = resolveBuiltinPlugins()
  const settings = await readJsonOpt<{
    enabledPlugins?: Record<string, boolean>
    extraKnownMarketplaces?: Record<string, { source?: any }>
  }>(settingsPath)

  const enabled = Object.entries(settings?.enabledPlugins ?? {})
    .filter(([_, v]) => v)
    .map(([k]) => k)

  if (enabled.length === 0) {
    resolveCache.set(loopId, { mtime, plugins: builtins })
    return builtins
  }

  // Read CC state files once; pass to helpers (avoids redundant disk reads).
  const km = await readJsonOpt<KnownMarketplacesFile>(USER_KNOWN_MARKETPLACES)
  const ip = await readJsonOpt<InstalledPluginsFile>(USER_INSTALLED_PLUGINS)

  await ensureExtraMarketplaces(settings?.extraKnownMarketplaces, loopId, km)
  await ensurePluginsInstalled(enabled, ip)

  // Re-read installed_plugins.json after any installs (km too, in case
  // ensureExtraMarketplaces touched it).
  const ip2 = await readJsonOpt<InstalledPluginsFile>(USER_INSTALLED_PLUGINS)
  const km2 = await readJsonOpt<KnownMarketplacesFile>(USER_KNOWN_MARKETPLACES)

  const out: ResolvedLoopPlugin[] = [...builtins]
  for (const spec of enabled) {
    const path = await resolveSpecPath(spec, ip2, km2)
    if (path) {
      out.push({ name: spec, path })
    } else {
      console.warn(`[plugins] could not resolve path for "${spec}" (install may have failed)`)
    }
  }

  resolveCache.set(loopId, { mtime, plugins: out })
  return out
}
