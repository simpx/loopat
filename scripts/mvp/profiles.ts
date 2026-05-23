/**
 * MVP profile resolver.
 *
 * Reads profile.json + sibling CLAUDE.md / knowledge/ from a workspace,
 * computes the active set per user config + CLI flags, returns a
 * materialization PLAN (no side effects). materialize.ts consumes the plan.
 *
 * Not integrated into the server yet — this is the parallel POC track.
 */

import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

/** profile.json on disk — exactly 3 fields, no extends, no inheritance. */
export type ProfileManifest = {
  name: string
  description?: string
  plugins?: string[] // entries of form "name@marketplace" or bare "name"
}

/** personal/<u>/.loopat/config.json on disk. */
export type PersonalConfig = {
  default_profiles?: string[]
  default_vault?: string
  prefs?: Record<string, unknown>
}

export type ResolvePlan = {
  /** Profiles in load order (base first, personal last is added by concat step). */
  profiles: Array<{
    name: string
    dir: string
    manifest: ProfileManifest
    claudeMd?: string // host path to sibling CLAUDE.md if exists
    knowledgeDir?: string // host path to sibling knowledge/ if exists
  }>
  /** Union of plugin specs across all profiles, dedup'd, preserves first occurrence. */
  plugins: string[]
  /** CLAUDE.md ordered list, including personal/<user>/CLAUDE.md at the end if exists. */
  claudeMdChain: Array<{ source: string; path: string }>
  /** Vault selected for this loop (from personal config). */
  vault?: string
  /** Personal user. */
  user: string
}

export type ResolveInput = {
  workspaceDir: string // contains profiles/ and plugins/
  personalDir: string // contains <user>/
  user: string
  cliAdded?: string[]
  cliRemoved?: string[]
  overrideProfiles?: string[] // --profiles=foo,bar overrides everything
}

/** Read and parse one profile.json. Throws if missing/malformed. */
async function readProfile(profileDir: string): Promise<ProfileManifest> {
  const path = join(profileDir, "profile.json")
  const raw = await readFile(path, "utf8")
  const parsed = JSON.parse(raw) as ProfileManifest
  if (!parsed.name) throw new Error(`profile.json missing 'name': ${path}`)
  return parsed
}

/** Read personal config. Returns empty config if file missing. */
async function readPersonalConfig(personalDir: string, user: string): Promise<PersonalConfig> {
  const path = join(personalDir, user, ".loopat", "config.json")
  if (!existsSync(path)) return {}
  const raw = await readFile(path, "utf8")
  return JSON.parse(raw) as PersonalConfig
}

/**
 * Compute the active profile set per the layered rules:
 *   active = (override) OR (base ∪ default_profiles ∪ cliAdded) − cliRemoved
 *
 * `base` is always included (cannot be removed). Profile order: base first,
 * then defaults (in declared order), then CLI-added (in declared order).
 * cliRemoved silently drops names that weren't present.
 */
function computeActiveProfiles(
  cfg: PersonalConfig,
  cliAdded: string[],
  cliRemoved: string[],
  overrideProfiles?: string[],
): string[] {
  if (overrideProfiles && overrideProfiles.length > 0) {
    // override mode still keeps base implicit
    const out = ["base", ...overrideProfiles.filter((p) => p !== "base")]
    return dedupOrdered(out)
  }
  const base = ["base"]
  const defaults = cfg.default_profiles ?? []
  const all = [...base, ...defaults, ...cliAdded]
  const removedSet = new Set(cliRemoved.filter((p) => p !== "base"))
  const filtered = all.filter((p) => !removedSet.has(p))
  return dedupOrdered(filtered)
}

function dedupOrdered<T>(xs: T[]): T[] {
  const seen = new Set<T>()
  const out: T[] = []
  for (const x of xs) {
    if (seen.has(x)) continue
    seen.add(x)
    out.push(x)
  }
  return out
}

/**
 * Main entry: produce a materialization plan from inputs.
 * Pure / no side effects — caller (materialize.ts) executes it.
 */
export async function resolveLoopPlan(input: ResolveInput): Promise<ResolvePlan> {
  const { workspaceDir, personalDir, user, cliAdded = [], cliRemoved = [], overrideProfiles } = input

  const cfg = await readPersonalConfig(personalDir, user)
  const activeNames = computeActiveProfiles(cfg, cliAdded, cliRemoved, overrideProfiles)

  const profilesRoot = join(workspaceDir, "profiles")
  const availableNames = await readdir(profilesRoot).catch(() => [])
  const missing = activeNames.filter((n) => !availableNames.includes(n))
  if (missing.length > 0) {
    throw new Error(`profile(s) not found in ${profilesRoot}: ${missing.join(", ")}`)
  }

  const profiles: ResolvePlan["profiles"] = []
  const plugins: string[] = []
  const claudeMdChain: ResolvePlan["claudeMdChain"] = []

  for (const name of activeNames) {
    const dir = join(profilesRoot, name)
    const manifest = await readProfile(dir)
    const claudeMd = existsSync(join(dir, "CLAUDE.md")) ? join(dir, "CLAUDE.md") : undefined
    const knowledgeDir = existsSync(join(dir, "knowledge")) ? join(dir, "knowledge") : undefined

    profiles.push({ name, dir, manifest, claudeMd, knowledgeDir })

    for (const p of manifest.plugins ?? []) {
      if (!plugins.includes(p)) plugins.push(p)
    }

    if (claudeMd) claudeMdChain.push({ source: name, path: claudeMd })
  }

  // personal/<user>/CLAUDE.md goes last (highest precedence)
  const personalMd = join(personalDir, user, "CLAUDE.md")
  if (existsSync(personalMd)) {
    claudeMdChain.push({ source: `personal:${user}`, path: personalMd })
  }

  return {
    profiles,
    plugins,
    claudeMdChain,
    vault: cfg.default_vault,
    user,
  }
}
