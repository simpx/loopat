/**
 * Compose multi-tier Claude Code config (skills + plugins) into each loop's
 * private .claude/ dir.
 *
 * Tiers (low → high precedence; later writes shadow earlier):
 *   - builtin   (ships in `server/templates/`)
 *   - workspace (admin-pushed into knowledge/.loopat/)
 *   - personal  (per-user under personal/<user>/.loopat/)
 *
 * Two compose surfaces:
 *
 *   1. Skills → `loops/<id>/.claude/skills/`
 *      Composed from workspace + personal (no builtin loose-skill tier — builtin
 *      ships as a plugin so it gets natural `loopat:*` namespacing).
 *      Bound into the sandbox at $CLAUDE_CONFIG_DIR/skills/ via the loop's
 *      .claude/ rw-bind. CC scans the dir as user-tier skills.
 *
 *   2. Plugins → `loops/<id>/.claude/plugins/cache/`
 *      Composed from builtin + workspace + personal.
 *      CC is told to look here via `--plugin-dir` flag at spawn time (see
 *      session.ts). The plugin manifest's `name` is the namespace prefix in
 *      the `/<plugin>:<skill>` invocation syntax.
 *
 * Symlinks point at **sandbox virtual paths**, not host paths. Inside the
 * sandbox, virtual paths resolve to the bound directories; host-side `ls`
 * shows broken symlinks but that's irrelevant — only CC inside the sandbox
 * follows them.
 *
 * Each compose is idempotent: nuke + remake. Called on every spawn so skills
 * added to knowledge/personal mid-session show up at next session start.
 */
import { existsSync } from "node:fs"
import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  LOOPAT_INSTALL_DIR,
  builtinPluginsDir,
  loopClaudeDir,
  loopComposedPluginsCacheDir,
  loopComposedSkillsDir,
  personalLoopatPluginsDir,
  personalLoopatSkillsDir,
  workspaceLoopatPluginsDir,
  workspaceLoopatSkillsDir,
} from "./paths"

type Tier = {
  /** Host-side directory that contains subdirs (one per skill/plugin). */
  rootHostPath: string
  /** Sandbox-internal path the symlinks should point at. */
  virtualPath: string
}

/**
 * Compose multiple tier dirs into `dst`. Lower-priority tiers symlink first;
 * higher-priority tiers overwrite same-named entries. Final layout: `dst/<name>`
 * symlinks to `<tier.virtualPath>/<name>` for every entry across all tiers.
 *
 * Missing tier dirs are silently skipped.
 */
async function composeTier(dst: string, tiers: Tier[]): Promise<string[]> {
  await rm(dst, { recursive: true, force: true })
  await mkdir(dst, { recursive: true })
  const names: string[] = []
  for (const { rootHostPath, virtualPath } of tiers) {
    if (!existsSync(rootHostPath)) continue
    let entries: string[]
    try {
      entries = await readdir(rootHostPath)
    } catch {
      continue
    }
    for (const name of entries) {
      // Skip dotfiles — `.gitkeep` etc. shouldn't appear as a skill/plugin.
      if (name.startsWith(".")) continue
      const linkPath = join(dst, name)
      // Higher tier wins: rm any existing symlink before relinking.
      await rm(linkPath, { force: true }).catch(() => {})
      await symlink(`${virtualPath}/${name}`, linkPath, "dir")
      if (!names.includes(name)) names.push(name)
    }
  }
  return names
}

/**
 * Compose all Claude config artifacts for a given loop. Run on every spawn.
 *
 * Returns the list of enabled plugin names so the caller can write them into
 * `settings.json` for CC's `enabledPlugins` field.
 */
export async function composeLoopClaudeConfig(
  loopId: string,
  user: string,
): Promise<{ enabledPlugins: string[] }> {
  // Ensure the loop's .claude/ exists (caller may have already done this).
  await mkdir(loopClaudeDir(loopId), { recursive: true })

  // Skills tier — flat namespace, user-tier slot in CC.
  // Virtual paths must match where bwrap binds knowledge / personal.
  await composeTier(loopComposedSkillsDir(loopId), [
    {
      rootHostPath: workspaceLoopatSkillsDir(),
      virtualPath: "/loopat/context/knowledge/.loopat/claude/skills",
    },
    {
      rootHostPath: personalLoopatSkillsDir(user),
      virtualPath: "/loopat/context/personal/.loopat/claude/skills",
    },
  ])

  // Plugins tier — namespaced by plugin.name in each manifest.
  // builtin is bound same-to-same via LOOPAT_INSTALL_DIR, so its virtual path
  // equals its host path.
  const enabledPlugins = await composeTier(loopComposedPluginsCacheDir(loopId), [
    {
      rootHostPath: builtinPluginsDir(),
      virtualPath: join(LOOPAT_INSTALL_DIR, "server", "templates", "plugins"),
    },
    {
      rootHostPath: workspaceLoopatPluginsDir(),
      virtualPath: "/loopat/context/knowledge/.loopat/plugins",
    },
    {
      rootHostPath: personalLoopatPluginsDir(user),
      virtualPath: "/loopat/context/personal/.loopat/plugins",
    },
  ])

  return { enabledPlugins }
}

/**
 * Write settings.json under the loop's .claude/. Merges with existing fields
 * (auto-memory etc.) so we don't clobber other writers.
 *
 * Called after composeLoopClaudeConfig so enabledPlugins is fresh.
 */
export async function writeLoopSettings(
  loopId: string,
  enabledPlugins: string[],
): Promise<void> {
  const path = join(loopClaudeDir(loopId), "settings.json")
  let existing: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      const { readFile } = await import("node:fs/promises")
      existing = JSON.parse(await readFile(path, "utf8"))
    } catch {}
  }
  const merged = {
    autoMemoryEnabled: true,
    autoMemoryDirectory: "/loopat/context/personal/memory",
    ...existing,
    enabledPlugins,
  }
  await writeFile(path, JSON.stringify(merged, null, 2))
}
