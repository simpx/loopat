/**
 * Compute a preview of what a loop with given profiles will contain:
 * plugin count, skill count, agent count, hook count, MCP server count.
 *
 * Aggregates from all sources that will be merged at spawn time:
 *   - team:    .loopat/.claude/{settings.json, skills/, agents/}
 *   - profile: .loopat/profiles/<name>/.claude/{settings.json, skills/, agents/}
 *   - personal (skipped — per-user override; not included in pre-create preview)
 *
 * For each enabled plugin, also scans the plugin's source dir (host CC cache
 * OR local marketplace source) to count skills/agents/MCPs/hooks contributed.
 *
 * Result is deduplicated by name (skill "foo" from team + profile counts once).
 */
import { existsSync, readdirSync, statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, isAbsolute, dirname, resolve as resolvePath } from "node:path"
import {
  workspaceTeamClaudeDir,
  workspaceProfileClaudeDir,
} from "./paths"

export type LoopStats = {
  plugins: number
  skills: number
  agents: number
  hooks: number
  mcpServers: number
}

type Settings = {
  enabledPlugins?: Record<string, boolean>
  extraKnownMarketplaces?: Record<string, { source?: any }>
  mcpServers?: Record<string, any>
  hooks?: Record<string, any> | any[]
}

/** Read settings.json from a .claude/ dir. */
async function readSettings(claudeDir: string): Promise<Settings | null> {
  const p = join(claudeDir, "settings.json")
  if (!existsSync(p)) return null
  try {
    return JSON.parse(await readFile(p, "utf8")) as Settings
  } catch {
    return null
  }
}

/** Count entries in a dir (skipping dotfiles + non-matching). */
function countDirEntries(dir: string, opts?: { suffix?: string; mustBeDir?: boolean }): string[] {
  if (!existsSync(dir)) return []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries.filter((name) => {
    if (name.startsWith(".")) return false
    if (opts?.suffix && !name.endsWith(opts.suffix)) return false
    if (opts?.mustBeDir) {
      try {
        return statSync(join(dir, name)).isDirectory()
      } catch {
        return false
      }
    }
    return true
  })
}

/** Count entries in settings.json hooks field (can be array or object). */
function countHooks(s: Settings | null): number {
  if (!s?.hooks) return 0
  if (Array.isArray(s.hooks)) return s.hooks.length
  if (typeof s.hooks === "object") {
    let n = 0
    for (const v of Object.values(s.hooks)) {
      if (Array.isArray(v)) n += v.length
      else if (v) n++
    }
    return n
  }
  return 0
}

/** Resolve a host path for a plugin spec, if locally available. */
async function resolvePluginPath(spec: string): Promise<string | null> {
  const userClaudeDir = join(homedir(), ".claude")
  const ipPath = join(userClaudeDir, "plugins", "installed_plugins.json")
  const kmPath = join(userClaudeDir, "plugins", "known_marketplaces.json")
  if (!existsSync(ipPath)) return null

  let ip: any
  let km: any
  try {
    ip = JSON.parse(await readFile(ipPath, "utf8"))
    km = existsSync(kmPath) ? JSON.parse(await readFile(kmPath, "utf8")) : {}
  } catch {
    return null
  }

  const entry = ip.plugins?.[spec]?.[0]
  if (!entry?.installPath) return null

  // Prefer local marketplace source path (has the latest content)
  const atIdx = spec.lastIndexOf("@")
  if (atIdx >= 0) {
    const pluginName = spec.slice(0, atIdx)
    const marketName = spec.slice(atIdx + 1)
    const market = km?.[marketName]
    if (market?.installLocation) {
      const mpJsonPath = join(market.installLocation, ".claude-plugin", "marketplace.json")
      if (existsSync(mpJsonPath)) {
        try {
          const catalog = JSON.parse(await readFile(mpJsonPath, "utf8"))
          const cat = catalog?.plugins?.find((p: any) => p.name === pluginName)
          const src = typeof cat?.source === "string" ? cat.source : null
          if (src?.startsWith("./")) {
            const p = join(market.installLocation, src)
            if (existsSync(p)) return p
          }
        } catch {}
      }
    }
  }
  return existsSync(entry.installPath) ? entry.installPath : null
}

/**
 * Scan a plugin's directory for skills, agents, hooks, mcpServers.
 * Returns sets of names (so callers can dedupe across plugins/sources).
 */
async function scanPlugin(pluginDir: string): Promise<{
  skills: string[]
  agents: string[]
  hooks: number
  mcpServers: string[]
}> {
  const skills = countDirEntries(join(pluginDir, "skills"), { mustBeDir: true })
  const agents = countDirEntries(join(pluginDir, "agents"), { suffix: ".md" })
    .map((n) => n.replace(/\.md$/, ""))

  let hooks = 0
  let mcpServers: string[] = []

  // Plugin .mcp.json gives mcpServers list
  const mcpPath = join(pluginDir, ".mcp.json")
  if (existsSync(mcpPath)) {
    try {
      const j = JSON.parse(await readFile(mcpPath, "utf8"))
      mcpServers = Object.keys(j?.mcpServers ?? {})
    } catch {}
  }

  // Plugin hooks/ dir or hooks.json
  const hooksJson = join(pluginDir, "hooks", "hooks.json")
  if (existsSync(hooksJson)) {
    try {
      const j = JSON.parse(await readFile(hooksJson, "utf8"))
      if (Array.isArray(j?.hooks)) hooks = j.hooks.length
      else if (typeof j?.hooks === "object") {
        for (const v of Object.values(j.hooks)) {
          if (Array.isArray(v)) hooks += v.length
        }
      }
    } catch {}
  }

  return { skills, agents, hooks, mcpServers }
}

/**
 * Main entry: compute the totals for a hypothetical loop with the given
 * non-base profiles (team is always implicit). Returns deduped counts.
 */
export async function computeLoopStats(profiles: string[]): Promise<LoopStats> {
  // Collect all source .claude/ dirs to scan
  const sources: Array<{ source: string; dir: string }> = []
  const teamDir = workspaceTeamClaudeDir()
  if (existsSync(teamDir)) sources.push({ source: "team", dir: teamDir })
  for (const p of profiles) {
    const d = workspaceProfileClaudeDir(p)
    if (existsSync(d)) sources.push({ source: `profile:${p}`, dir: d })
  }

  // Sets to dedupe across sources
  const enabledPluginSet = new Set<string>()
  const skillSet = new Set<string>()
  const agentSet = new Set<string>()
  const mcpServerSet = new Set<string>()
  let hookCount = 0

  for (const s of sources) {
    const settings = await readSettings(s.dir)
    if (settings?.enabledPlugins) {
      for (const [k, v] of Object.entries(settings.enabledPlugins)) {
        if (v) enabledPluginSet.add(k)
      }
    }
    if (settings?.mcpServers) {
      for (const k of Object.keys(settings.mcpServers)) mcpServerSet.add(k)
    }
    hookCount += countHooks(settings)

    // Loose skills + agents at the source level (not from plugins)
    for (const name of countDirEntries(join(s.dir, "skills"), { mustBeDir: true })) {
      skillSet.add(name)
    }
    for (const name of countDirEntries(join(s.dir, "agents"), { suffix: ".md" })) {
      agentSet.add(name.replace(/\.md$/, ""))
    }
  }

  // Now scan each enabled plugin for its contributions
  for (const spec of enabledPluginSet) {
    const pluginDir = await resolvePluginPath(spec)
    if (!pluginDir) continue
    const scan = await scanPlugin(pluginDir)
    for (const s of scan.skills) skillSet.add(`${spec.split("@")[0]}:${s}`)
    for (const a of scan.agents) agentSet.add(`${spec.split("@")[0]}:${a}`)
    for (const m of scan.mcpServers) mcpServerSet.add(m)
    hookCount += scan.hooks
  }

  return {
    plugins: enabledPluginSet.size,
    skills: skillSet.size,
    agents: agentSet.size,
    hooks: hookCount,
    mcpServers: mcpServerSet.size,
  }
}
