import { readdir, lstat, realpath } from "node:fs/promises"
import { join } from "node:path"
import { personalDir, ME } from "./paths"

/**
 * Walk personal/<user>/ for symlinks and return resolved targets.
 * These targets are added to sandbox allowRead/allowWrite — i.e., the
 * mechanism that lets a loop see external files (ssh keys, tool configs).
 *
 * See memory: project_loop_dir_is_sandbox.md
 */
export async function resolvePersonalDeps(): Promise<string[]> {
  const dir = personalDir(ME)
  const out: string[] = []
  let entries: string[] = []
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  for (const name of entries) {
    const full = join(dir, name)
    try {
      const st = await lstat(full)
      if (!st.isSymbolicLink()) continue
      const target = await realpath(full)
      out.push(target)
    } catch {
      // broken symlink / permission denied — skip
    }
  }
  return out
}
