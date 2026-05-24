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
    overrides: {},
  })

  return { tiers, mergedSettings: finalMerged, isAdmin }
}

async function readMdOrNull(path: string): Promise<string | null> {
  if (!existsSync(path)) return null
  try { return await readFile(path, "utf8") } catch { return null }
}

// ── per-tier settings read/write ──

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

// ── plugin inventory ──

export async function listAvailablePlugins(): Promise<PluginEntry[]> {
  // Read known marketplaces + installed plugins from host CC cache.
  // These live under ~/.claude/plugins/ which the sandbox binds wholesale.
  const cacheDir = join(homedir(), ".claude", "plugins")
  const knownMpPath = join(cacheDir, "known_marketplaces.json")
  const installedPath = join(cacheDir, "installed_plugins.json")

  const out: PluginEntry[] = []
  if (existsSync(installedPath)) {
    try {
      const installed = JSON.parse(await readFile(installedPath, "utf8")) as Record<string, any>
      for (const [key, info] of Object.entries(installed)) {
        const [name, marketplace] = key.includes("@") ? [key.slice(0, key.lastIndexOf("@")), key.slice(key.lastIndexOf("@") + 1)] : [key, ""]
        out.push({
          name,
          marketplace,
          displayName: info?.displayName ?? name,
          description: info?.description ?? undefined,
        })
      }
    } catch {}
  }
  return out
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
    const desc = md ? md.split("\n")[0].replace(/^#+\s*/, "").trim() : null
    out.push({
      name: e.name,
      path: cd,
      description: desc || null,
      settings,
      claudeMd: md,
      ...settingsSummary(settings),
      skillCount: await countDir(workspaceProfileSkillsDir(e.name)),
      agentCount: await countDir(workspaceProfileAgentsDir(e.name)),
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
  const desc = md ? md.split("\n")[0].replace(/^#+\s*/, "").trim() : null
  return {
    name,
    path: cd,
    description: desc || null,
    settings,
    claudeMd: md,
    ...settingsSummary(settings),
    skillCount: await countDir(workspaceProfileSkillsDir(name)),
    agentCount: await countDir(workspaceProfileAgentsDir(name)),
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
