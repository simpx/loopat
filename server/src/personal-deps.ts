import { readdir, lstat, realpath } from "node:fs/promises"
import { join } from "node:path"
import { personalDir, ME } from "./paths"

/**
 * Recursively walk personal/<user>/ for symlinks and return resolved targets.
 * These targets are added to sandbox allowRead/allowWrite — i.e., the
 * mechanism that lets a loop see external files (ssh keys, tool configs).
 *
 * Walks recursively so symlinks under e.g. personal/<user>/secrets/.ssh are
 * also picked up.
 *
 * See memory: project_loop_dir_is_sandbox.md
 */
export async function resolvePersonalDeps(): Promise<string[]> {
  const root = personalDir(ME)
  const out: string[] = []

  async function walk(dir: string): Promise<void> {
    let entries: string[] = []
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      let st
      try {
        st = await lstat(full)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) {
        try {
          const target = await realpath(full)
          out.push(target)
        } catch {
          // broken symlink — skip
        }
        // don't recurse INTO the symlinked dir; the resolved target covers it
      } else if (st.isDirectory()) {
        await walk(full)
      }
      // regular files: not deps, ignore
    }
  }

  await walk(root)
  return out
}
