/**
 * Vault catalog & resolution.
 *
 * A vault is a named bundle of credentials owned by one user. Each loop
 * selects one vault at spawn time and gets a sandbox-side symlink at
 * `/loopat/context/vault` pointing to that vault's real dir under
 * `/loopat/context/personal/.loopat/vaults/<active>/`. AI is taught (via
 * doctrine) to use the symlink and ignore other vaults visible under
 * `personal/.loopat/vaults/`.
 *
 * Filesystem:
 *   personal/<user>/.loopat/vaults/<name>/...
 *
 * Symlinks within a vault are allowed and follow Linux semantics, BUT
 * `walkVaultFiles` rejects any file whose realpath escapes
 * `personal/<user>/` — symlinks pointing at host paths outside the user's
 * own tree are a privilege-escalation vector and never bind into the sandbox.
 */
import { existsSync, readdirSync, statSync } from "node:fs"
import { realpath, readdir, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { personalDir, personalVaultDir, personalVaultsDir } from "./paths"

export const DEFAULT_VAULT = "default"

const VAULT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
export function isValidVaultName(name: string): boolean {
  return VAULT_NAME_RE.test(name)
}

/** List vault names: subdirectories under `personal/<user>/.loopat/vaults/`. */
export function listVaults(user: string): string[] {
  const vaultsDir = personalVaultsDir(user)
  if (!existsSync(vaultsDir)) return []
  try {
    return readdirSync(vaultsDir)
      .filter((name) => isValidVaultName(name))
      .filter((name) => {
        try {
          return statSync(join(vaultsDir, name)).isDirectory()
        } catch {
          return false
        }
      })
      .sort()
  } catch {
    return []
  }
}

/**
 * Return the host-side root directory for the named vault, or null if it
 * doesn't exist on disk.
 */
export function resolveVaultRoot(user: string, vault: string): string | null {
  if (!isValidVaultName(vault)) return null
  const path = personalVaultDir(user, vault)
  return existsSync(path) ? path : null
}

/**
 * Walk a vault root and yield (relPath, realpath) pairs for every regular
 * file (following symlinks). Rejects symlinks whose realpath escapes
 * `personal/<user>/` — these are dropped (caller can log) instead of
 * silently exposing a host path.
 */
export async function* walkVaultFiles(
  user: string,
  vaultRoot: string,
): AsyncGenerator<{ rel: string; realpath: string }> {
  const userRoot = personalDir(user)
  const userRootReal = await realpath(userRoot).catch(() => userRoot)

  async function* visit(dir: string, prefix: string): AsyncGenerator<{ rel: string; realpath: string }> {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const abs = join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      let st
      try {
        st = await stat(abs) // follows symlinks
      } catch {
        continue
      }
      if (st.isDirectory()) {
        yield* visit(abs, rel)
        continue
      }
      if (!st.isFile()) continue
      let resolved: string
      try {
        resolved = await realpath(abs)
      } catch {
        continue
      }
      const insideUser = relative(userRootReal, resolved)
      if (insideUser.startsWith("..") || insideUser === "" || insideUser.startsWith(`/${sep}`)) {
        // realpath escaped personal/<user>/ — refuse to bind
        console.warn(`[loopat] vault symlink rejected (escapes user root): ${abs} → ${resolved}`)
        continue
      }
      yield { rel, realpath: resolved }
    }
  }

  yield* visit(vaultRoot, "")
}
