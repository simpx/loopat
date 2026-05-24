/**
 * Profile resolver — CC-native model (post-2026-05 refactor).
 *
 * A "profile" in loopat is a directory under `.loopat/profiles/<name>/`
 * that contains a `.claude/` subdir (the same shape CC's project-tier uses:
 * settings.json + CLAUDE.md + skills/ + agents/). No loopat-invented schema.
 *
 * On loop spawn, loopat:
 *   1. Determines active profiles (user defaults + CLI flags)
 *   2. Merges team's `.loopat/.claude/` + each active profile's `.claude/`
 *      + personal layer into loop's `.claude/` (handled by compose.ts)
 *   3. Reads merged settings.json's `enabledPlugins` + `extraKnownMarketplaces`
 *      to drive plugin installation (handled by plugin-installer.ts)
 *
 * See docs/composition.md.
 */

import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import {
  personalClaudeDir,
  personalLoopatConfigPath,
  personalVaultDir,
  workspaceProfileClaudeDir,
  workspaceProfilesDir,
  workspaceTeamClaudeDir,
} from "./paths"

/** personal/<u>/.loopat/config.json fields relevant to profile resolution. */
export type PersonalProfileConfig = {
  default_profiles?: string[]
  default_vault?: string
  prefs?: Record<string, unknown>
}

/** Output of resolveLoopPlan — describes the materialization sources. */
export type LoopPlan = {
  user: string
  /** `.claude/` dirs to merge into the loop's .claude/, in load order
   *  (later sources win on conflicts; team first, profiles in declared order,
   *  personal last). */
  claudeSources: Array<{ source: string; dir: string }>
  /** Active profile names (excludes team & personal). */
  profiles: string[]
  /** Vault selection (from personal config or override). */
  vault?: string
  /** Resolved vault dir on host (if exists). */
  vaultDir?: string
}

export type ResolveInput = {
  user: string
  /** Profiles added via CLI (+name). */
  cliAdded?: string[]
  /** Profiles removed via CLI (-name). */
  cliRemoved?: string[]
  /** Hard override — replaces default_profiles. */
  overrideProfiles?: string[]
  /** Override vault selection. */
  vaultOverride?: string
  /** Repo workdir — if it has a `.claude/`, it becomes the 5th merge layer
   *  (highest precedence; CC project-tier semantics). */
  workdir?: string
}

async function readPersonalConfig(user: string): Promise<PersonalProfileConfig> {
  const path = personalLoopatConfigPath(user)
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(await readFile(path, "utf8")) as PersonalProfileConfig
  } catch {
    return {}
  }
}

/**
 * Compute active profile set: (default_profiles ∪ cliAdded) − cliRemoved,
 * with overrideProfiles replacing default_profiles when set. Order preserved:
 * defaults first, then cliAdded. Team-tier is always implicit (handled by
 * compose); no need to include it here.
 */
function computeActiveProfiles(
  cfg: PersonalProfileConfig,
  cliAdded: string[],
  cliRemoved: string[],
  overrideProfiles?: string[],
): string[] {
  const base = overrideProfiles ?? cfg.default_profiles ?? []
  const removed = new Set(cliRemoved)
  const all = [...base, ...cliAdded]
  const out: string[] = []
  const seen = new Set<string>()
  for (const p of all) {
    if (removed.has(p) || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

/**
 * Main entry: produce a LoopPlan from inputs. Pure / no side effects.
 * Validates that named profiles actually have `.claude/` subdirs (otherwise
 * they'd be silently invisible).
 */
export async function resolveLoopPlan(input: ResolveInput): Promise<LoopPlan> {
  const { user, cliAdded = [], cliRemoved = [], overrideProfiles, vaultOverride, workdir } = input

  const cfg = await readPersonalConfig(user)
  const activeNames = computeActiveProfiles(cfg, cliAdded, cliRemoved, overrideProfiles)

  // Validate
  const profilesRoot = workspaceProfilesDir()
  if (activeNames.length > 0 && !existsSync(profilesRoot)) {
    throw new Error(`workspace profiles dir not found: ${profilesRoot}`)
  }
  for (const name of activeNames) {
    const cdir = workspaceProfileClaudeDir(name)
    if (!existsSync(cdir)) {
      throw new Error(`profile "${name}" has no .claude/ dir at ${cdir}`)
    }
  }

  // Build claudeSources in merge order
  const claudeSources: LoopPlan["claudeSources"] = []
  const teamDir = workspaceTeamClaudeDir()
  if (existsSync(teamDir)) {
    claudeSources.push({ source: "team", dir: teamDir })
  }
  for (const name of activeNames) {
    claudeSources.push({ source: `profile:${name}`, dir: workspaceProfileClaudeDir(name) })
  }
  // Personal `.claude/` — 4th layer. Same CC-native shape as workspace + profile.
  const personalCdir = personalClaudeDir(user)
  if (existsSync(personalCdir)) {
    claudeSources.push({ source: `personal:${user}`, dir: personalCdir })
  }

  // Repo `.claude/` — 5th (highest) layer. CC project-tier from workdir.
  // Optional; only if workdir is set AND has a .claude/ subdir.
  if (workdir) {
    const repoCdir = join(workdir, ".claude")
    if (existsSync(repoCdir)) {
      claudeSources.push({ source: `repo:${workdir}`, dir: repoCdir })
    }
  }

  const vault = vaultOverride ?? cfg.default_vault
  const vaultDir = vault ? personalVaultDir(user, vault) : undefined

  return {
    user,
    claudeSources,
    profiles: activeNames,
    vault,
    vaultDir: vaultDir && existsSync(vaultDir) ? vaultDir : undefined,
  }
}

/** List available profile names = direct subdirs of profiles/ that contain `.claude/`. */
export async function listProfiles(): Promise<string[]> {
  const root = workspaceProfilesDir()
  if (!existsSync(root)) return []
  const entries = await readdir(root, { withFileTypes: true })
  const out: string[] = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue
    if (!existsSync(workspaceProfileClaudeDir(e.name))) continue
    out.push(e.name)
  }
  return out.sort()
}
