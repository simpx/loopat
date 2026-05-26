/**
 * Tier metadata + settings read/write for the five-tier composition model.
 * Team / profile / personal tiers are loopat-managed; project / local are
 * SDK-managed (read-only from Settings page perspective).
 */
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import {
  personalClaudeDir,
  personalClaudeMdPath,
  personalSettingsPath,
  personalSkillsDir,
  personalAgentsDir,
  workspaceProfilesDir,
  workspaceProfileClaudeDir,
  workspaceProfileDir,
  workspaceProfileSettingsPath,
  workspaceProfileClaudeMdPath,
  workspaceProfileSkillsDir,
  workspaceProfileAgentsDir,
  workspaceTeamClaudeDir,
  workspaceTeamSettingsPath,
  workspaceTeamClaudeMdPath,
  workspaceTeamSkillsDir,
  workspaceTeamAgentsDir,
} from "./paths"
import { countToolchainTools } from "./loop-stats"

// ── types ──

export type TierId = "team" | `profile:${string}` | "personal" | "project" | "local"

export type TierInfo = {
  id: TierId
  label: string
  path: string
  exists: boolean
  editable: boolean
  managedBy: "admin" | "user" | "sdk"
  /** Parsed settings.json — null if tier doesn't exist or has no settings.json. */
  settings: Record<string, any> | null
  claudeMd: string | null
  pluginCount: number
  mcpServerCount: number
  marketplaceCount: number
  hookCount: number
  skillCount: number
  agentCount: number
  /** Toolchain tools declared in this tier's mise.toml. */
  toolchainCount: number
  /** Keys in this tier that shadow same-name keys from a lower tier. */
  overrides: Record<string, { overrides: string; value: any }>
}

export type TiersResponse = {
  tiers: TierInfo[]
  /** Merged settings (team + profiles + personal), for preview. */
  mergedSettings: Record<string, any>
  /** User role for permission gating. */
  isAdmin: boolean
}

export type PluginEntry = {
  name: string
  marketplace: string
  displayName: string
  description?: string
}

// ── helpers ──

async function readJsonOrNull(path: string): Promise<Record<string, any> | null> {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch { return null }
}

async function countDir(path: string): Promise<number> {
  if (!existsSync(path)) return 0
  try {
    const entries = await readdir(path)
    return entries.filter((e) => !e.startsWith(".")).length
  } catch { return 0 }
}

/**
 * Pull a one-line description from a profile's CLAUDE.md. Priority:
 *   1. YAML frontmatter `description:` field (mirrors SKILL.md / agent.md
 *      idiom — CC SDK already parses this for tool routing)
 *   2. First non-empty heading (`# ...` line), with `#` stripped — legacy
 *      convention, kept as fallback so older profiles "just work"
 *
 * Returns null when neither is present. Pure text op; no I/O.
 */
export function extractProfileDescription(md: string | null): string | null {
  if (!md) return null
  // 1. Frontmatter (YAML) — between leading `---\n` and `---\n`
  const fm = md.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/)
  if (fm) {
    const desc = fm[1].match(/^description:\s*(.+?)\s*$/m)
    if (desc) {
      // Strip optional surrounding quotes (YAML allows "..." / '...')
      const raw = desc[1].trim()
      const stripped = raw.replace(/^["'](.*)["']$/, "$1").trim()
      if (stripped) return stripped
    }
  }
  // 2. First heading — legacy fallback
  const body = fm ? md.slice(fm[0].length) : md
  for (const line of body.split("\n")) {
    const t = line.trim()
    if (!t) continue
    if (t.startsWith("#")) return t.replace(/^#+\s*/, "").trim() || null
    // First non-empty non-heading line ends the search — description is "missing"
    return null
  }
  return null
}

function computeOverrides(
  settings: Record<string, any> | null,
  lowerSettings: Record<string, any>,
): Record<string, { overrides: string; value: any }> {
  if (!settings) return {}
  const out: Record<string, { overrides: string; value: any }> = {}
  for (const [k, v] of Object.entries(settings)) {
    if (k === "_comment") continue
    if (k === "enabledPlugins" && v && typeof v === "object") {
      for (const [pn, pv] of Object.entries(v as Record<string, any>)) {
        const lv = (lowerSettings?.enabledPlugins as Record<string, any>)?.[pn]
        if (lv !== undefined) out[`enabledPlugins.${pn}`] = { overrides: "team", value: pv }
      }
    } else if (k === "mcpServers" && v && typeof v === "object") {
      for (const [sn] of Object.entries(v as Record<string, any>)) {
        if ((lowerSettings?.mcpServers as Record<string, any>)?.[sn] !== undefined) {
          out[`mcpServers.${sn}`] = { overrides: "team", value: true }
        }
      }
    } else if (k === "extraKnownMarketplaces" && v && typeof v === "object") {
      for (const [mn] of Object.entries(v as Record<string, any>)) {
        if ((lowerSettings?.extraKnownMarketplaces as Record<string, any>)?.[mn] !== undefined) {
          out[`extraKnownMarketplaces.${mn}`] = { overrides: "team", value: true }
        }
      }
    } else if (k === "hooks" && v && typeof v === "object") {
      for (const [hn] of Object.entries(v as Record<string, any>)) {
        if ((lowerSettings?.hooks as Record<string, any>)?.[hn] !== undefined) {
          out[`hooks.${hn}`] = { overrides: "team", value: true }
        }
      }
    } else {
      if (lowerSettings?.[k] !== undefined) {
        out[k] = { overrides: "team", value: v }
      }
    }
  }
  return out
}

/** Shallow union merge (later wins) — simpler than compose.ts deep merge
 *  but sufficient for override detection in the settings UI. */
function shallowUnion(a: Record<string, any>, b: Record<string, any>): Record<string, any> {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (k === "_comment") continue
    if (
      typeof v === "object" && v !== null && !Array.isArray(v) &&
      typeof out[k] === "object" && out[k] !== null && !Array.isArray(out[k])
    ) {
      out[k] = { ...out[k], ...v }
    } else {
      out[k] = v
    }
  }
  return out
}

function settingsSummary(s: Record<string, any> | null) {
  return {
    pluginCount: s?.enabledPlugins ? Object.keys(s.enabledPlugins).filter((k: string) => s.enabledPlugins[k]).length : 0,
    mcpServerCount: s?.mcpServers ? Object.keys(s.mcpServers).length : 0,
    marketplaceCount: s?.extraKnownMarketplaces ? Object.keys(s.extraKnownMarketplaces).length : 0,
    hookCount: s?.hooks ? Object.keys(s.hooks).length : 0,
  }
}

// ── main tier listing ──

export async function getTiers(user: string, isAdmin: boolean): Promise<TiersResponse> {
  const tiers: TierInfo[] = []
  let merged: Record<string, any> = {}

  // 1. Team tier
  const teamDir = workspaceTeamClaudeDir()
  const teamSettings = await readJsonOrNull(workspaceTeamSettingsPath())
  tiers.push({
    id: "team",
    label: "Team",
    path: teamDir,
    exists: existsSync(teamDir),
    editable: isAdmin,
    managedBy: "admin",
    settings: teamSettings,
    claudeMd: await readMdOrNull(workspaceTeamClaudeMdPath()),
    ...settingsSummary(teamSettings),
    skillCount: await countDir(workspaceTeamSkillsDir()),
    agentCount: await countDir(workspaceTeamAgentsDir()),
    toolchainCount: countToolchainTools(teamDir).length,
    overrides: {},
  })
  if (teamSettings) merged = shallowUnion(merged, teamSettings)

  // 2. Profile tiers (all existing profiles)
  const profilesDir = workspaceProfilesDir()
  if (existsSync(profilesDir)) {
    const entries = await readdir(profilesDir, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue
      const claudeDir = workspaceProfileClaudeDir(e.name)
      if (!existsSync(claudeDir)) continue
      const ps = await readJsonOrNull(workspaceProfileSettingsPath(e.name))
      const overrides = computeOverrides(ps, merged)
      tiers.push({
        id: `profile:${e.name}`,
        label: `Profile: ${e.name}`,
        path: claudeDir,
        exists: true,
        editable: isAdmin,
        managedBy: "admin",
        settings: ps,
        claudeMd: await readMdOrNull(workspaceProfileClaudeMdPath(e.name)),
        ...settingsSummary(ps),
        skillCount: await countDir(workspaceProfileSkillsDir(e.name)),
        agentCount: await countDir(workspaceProfileAgentsDir(e.name)),
        toolchainCount: countToolchainTools(claudeDir).length,
        overrides,
      })
      if (ps) merged = shallowUnion(merged, ps)
    }
  }

  // 3. Personal tier
  const personalCdir = personalClaudeDir(user)
  const personalSettings = await readJsonOrNull(personalSettingsPath(user))
  const personalOverrides = computeOverrides(personalSettings, merged)
  tiers.push({
    id: "personal",
    label: "Personal",
    path: personalCdir,
    exists: existsSync(personalCdir),
    editable: true,
    managedBy: "user",
    settings: personalSettings,
    claudeMd: await readMdOrNull(personalClaudeMdPath(user)),
    ...settingsSummary(personalSettings),
    skillCount: await countDir(personalSkillsDir(user)),
    agentCount: await countDir(personalAgentsDir(user)),
    toolchainCount: countToolchainTools(personalCdir).length,
    overrides: personalOverrides,
  })
  const finalMerged = personalSettings ? shallowUnion(merged, personalSettings) : merged

  // 4. Project tier (SDK-managed, informational)
  tiers.push({
    id: "project",
    label: "Project",
    path: "<workdir>/.claude/",
    exists: false,
    editable: false,
    managedBy: "sdk",
    settings: null,
    claudeMd: null,
    pluginCount: 0,
    mcpServerCount: 0,
    marketplaceCount: 0,
    hookCount: 0,
    skillCount: 0,
    agentCount: 0,
    toolchainCount: 0,
    overrides: {},
  })

  // 5. Local tier (SDK-managed, informational)
  tiers.push({
    id: "local",
    label: "Local",
    path: "<workdir>/.claude/*.local.*",
    exists: false,
    editable: false,
    managedBy: "sdk",
    settings: null,
    claudeMd: null,
    pluginCount: 0,
    mcpServerCount: 0,
    marketplaceCount: 0,
    hookCount: 0,
    skillCount: 0,
    agentCount: 0,
    toolchainCount: 0,
    overrides: {},
  })

  return { tiers, mergedSettings: finalMerged, isAdmin }
}

async function readMdOrNull(path: string): Promise<string | null> {
  if (!existsSync(path)) return null
  try { return await readFile(path, "utf8") } catch { return null }
}

// ── per-tier settings read/write ──

function resolveTierClaudeDir(tierId: string, user: string): string | null {
  if (tierId === "team") return workspaceTeamClaudeDir()
  if (tierId === "personal") return personalClaudeDir(user)
  if (tierId.startsWith("profile:")) {
    const name = tierId.slice("profile:".length)
    return workspaceProfileClaudeDir(name)
  }
  return null
}

function resolveTierPath(tierId: string, user: string): { settingsPath: string; exists: boolean } | null {
  if (tierId === "team") {
    const p = workspaceTeamSettingsPath()
    return { settingsPath: p, exists: existsSync(p) }
  }
  if (tierId === "personal") {
    const p = personalSettingsPath(user)
    return { settingsPath: p, exists: existsSync(p) }
  }
  if (tierId.startsWith("profile:")) {
    const name = tierId.slice("profile:".length)
    const p = workspaceProfileSettingsPath(name)
    return { settingsPath: p, exists: existsSync(p) }
  }
  return null
}

export async function getTierSettings(
  tierId: string,
  user: string,
): Promise<Record<string, any>> {
  const res = resolveTierPath(tierId, user)
  if (!res) return {}
  if (!res.exists) return {}
  return (await readJsonOrNull(res.settingsPath)) ?? {}
}

export async function saveTierSettings(
  tierId: string,
  settings: Record<string, any>,
  user: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = resolveTierPath(tierId, user)
  if (!res) return { ok: false, error: `unknown tier: ${tierId}` }
  try {
    await mkdir(join(res.settingsPath, ".."), { recursive: true })
    await writeFile(res.settingsPath, JSON.stringify(settings, null, 2) + "\n")
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "write failed" }
  }
}

// ── mise.toml config per tier ──

export async function getTierMiseConfig(
  tierId: string,
  user: string,
): Promise<{ content: string; exists: boolean; error?: string }> {
  const claudeDir = resolveTierClaudeDir(tierId, user)
  if (!claudeDir) return { content: "", exists: false, error: `unknown tier: ${tierId}` }
  const misePath = join(claudeDir, "mise.toml")
  if (!existsSync(misePath)) return { content: "", exists: false }
  try {
    const content = await readFile(misePath, "utf8")
    return { content, exists: true }
  } catch (e: any) {
    return { content: "", exists: false, error: e?.message ?? "read failed" }
  }
}

export async function saveTierMiseConfig(
  tierId: string,
  content: string,
  user: string,
): Promise<{ ok: boolean; error?: string }> {
  const claudeDir = resolveTierClaudeDir(tierId, user)
  if (!claudeDir) return { ok: false, error: `unknown tier: ${tierId}` }
  try {
    await mkdir(claudeDir, { recursive: true })
    const misePath = join(claudeDir, "mise.toml")
    await writeFile(misePath, content)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "write failed" }
  }
}

/** Read a single plugin.json from an installPath to get displayName + description. */
async function readPluginMeta(installPath: string): Promise<{ displayName?: string; description?: string }> {
  const pj = join(installPath, ".claude-plugin", "plugin.json")
  if (!existsSync(pj)) return {}
  try {
    const j = JSON.parse(await readFile(pj, "utf8"))
    return {
      displayName: typeof j.displayName === "string" ? j.displayName : undefined,
      description: typeof j.description === "string" ? j.description : undefined,
    }
  } catch { return {} }
}

// ── plugin inventory ──

export type MarketplaceSource = {
  name: string
  source: any
  installLocation?: string
}

export type PluginWithStatus = PluginEntry & {
  installed: boolean
  marketplaceName: string
}

export async function listAvailablePlugins(): Promise<PluginEntry[]> {
  // Read installed plugins from host CC cache.
  const cacheDir = join(homedir(), ".claude", "plugins")
  const installedPath = join(cacheDir, "installed_plugins.json")

  const out: PluginEntry[] = []
  if (existsSync(installedPath)) {
    try {
      const installed = JSON.parse(await readFile(installedPath, "utf8"))
      const plugins = installed?.plugins ?? installed
      for (const [key, entries] of Object.entries(plugins as Record<string, any>)) {
        const atIdx = key.lastIndexOf("@")
        const name = atIdx >= 0 ? key.slice(0, atIdx) : key
        const marketplace = atIdx >= 0 ? key.slice(atIdx + 1) : ""
        // Get installPath from first entry, read plugin.json for metadata
        const installPath = Array.isArray(entries) && entries.length > 0
          ? (entries[0] as any)?.installPath
          : undefined
        const meta = installPath ? await readPluginMeta(installPath) : {}
        out.push({
          name,
          marketplace,
          displayName: meta.displayName ?? name,
          description: meta.description ?? undefined,
        })
      }
    } catch {}
  }
  return out
}

/** List known marketplaces from CC's cache. */
export async function listMarketplaces(): Promise<MarketplaceSource[]> {
  const cacheDir = join(homedir(), ".claude", "plugins")
  const knownMpPath = join(cacheDir, "known_marketplaces.json")
  if (!existsSync(knownMpPath)) return []
  try {
    const kf = JSON.parse(await readFile(knownMpPath, "utf8")) as Record<string, any>
    return Object.entries(kf).map(([name, info]) => ({
      name,
      source: info?.source ?? null,
      installLocation: info?.installLocation ?? undefined,
    }))
  } catch {
    return []
  }
}

/** Browse plugins from marketplace catalogs (not just installed ones).
 *  Scans known_marketplaces.json for each marketplace's install location,
 *  then reads .claude-plugin/marketplace.json for the plugin catalog. */
export async function browseMarketplacePlugins(): Promise<PluginWithStatus[]> {
  const cacheDir = join(homedir(), ".claude", "plugins")
  const knownMpPath = join(cacheDir, "known_marketplaces.json")
  const installedPath = join(cacheDir, "installed_plugins.json")

  // Build set of installed plugin keys
  const installedSet = new Set<string>()
  if (existsSync(installedPath)) {
    try {
      const installed = JSON.parse(await readFile(installedPath, "utf8")) as Record<string, any>
      for (const key of Object.keys(installed)) installedSet.add(key)
    } catch {}
  }

  const out: PluginWithStatus[] = []

  if (!existsSync(knownMpPath)) return out

  try {
    const kf = JSON.parse(await readFile(knownMpPath, "utf8")) as Record<string, any>
    for (const [mpName, mpInfo] of Object.entries(kf)) {
      const loc = mpInfo?.installLocation
      if (!loc || typeof loc !== "string") continue
      const catalogPath = join(loc, ".claude-plugin", "marketplace.json")
      if (!existsSync(catalogPath)) continue
      try {
        const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as { plugins?: Array<{ name: string; source: any }> }
        for (const p of catalog.plugins ?? []) {
          const key = `${p.name}@${mpName}`
          // For local marketplaces, try reading plugin.json from the plugin subdir
          let desc: string | undefined
          let dname: string | undefined
          const pluginDir = join(loc, p.name)
          if (existsSync(pluginDir)) {
            const meta = await readPluginMeta(pluginDir)
            dname = meta.displayName
            desc = meta.description
          }
          out.push({
            name: p.name,
            marketplace: mpName,
            marketplaceName: mpName,
            displayName: dname ?? p.name,
            description: desc ?? undefined,
            installed: installedSet.has(key),
          })
        }
      } catch {}
    }
  } catch {}

  return out
}

/** Refresh marketplace registrations: scan all tiers' extraKnownMarketplaces,
 *  register any new ones with the host CC, and update existing ones with
 *  source/branch drift. This ensures browseMarketplacePlugins can see them. */
export async function refreshMarketplaces(user: string): Promise<{ ok: boolean; added: string[]; error?: string }> {
  try {
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const execFileP = promisify(execFile)
    const runClaude = async (args: string[]) => {
      try {
        await execFileP("claude", args)
        return { ok: true }
      } catch (e: any) {
        return { ok: false, err: e?.stderr?.toString?.() ?? e?.message ?? String(e) }
      }
    }

    // 1. Read existing known_marketplaces.json
    const kmPath = join(homedir(), ".claude", "plugins", "known_marketplaces.json")
    let knownMarketplaces: Record<string, any> = {}
    if (existsSync(kmPath)) {
      try { knownMarketplaces = JSON.parse(await readFile(kmPath, "utf8")) } catch {}
    }

    // 2. Collect all extraKnownMarketplaces from all tiers
    const extras: Record<string, any> = {}

    // Team tier
    const teamSettings = await readJsonOrNull(workspaceTeamSettingsPath())
    if (teamSettings?.extraKnownMarketplaces) {
      Object.assign(extras, teamSettings.extraKnownMarketplaces)
    }

    // All profiles
    const profilesDir = workspaceProfilesDir()
    if (existsSync(profilesDir)) {
      const entries = await readdir(profilesDir, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue
        const ps = await readJsonOrNull(workspaceProfileSettingsPath(e.name))
        if (ps?.extraKnownMarketplaces) {
          Object.assign(extras, ps.extraKnownMarketplaces)
        }
      }
    }

    // Personal tier
    const personalSettings = await readJsonOrNull(personalSettingsPath(user))
    if (personalSettings?.extraKnownMarketplaces) {
      Object.assign(extras, personalSettings.extraKnownMarketplaces)
    }

    // 3. For each marketplace, register it with CC if missing or drifted
    const added: string[] = []
    for (const [name, entry] of Object.entries(extras)) {
      const src = (entry as any)?.source
      if (!src) continue

      // Determine the add path. CC auto-detects source type from the path
      // (URL → git, owner/repo → github, absolute path → directory).
      let addPath: string | undefined
      if (src.source === "directory" && typeof src.path === "string") {
        addPath = src.path
      } else if (src.source === "github" && typeof src.repo === "string") {
        addPath = src.repo
      } else if ((src.source === "git" || src.source === "url") && typeof src.url === "string") {
        addPath = src.url
      }

      if (!addPath) continue

      // Check if marketplace already registered — search by source match
      const existing = knownMarketplaces[name]
        ?? Object.entries(knownMarketplaces).find(([, v]: [string, any]) => {
            const es = v?.source
            if (!es) return false
            if (es.source === "directory" && es.path === src.path) return true
            if (es.source === "github" && es.repo === src.repo) return true
            if ((es.source === "git" || es.source === "url") && es.url === src.url) return true
            return false
          })?.[0]

      if (existing) {
        const existEntry = knownMarketplaces[existing]
        const existSrc = existEntry?.source
        const needUpdate = !existSrc ||
          existSrc.source !== src.source ||
          (src.source === "git" && existSrc.url !== src.url) ||
          (src.source === "github" && existSrc.repo !== src.repo) ||
          (src.source === "directory" && existSrc.path !== src.path) ||
          (typeof src.branch === "string" && existSrc.branch !== src.branch)

        if (!needUpdate) continue

        // Source or branch changed — remove old and re-add
        console.warn(`[tiers] marketplace "${existing}" source/branch drift, re-registering`)
        await runClaude(["plugin", "marketplace", "remove", existing])
      }

      // Build add command: claude plugin marketplace add <path> [--branch <b>]
      // CC auto-detects source type (and derives name) from the path.
      const args = ["plugin", "marketplace", "add", addPath]
      if (typeof src.branch === "string" && src.branch) {
        args.push("--branch", src.branch)
      }

      const r = await runClaude(args)
      if (r.ok) {
        added.push(name)
      } else {
        console.warn(`[tiers] failed to register marketplace "${name}": ${r.err}`)
      }
    }

    return { ok: true, added }
  } catch (e: any) {
    return { ok: false, added: [], error: e?.message ?? "refresh failed" }
  }
}

// ── profile CRUD (admin) ──

export type ProfileDetail = {
  name: string
  path: string
  description: string | null
  settings: Record<string, any> | null
  claudeMd: string | null
  pluginCount: number
  mcpServerCount: number
  marketplaceCount: number
  hookCount: number
  skillCount: number
  agentCount: number
  /** Toolchain tools declared in this profile's mise.toml. */
  toolchainCount: number
}

export async function listProfilesRich(): Promise<ProfileDetail[]> {
  const root = workspaceProfilesDir()
  if (!existsSync(root)) return []
  const entries = await readdir(root, { withFileTypes: true })
  const out: ProfileDetail[] = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue
    const cd = workspaceProfileClaudeDir(e.name)
    if (!existsSync(cd)) continue
    const settings = await readJsonOrNull(workspaceProfileSettingsPath(e.name))
    const md = await readMdOrNull(workspaceProfileClaudeMdPath(e.name))
    const desc = extractProfileDescription(md)
    out.push({
      name: e.name,
      path: cd,
      description: desc || null,
      settings,
      claudeMd: md,
      ...settingsSummary(settings),
      skillCount: await countDir(workspaceProfileSkillsDir(e.name)),
      agentCount: await countDir(workspaceProfileAgentsDir(e.name)),
      toolchainCount: countToolchainTools(cd).length,
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export async function createProfile(name: string): Promise<{ ok: boolean; error?: string }> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return { ok: false, error: "name must be alphanumeric, dash, or underscore" }
  const dir = workspaceProfileDir(name)
  if (existsSync(dir)) return { ok: false, error: `profile "${name}" already exists` }
  try {
    await mkdir(workspaceProfileClaudeDir(name), { recursive: true })
    // Seed with empty settings.json and stub CLAUDE.md
    await writeFile(workspaceProfileSettingsPath(name), "{}\n")
    await writeFile(workspaceProfileClaudeMdPath(name), `# ${name} profile\n\nAdd instructions for this profile here.\n`)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "create failed" }
  }
}

export async function getProfile(name: string): Promise<ProfileDetail | null> {
  const cd = workspaceProfileClaudeDir(name)
  if (!existsSync(cd)) return null
  const settings = await readJsonOrNull(workspaceProfileSettingsPath(name))
  const md = await readMdOrNull(workspaceProfileClaudeMdPath(name))
  const desc = extractProfileDescription(md)
  return {
    name,
    path: cd,
    description: desc || null,
    settings,
    claudeMd: md,
    ...settingsSummary(settings),
    skillCount: await countDir(workspaceProfileSkillsDir(name)),
    agentCount: await countDir(workspaceProfileAgentsDir(name)),
    toolchainCount: countToolchainTools(cd).length,
  }
}

export async function updateProfile(
  name: string,
  data: { settings?: Record<string, any>; claudeMd?: string },
): Promise<{ ok: boolean; error?: string }> {
  const cd = workspaceProfileClaudeDir(name)
  if (!existsSync(cd)) return { ok: false, error: `profile "${name}" not found` }
  try {
    if (data.settings !== undefined) {
      await writeFile(workspaceProfileSettingsPath(name), JSON.stringify(data.settings, null, 2) + "\n")
    }
    if (data.claudeMd !== undefined) {
      await writeFile(workspaceProfileClaudeMdPath(name), data.claudeMd)
    }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "update failed" }
  }
}

export async function deleteProfile(name: string): Promise<{ ok: boolean; error?: string }> {
  const dir = workspaceProfileDir(name)
  if (!existsSync(dir)) return { ok: false, error: `profile "${name}" not found` }
  try {
    await rm(dir, { recursive: true, force: true })
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "delete failed" }
  }
}
