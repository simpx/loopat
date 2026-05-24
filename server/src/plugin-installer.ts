/**
 * Plugin orchestration on the host. Post-wholesale-bind (2026-05): the inner
 * SDK now resolves enabledPlugins natively because bwrap.ts ro-binds
 * ~/.claude/plugins/ wholesale into the sandbox. So loopat's job here is
 * purely host-side preparation:
 *
 *   1. Make sure every marketplace declared in the loop's merged
 *      `extraKnownMarketplaces` is registered with the host CC.
 *   2. Make sure every spec in `enabledPlugins` is installed in the host CC
 *      cache (otherwise SDK would find an enabled-but-uninstalled spec and
 *      fail to load it).
 *
 * That's it — no path resolution, no return value beyond success/failure. The
 * `plugins:` SDK option is reserved for the loopat-shipped builtin (which
 * lives under LOOPAT_INSTALL_DIR, not in CC's plugin cache).
 *
 * `lookupPluginInstallPath` remains a host-side utility for the slash-command
 * pre-seed (session.ts) and the loop-stats preview (loop-stats.ts).
 */
import { existsSync, statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { join, resolve as resolvePath } from "node:path"
import { promisify } from "node:util"
import { TEMPLATES_DIR, loopClaudeDir } from "./paths"

const execFileP = promisify(execFile)

/** loopat-shipped builtin plugin (not in CC's plugin cache; passed via SDK option). */
export const BUILTIN_LOOPAT_PLUGIN_PATH = join(TEMPLATES_DIR, "plugins", "loopat")

const USER_CLAUDE_DIR = join(homedir(), ".claude")
const USER_INSTALLED_PLUGINS = join(USER_CLAUDE_DIR, "plugins", "installed_plugins.json")
const USER_KNOWN_MARKETPLACES = join(USER_CLAUDE_DIR, "plugins", "known_marketplaces.json")

type InstalledPluginsFile = {
  version: number
  plugins: Record<string, Array<{ installPath: string; version: string; scope?: string }>>
}
type KnownMarketplacesFile = Record<string, { installLocation?: string; source?: any }>
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
      return (declared.repo ?? declared.repository) === (existing.repo ?? existing.repository)
    case "directory":
      return declared.path === existing.path
    default:
      return JSON.stringify(declared) === JSON.stringify(existing)
  }
}

async function ensureMarketplace(
  name: string,
  addPath: string,
  declaredSource: any,
  km: KnownMarketplacesFile | null,
): Promise<void> {
  const existing = (km?.[name] as any)?.source
  if (existing) {
    if (sourcesMatch(declaredSource, existing)) return
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

async function ensureExtraMarketplaces(
  extras: Record<string, { source?: any }> | undefined,
  loopId: string,
  km: KnownMarketplacesFile | null,
): Promise<void> {
  if (!extras) return
  for (const [name, entry] of Object.entries(extras)) {
    const src = entry?.source as any
    let addPath: string | undefined
    let normalized: any = src
    if (typeof src === "string") {
      addPath = src
      normalized = { source: "github", repo: src }
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
 * Mtime cache on loops/<id>/.claude/settings.json — we only re-run marketplace
 * registration + install when compose actually rewrote settings.
 */
type EnsureCacheEntry = { mtime: number }
const ensureCache = new Map<string, EnsureCacheEntry>()

/**
 * Idempotently ensure the host CC has every marketplace + enabled plugin
 * installed that the loop's merged settings.json declares. No return value —
 * the inner SDK resolves enabledPlugins natively at spawn time (via the
 * wholesale ~/.claude/plugins/ bind in bwrap.ts).
 */
export async function ensureLoopPluginsInstalled(loopId: string): Promise<void> {
  const settingsPath = join(loopClaudeDir(loopId), "settings.json")
  const mtime = existsSync(settingsPath) ? statSync(settingsPath).mtimeMs : 0

  const cached = ensureCache.get(loopId)
  if (cached && cached.mtime === mtime) return

  const settings = await readJsonOpt<{
    enabledPlugins?: Record<string, boolean>
    extraKnownMarketplaces?: Record<string, { source?: any }>
  }>(settingsPath)

  const enabled = Object.entries(settings?.enabledPlugins ?? {})
    .filter(([_, v]) => v)
    .map(([k]) => k)

  if (enabled.length === 0 && !settings?.extraKnownMarketplaces) {
    ensureCache.set(loopId, { mtime })
    return
  }

  const km = await readJsonOpt<KnownMarketplacesFile>(USER_KNOWN_MARKETPLACES)
  const ip = await readJsonOpt<InstalledPluginsFile>(USER_INSTALLED_PLUGINS)

  await ensureExtraMarketplaces(settings?.extraKnownMarketplaces, loopId, km)
  await ensurePluginsInstalled(enabled, ip)

  ensureCache.set(loopId, { mtime })
}

/**
 * Resolve a `name@marketplace` spec to a host path (best-effort, no install
 * side-effect). Used by:
 *   - session.ts: pre-seed plugin slash-commands before CC's init payload
 *   - loop-stats.ts: count plugin contributions for the NewLoopDialog preview
 *
 * Prefers the marketplace's local source dir (preserves symlinks); falls back
 * to the CC cache installPath. Returns null if not installed.
 */
export async function lookupPluginInstallPath(spec: string): Promise<string | null> {
  const ip = await readJsonOpt<InstalledPluginsFile>(USER_INSTALLED_PLUGINS)
  const km = await readJsonOpt<KnownMarketplacesFile>(USER_KNOWN_MARKETPLACES)
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
