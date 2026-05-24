/**
 * Compose loop's `.claude/` by merging multiple CC-native `.claude/` source
 * dirs (team + active profiles + personal) — post-2026-05 CC-native refactor.
 *
 * Sources (low precedence → high; later wins):
 *   1. team:     knowledge/.loopat/.claude/
 *   2. profile:  knowledge/.loopat/profiles/<name>/.claude/   (per active profile, in order)
 *   3. personal: personal/<user>/CLAUDE.md (file) + personal/.loopat/claude/* (skills/agents)
 *
 * Merge semantics per file:
 *   - settings.json: deep merge; `enabledPlugins` and `extraKnownMarketplaces`
 *     are dict unions across sources; other fields take last-wins
 *   - CLAUDE.md: ordered concat with source markers
 *   - skills/ + agents/: symlink union (entries from later sources shadow same-name)
 *
 * The merged dir at loop/.claude/ is the SDK's CLAUDE_CONFIG_DIR — CC reads
 * CLAUDE.md, skills, agents from there. Plugins are passed to SDK via the
 * `plugins` option (see plugin-installer.ts); cache lookups bypass.
 *
 * Re-run every spawn; idempotent (nuke + remake).
 */
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path"
import { parse as tomlParse, stringify as tomlStringify } from "smol-toml"
import {
  loopClaudeDir,
  personalAgentsDir,
  personalClaudeDir,
  personalClaudeMdPath,
  personalSettingsPath,
  personalSkillsDir,
} from "./paths"
import { resolveLoopPlan, type LoopPlan } from "./profiles"

/** Read JSON, return null if missing/malformed. */
async function readJson<T = unknown>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch {
    return null
  }
}

/** Read TOML, return null if missing/malformed. */
async function readToml<T = Record<string, any>>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null
  try {
    return tomlParse(await readFile(path, "utf8")) as T
  } catch (e: any) {
    console.warn(`[compose] toml malformed at ${path}: ${e?.message ?? e}`)
    return null
  }
}

/**
 * Deep-merge TOML-shaped objects (mise.toml / mise.lock semantics):
 *   - tables (objects): union by key, recursing one level so [tools.node] merges sensibly
 *   - primitives / arrays: last wins
 * Mise's typical tables — [tools], [env], [settings], [hooks], [tasks] — all
 * benefit from key-wise union.
 */
function mergeToml(
  dst: Record<string, any>,
  src: Record<string, any>,
): Record<string, any> {
  const out: Record<string, any> = { ...dst }
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue
    if (
      typeof v === "object" && v !== null && !Array.isArray(v) &&
      typeof out[k] === "object" && out[k] !== null && !Array.isArray(out[k])
    ) {
      // For nested tables (e.g. [tools.node] = { version, checksum }), recurse one level
      const merged: Record<string, any> = { ...out[k] }
      for (const [k2, v2] of Object.entries(v)) {
        if (
          typeof v2 === "object" && v2 !== null && !Array.isArray(v2) &&
          typeof merged[k2] === "object" && merged[k2] !== null && !Array.isArray(merged[k2])
        ) {
          merged[k2] = { ...merged[k2], ...v2 }
        } else {
          merged[k2] = v2
        }
      }
      out[k] = merged
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * Normalize a single extraKnownMarketplaces entry: if its source is
 * `{source: "directory", path: <relative>}`, resolve the path against the
 * settings file's dir so merged loop settings end up with absolute paths.
 * (Loop's merged settings.json is read later by plugin-installer.ts, which
 * doesn't know the original source location.)
 */
function normalizeMarketplaceEntry(entry: any, settingsFilePath: string): any {
  if (!entry || typeof entry !== "object") return entry
  const src = entry.source
  if (typeof src === "object" && src.source === "directory" && typeof src.path === "string") {
    if (!isAbsolute(src.path)) {
      const abs = resolvePath(dirname(settingsFilePath), src.path)
      return { ...entry, source: { ...src, path: abs } }
    }
  }
  return entry
}

/**
 * Deep-merge a source settings.json into the accumulator. `enabledPlugins` +
 * `extraKnownMarketplaces` union by key; other dict fields shallow-union;
 * primitives = last wins. extraKnownMarketplaces paths normalize to absolute.
 *
 * `srcPath` is the source settings file's host path — needed to resolve
 * relative paths in `extraKnownMarketplaces[*].source.path`.
 */
function mergeSettings(
  dst: Record<string, any>,
  src: Record<string, any>,
  srcPath: string,
): Record<string, any> {
  const out: Record<string, any> = { ...dst }
  for (const [k, v] of Object.entries(src)) {
    if (k === "_comment") continue
    if (v === undefined) continue
    if (k === "extraKnownMarketplaces" && typeof v === "object" && v !== null && !Array.isArray(v)) {
      const normalized: Record<string, any> = {}
      for (const [name, entry] of Object.entries(v)) {
        normalized[name] = normalizeMarketplaceEntry(entry, srcPath)
      }
      out[k] = { ...(out[k] ?? {}), ...normalized }
    } else if (
      k === "enabledPlugins" &&
      typeof v === "object" && v !== null && !Array.isArray(v)
    ) {
      out[k] = { ...(out[k] ?? {}), ...v }
    } else if (
      typeof v === "object" && v !== null && !Array.isArray(v) &&
      typeof out[k] === "object" && out[k] !== null && !Array.isArray(out[k])
    ) {
      out[k] = { ...out[k], ...v } // shallow union for other dicts
    } else {
      out[k] = v // primitives / arrays / different types — last wins
    }
  }
  return out
}

/**
 * For each source's `.claude/<subdir>/` (skills or agents), symlink its entries
 * into dst. Later sources shadow earlier (same-name → relink). Missing source
 * dirs silently skipped. Filter restricts to certain file types (e.g. .md for
 * agents). Symlink kind is "dir" for skills (each is a dir), "file" for agents.
 */
async function composeSubdir(
  dst: string,
  sources: Array<{ source: string; rootDir: string }>,
  opts: { kind: "dir" | "file"; filter?: (name: string) => boolean },
): Promise<void> {
  await rm(dst, { recursive: true, force: true })
  await mkdir(dst, { recursive: true })
  for (const src of sources) {
    if (!existsSync(src.rootDir)) continue
    let entries: string[]
    try {
      entries = await readdir(src.rootDir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue
      if (opts.filter && !opts.filter(name)) continue
      const linkPath = join(dst, name)
      await rm(linkPath, { force: true }).catch(() => {})
      await symlink(join(src.rootDir, name), linkPath, opts.kind)
    }
  }
}

/**
 * Resolve where each LoopPlan source has its .claude/-like dirs.
 * For team + profiles, `dir` is the `.claude/` dir itself.
 * For personal (`personal:<u>`), everything lives under `.loopat/.claude/`
 * (mirrors CC's own `~/.claude/` convention but namespaced under `.loopat/`):
 * `CLAUDE.md`, `settings.json`, `skills/`, `agents/`, `mise.toml`, etc.
 */
type ResolvedSource = {
  source: string
  settings?: string
  claudeMd?: string
  skillsDir?: string
  agentsDir?: string
  miseToml?: string
  miseLock?: string
  /** `.claude/plugins/installed_plugins.json` — CC-native plugin version lock.
   *  Same shape as host's. We merge across tiers by spec key (last-wins). */
  installedPlugins?: string
}

function resolveSource(s: { source: string; dir: string }, user: string): ResolvedSource {
  if (s.source.startsWith("personal:")) {
    // Personal layer uses the CC-native `.claude/` shape — same as team / profile.
    return {
      source: s.source,
      settings: personalSettingsPath(user),
      claudeMd: personalClaudeMdPath(user),
      skillsDir: personalSkillsDir(user),
      agentsDir: personalAgentsDir(user),
      miseToml: join(personalClaudeDir(user), "mise.toml"),
      miseLock: join(personalClaudeDir(user), "mise.lock"),
      installedPlugins: join(personalClaudeDir(user), "plugins", "installed_plugins.json"),
    }
  }
  // team / profile / repo — dir IS the .claude/ dir
  return {
    source: s.source,
    settings: join(s.dir, "settings.json"),
    claudeMd: join(s.dir, "CLAUDE.md"),
    skillsDir: join(s.dir, "skills"),
    agentsDir: join(s.dir, "agents"),
    miseToml: join(s.dir, "mise.toml"),
    miseLock: join(s.dir, "mise.lock"),
    installedPlugins: join(s.dir, "plugins", "installed_plugins.json"),
  }
}

export type ComposeResult = {
  claudeMdPath: string
  settingsPath: string
  sources: string[]
  enabledPlugins: string[] // for callers (plugin-installer) to drive install
  extraMarketplaces: string[]
  /** Path to merged mise.toml in loop's .claude/, or null if no source declared toolchain. */
  miseTomlPath: string | null
  /** Path to merged mise.lock in loop's .claude/, or null if no source declared lock. */
  miseLockPath: string | null
  /** Path to merged installed_plugins.json in loop's .claude/plugins/, or null if no tier declared one. */
  installedPluginsPath: string | null
}

/**
 * Compose loop .claude/ from the loop's plan. Runs ONCE at loop creation;
 * the snapshot is then immutable so subsequent admin pushes to knowledge
 * don't change what an existing loop sees (principle 1: loops never change).
 *
 * Workdir is NOT a tier here — it's read by the SDK as project tier directly
 * (settingSources includes 'project'). Compose only merges the user-tier
 * sources: workspace + N profiles + personal.
 *
 * Returns paths for downstream use (plugin-installer reads merged settings;
 * spawn reads CLAUDE_CONFIG_DIR).
 */
export async function composeLoopClaudeConfig(
  loopId: string,
  user: string,
  profiles?: string[],
): Promise<ComposeResult> {
  const plan: LoopPlan = await resolveLoopPlan({
    user,
    overrideProfiles: profiles,
  })
  return composeFromPlan(loopId, plan)
}

export async function composeFromPlan(loopId: string, plan: LoopPlan): Promise<ComposeResult> {
  const dst = loopClaudeDir(loopId)
  await mkdir(dst, { recursive: true })

  const resolved = plan.claudeSources.map((s) => resolveSource(s, plan.user))

  // 1. Merge settings.json
  let mergedSettings: Record<string, any> = {}
  for (const r of resolved) {
    if (!r.settings) continue
    const obj = await readJson<Record<string, any>>(r.settings)
    if (obj) mergedSettings = mergeSettings(mergedSettings, obj, r.settings)
  }
  const settingsPath = join(dst, "settings.json")
  // Inject loopat-managed fields that downstream code expects.
  mergedSettings.autoMemoryEnabled = mergedSettings.autoMemoryEnabled ?? true
  mergedSettings.autoMemoryDirectory =
    mergedSettings.autoMemoryDirectory ?? "/loopat/context/personal/memory"
  await writeFile(settingsPath, JSON.stringify(mergedSettings, null, 2))

  // 2. Concat CLAUDE.md
  const claudeMdPath = join(dst, "CLAUDE.md")
  const parts: string[] = []
  for (const r of resolved) {
    if (!r.claudeMd || !existsSync(r.claudeMd)) continue
    try {
      const content = (await readFile(r.claudeMd, "utf8")).trim()
      parts.push(
        `<!-- ========== ${r.source} ========== -->\n<!-- from: ${r.claudeMd} -->\n${content}`,
      )
    } catch (e: any) {
      console.warn(`[compose] ${r.source} CLAUDE.md unreadable: ${e?.message ?? e}`)
    }
  }
  if (parts.length === 0) {
    await rm(claudeMdPath, { force: true })
  } else {
    await writeFile(claudeMdPath, parts.join("\n\n") + "\n")
  }

  // 3. Symlink-merge skills/ (each entry is a dir with SKILL.md)
  await composeSubdir(
    join(dst, "skills"),
    resolved.filter((r) => r.skillsDir).map((r) => ({ source: r.source, rootDir: r.skillsDir! })),
    { kind: "dir" },
  )

  // 4. Symlink-merge agents/ (each entry is a single .md file)
  await composeSubdir(
    join(dst, "agents"),
    resolved.filter((r) => r.agentsDir).map((r) => ({ source: r.source, rootDir: r.agentsDir! })),
    { kind: "file", filter: (n) => n.endsWith(".md") },
  )

  // 5. Merge mise.toml + mise.lock (toolchain layer, loopat-native extension to .claude/)
  let mergedMiseToml: Record<string, any> = {}
  let anyMiseToml = false
  for (const r of resolved) {
    if (!r.miseToml) continue
    const obj = await readToml<Record<string, any>>(r.miseToml)
    if (obj) {
      mergedMiseToml = mergeToml(mergedMiseToml, obj)
      anyMiseToml = true
    }
  }
  let miseTomlPath: string | null = null
  if (anyMiseToml) {
    miseTomlPath = join(dst, "mise.toml")
    await writeFile(miseTomlPath, tomlStringify(mergedMiseToml))
  } else {
    await rm(join(dst, "mise.toml"), { force: true })
  }

  let mergedMiseLock: Record<string, any> = {}
  let anyMiseLock = false
  for (const r of resolved) {
    if (!r.miseLock) continue
    const obj = await readToml<Record<string, any>>(r.miseLock)
    if (obj) {
      mergedMiseLock = mergeToml(mergedMiseLock, obj)
      anyMiseLock = true
    }
  }
  let miseLockPath: string | null = null
  if (anyMiseLock) {
    miseLockPath = join(dst, "mise.lock")
    await writeFile(miseLockPath, tomlStringify(mergedMiseLock))
  } else {
    await rm(join(dst, "mise.lock"), { force: true })
  }

  // 6. Merge installed_plugins.json (CC-native plugin version lock).
  //
  // Each tier may publish a .claude/plugins/installed_plugins.json with the
  // same shape CC writes to ~/.claude/plugins/. We union by spec key,
  // last-wins (personal overrides team). The merged file is the loop's lock —
  // bwrap binds it over the sandbox's ~/.claude/plugins/installed_plugins.json
  // so the inner SDK resolves each plugin to the pinned version, not whatever
  // happens to be on the host right now.
  //
  // Why include this at all: without a per-loop snapshot, member's
  // `claude plugin update` on host would silently change what a previously-
  // created loop sees on next spawn. Locking via this file freezes the loop's
  // plugin set at creation time (principle 1).
  let mergedInstalledPlugins: { version?: number; plugins?: Record<string, any[]> } | null = null
  for (const r of resolved) {
    if (!r.installedPlugins) continue
    const obj = await readJson<{ version?: number; plugins?: Record<string, any[]> }>(
      r.installedPlugins,
    )
    if (!obj) continue
    if (!mergedInstalledPlugins) {
      mergedInstalledPlugins = { version: obj.version ?? 1, plugins: {} }
    }
    for (const [spec, entries] of Object.entries(obj.plugins ?? {})) {
      mergedInstalledPlugins.plugins![spec] = entries // per-spec last-wins
    }
  }
  let installedPluginsPath: string | null = null
  if (mergedInstalledPlugins) {
    const ipDir = join(dst, "plugins")
    await mkdir(ipDir, { recursive: true })
    installedPluginsPath = join(ipDir, "installed_plugins.json")
    await writeFile(installedPluginsPath, JSON.stringify(mergedInstalledPlugins, null, 2))
  } else {
    // No tier declared a lock → ensure no stale lock from a previous compose
    await rm(join(dst, "plugins", "installed_plugins.json"), { force: true })
  }

  const enabledPlugins = Object.keys(
    (mergedSettings.enabledPlugins ?? {}) as Record<string, boolean>,
  ).filter((k) => mergedSettings.enabledPlugins[k])

  const extraMarketplaces = Object.keys(
    (mergedSettings.extraKnownMarketplaces ?? {}) as Record<string, unknown>,
  )

  return {
    claudeMdPath,
    settingsPath,
    sources: resolved.map((r) => r.source),
    enabledPlugins,
    extraMarketplaces,
    miseTomlPath,
    miseLockPath,
    installedPluginsPath,
  }
}

/**
 * Write settings.json under the loop's .claude/. DEPRECATED in the CC-native
 * model — settings are written by composeFromPlan. Kept as a no-op for
 * backward-compat callers (loops.ts). Use composeLoopClaudeConfig instead.
 */
export async function writeLoopSettings(_loopId: string): Promise<void> {
  // no-op
}
