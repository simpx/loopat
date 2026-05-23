/**
 * Compose multi-tier Claude Code config (skills + agents) into each loop's
 * private .claude/ dir.
 *
 * Tiers (low → high precedence; later writes shadow earlier):
 *   - workspace (admin-pushed into knowledge/.loopat/)
 *   - personal  (per-user under personal/<user>/.loopat/)
 *
 * Plugins are NOT composed here. The Agent SDK loads plugins via its
 * `plugins` option (one `--plugin-dir <path>` per entry); the resolver
 * lives in plugin-installer.ts and points at server-side cache paths.
 * Skills here are CC's loose user-tier skills (flat directory), not the
 * namespaced plugin-internal skills.
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
  loopClaudeDir,
  loopComposedAgentsDir,
  loopComposedSkillsDir,
  personalLoopatAgentsDir,
  personalLoopatSkillsDir,
  workspaceLoopatAgentsDir,
  workspaceLoopatSkillsDir,
} from "./paths"

type Tier = {
  /** Host-side directory that contains entries (one per skill/plugin/agent). */
  rootHostPath: string
  /** Sandbox-internal path the symlinks should point at. */
  virtualPath: string
}

type ComposeOpts = {
  /** Symlink kind passed to fs.symlink. Skills/plugins are directories; agents
   *  are single .md files. Pick the wrong kind and the symlink may still work
   *  on Linux but is wrong on Windows / for tooling that reads the type. */
  kind: "dir" | "file"
  /** Optional predicate — only entries returning true are linked. Used for
   *  agents (`.md` only) to skip stray junk. */
  filter?: (name: string) => boolean
}

/**
 * Compose multiple tier dirs into `dst`. Lower-priority tiers symlink first;
 * higher-priority tiers overwrite same-named entries. Final layout: `dst/<name>`
 * symlinks to `<tier.virtualPath>/<name>` for every entry across all tiers.
 *
 * Missing tier dirs are silently skipped.
 */
async function composeTier(dst: string, tiers: Tier[], opts: ComposeOpts = { kind: "dir" }): Promise<string[]> {
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
      // Skip dotfiles — `.gitkeep` etc. shouldn't appear as a skill/plugin/agent.
      if (name.startsWith(".")) continue
      if (opts.filter && !opts.filter(name)) continue
      const linkPath = join(dst, name)
      // Higher tier wins: rm any existing symlink before relinking.
      await rm(linkPath, { force: true }).catch(() => {})
      await symlink(`${virtualPath}/${name}`, linkPath, opts.kind)
      if (!names.includes(name)) names.push(name)
    }
  }
  return names
}

/**
 * Compose skills + agents into a given loop's .claude/. Run on every spawn.
 * Plugins are handled separately by plugin-installer.ts (resolved at spawn
 * and passed to the SDK via its `plugins` option).
 */
export async function composeLoopClaudeConfig(
  loopId: string,
  user: string,
): Promise<void> {
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

  // Agents tier — single .md files per agent (CC subagent convention).
  // CC scans $CLAUDE_CONFIG_DIR/agents/ and registers each as a delegatable
  // subagent. Same workspace + personal tiering as skills.
  await composeTier(
    loopComposedAgentsDir(loopId),
    [
      {
        rootHostPath: workspaceLoopatAgentsDir(),
        virtualPath: "/loopat/context/knowledge/.loopat/claude/agents",
      },
      {
        rootHostPath: personalLoopatAgentsDir(user),
        virtualPath: "/loopat/context/personal/.loopat/claude/agents",
      },
    ],
    { kind: "file", filter: (name) => name.endsWith(".md") },
  )
}

/**
 * Write settings.json under the loop's .claude/. Merges with existing fields
 * (auto-memory + anything CC itself may have written) so we don't clobber.
 */
export async function writeLoopSettings(loopId: string): Promise<void> {
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
  }
  await writeFile(path, JSON.stringify(merged, null, 2))
}
