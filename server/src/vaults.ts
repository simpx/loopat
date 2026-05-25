/**
 * Vault catalog & resolution.
 *
 * A vault is a named bundle of credentials owned by one user. Each loop
 * selects one vault at spawn time. The vault is NOT mounted into the sandbox
 * as a directory; instead, two filesystem conventions drive automatic delivery:
 *
 *   vaults/<v>/envs/<NAME>           → injected as env var $NAME
 *   vaults/<v>/mounts/home/<rel>/... → bound at $HOME/<rel>/...
 *
 * AI sees a configured machine, not a "vault" directory.
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
import { readFile, realpath, readdir, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import {
  personalDir,
  personalVaultDir,
  personalVaultsDir,
  personalVaultEnvsDir,
  personalVaultMountsHomeDir,
} from "./paths"

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

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Load every file in `vaults/<v>/envs/` as an env-var map. Filename is the
 * env var name; content is the value with one trailing newline stripped.
 *
 * Subdirectories under `envs/` are ignored. Files with non-env-var names
 * (e.g. containing dashes or dots) are skipped — they're almost always
 * accidental dotfiles or backup swap files, not real env entries.
 *
 * Missing vault or missing envs/ → empty map.
 */
export async function loadVaultEnvs(user: string, vault: string): Promise<Record<string, string>> {
  const dir = personalVaultEnvsDir(user, vault)
  if (!existsSync(dir)) return {}
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return {}
  }
  const out: Record<string, string> = {}
  for (const name of names) {
    if (!ENV_NAME_RE.test(name)) continue
    let st
    try {
      st = await stat(join(dir, name))
    } catch {
      continue
    }
    if (!st.isFile()) continue
    try {
      const raw = await readFile(join(dir, name), "utf8")
      out[name] = raw.replace(/[\r\n]+$/, "")
    } catch {}
  }
  return out
}

/** A single sandbox bind derived from `vaults/<v>/mounts/home/<top>`. */
export type VaultHomeMount = {
  /** Absolute host path (under the vault dir). */
  src: string
  /** Path relative to sandbox $HOME (e.g. ".ssh", ".config/gh"). */
  rel: string
}

/**
 * Enumerate top-level entries under `vaults/<v>/mounts/home/`. Each one
 * produces a single bind: `<vault>/mounts/home/<name>` → `$HOME/<name>`.
 *
 * Top-level only by design: binding the whole `.ssh/` directory means the
 * sandbox sees vault-owned `.ssh/`, no other writes allowed. Binding individual
 * deeper files would require enumerating and re-running on every spawn — and
 * users almost always want the whole directory owned by the source.
 */
export function listVaultHomeMounts(user: string, vault: string): VaultHomeMount[] {
  const dir = personalVaultMountsHomeDir(user, vault)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir).filter((n) => n && !n.startsWith(".#")).map((name) => ({
      src: join(dir, name),
      rel: name,
    }))
  } catch {
    return []
  }
}
