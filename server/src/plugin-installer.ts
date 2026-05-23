/**
 * Resolve which plugins a loop should run with — read straight from the
 * loop's chosen sandbox dir, then add platform-shipped builtins. Output
 * goes into the Agent SDK's `plugins: [{type:'local', path:...}]` option
 * (one --plugin-dir per entry on the spawned CC).
 *
 * Architecture:
 *
 *   Per sandbox under knowledge/.loopat/sandboxes/<name>/:
 *     .claude/                            ← admin uses `claude plugin install`
 *       settings.json                      to populate; CC writes all this
 *       .claude.json                       natively. .gitignore drops the
 *       plugins/
 *         installed_plugins.json           cache/ + marketplaces/ (per-server
 *         known_marketplaces.json           state, not committable).
 *         cache/<m>/<p>/<v>/               ← actual plugin files
 *         marketplaces/<m>/                ← marketplace clones
 *     mise.toml / mise.lock / sandbox.json / CLAUDE.md  ← team-shared
 *
 *   Loopat reads `installed_plugins.json` and forwards each entry's
 *   `installPath` to the SDK. No marketplace logic, no install logic —
 *   CC does all that, loopat just enumerates the result.
 *
 *   The builtin `loopat` plugin (server/templates/plugins/loopat/) is
 *   platform-shipped and always included regardless of sandbox.
 */
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { TEMPLATES_DIR, workspaceLoopatSandboxDir } from "./paths"
import { resolveSandboxChain } from "./sandboxes"

export type ResolvedLoopPlugin = {
  /** Display name (`plugin@marketplace` or just `plugin` for builtins). */
  name: string
  /** Host path to plugin root (contains .claude-plugin/plugin.json). Must be
   *  sandbox-visible via existing bwrap binds (LOOPAT_INSTALL_DIR for
   *  builtins; knowledge bind for sandbox-installed plugins). */
  path: string
}

/** Platform-shipped plugins. Always loaded into every loop. */
function resolveBuiltinPlugins(): ResolvedLoopPlugin[] {
  return [
    { name: "loopat@builtin", path: join(TEMPLATES_DIR, "plugins", "loopat") },
  ]
}

type InstalledPluginsFile = {
  version: number
  plugins: Record<string, Array<{ installPath: string; version: string }>>
}

/** Read ONE sandbox's installed_plugins.json (no chain walking). */
async function readSandboxOwnPlugins(sandboxName: string): Promise<ResolvedLoopPlugin[]> {
  const path = join(workspaceLoopatSandboxDir(sandboxName), ".claude", "plugins", "installed_plugins.json")
  if (!existsSync(path)) return []
  let data: InstalledPluginsFile
  try {
    data = JSON.parse(await readFile(path, "utf8"))
  } catch (e: any) {
    console.warn(`[plugins] sandbox "${sandboxName}" installed_plugins.json unreadable: ${e?.message ?? e}`)
    return []
  }
  const out: ResolvedLoopPlugin[] = []
  for (const [key, entries] of Object.entries(data.plugins ?? {})) {
    const entry = entries?.[0]
    if (!entry?.installPath) continue
    if (!existsSync(entry.installPath)) {
      console.warn(`[plugins] sandbox "${sandboxName}" plugin "${key}": installPath missing (${entry.installPath})`)
      continue
    }
    out.push({ name: key, path: entry.installPath })
  }
  return out
}

/**
 * Walk the sandbox's extends chain (oldest ancestor first) and merge plugins
 * by `name@market` key — child entries shadow parent entries naturally.
 */
async function resolveSandboxPlugins(sandboxName: string): Promise<ResolvedLoopPlugin[]> {
  const chain = await resolveSandboxChain(sandboxName)
  const merged = new Map<string, ResolvedLoopPlugin>()
  for (const name of chain) {
    for (const p of await readSandboxOwnPlugins(name)) {
      merged.set(p.name, p) // later in chain (closer to leaf) wins
    }
  }
  return [...merged.values()]
}

/**
 * Main entry — called at loop spawn. Always returns builtins; adds the
 * sandbox's plugins on top if a sandbox is selected.
 */
export async function resolveLoopPlugins(sandboxName: string | undefined): Promise<ResolvedLoopPlugin[]> {
  return [
    ...resolveBuiltinPlugins(),
    ...(sandboxName ? await resolveSandboxPlugins(sandboxName) : []),
  ]
}
