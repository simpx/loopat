/**
 * MVP vault env loader.
 *
 * A vault is `personal/<user>/vaults/<vault-name>/` — flat directory of files
 * where **filename is the env var name** and **file content is the value**.
 * (The real loopat vaults.ts adds git-crypt + path-escape protection; MVP
 * keeps it minimal but follows the same naming convention.)
 *
 *   personal/alice/vaults/dev/INTERNAL_API_TOKEN  ← env "INTERNAL_API_TOKEN"
 *   personal/alice/vaults/dev/PAGERDUTY_TOKEN     ← env "PAGERDUTY_TOKEN"
 *
 * Files starting with `.` (.env.example, .gitignore) are ignored.
 * Filenames not matching `[A-Z_][A-Z0-9_]*` are skipped with a warning.
 */

import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/

export type VaultEnv = {
  /** Resolved env map ready to spread into process.env or child_process.spawn opts. */
  env: Record<string, string>
  /** Where the vault was read from (for debugging). null if not found. */
  source: string | null
  /** Names of files skipped due to invalid env var naming. */
  skipped: string[]
}

/**
 * Load all files under `personal/<user>/vaults/<vault>/` into an env map.
 * Returns empty env (not error) if the vault dir doesn't exist —
 * lets MVP run against samples without enforced vaults.
 */
export async function loadVaultEnv(
  personalDir: string,
  user: string,
  vault: string | undefined,
): Promise<VaultEnv> {
  if (!vault) return { env: {}, source: null, skipped: [] }
  const dir = join(personalDir, user, "vaults", vault)
  if (!existsSync(dir)) return { env: {}, source: null, skipped: [] }

  const env: Record<string, string> = {}
  const skipped: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const ent of entries) {
    if (!ent.isFile()) continue
    if (ent.name.startsWith(".")) continue // .env.example, .gitignore, etc.
    if (!ENV_NAME_RE.test(ent.name)) {
      skipped.push(ent.name)
      continue
    }
    const val = (await readFile(join(dir, ent.name), "utf8")).replace(/\n$/, "")
    env[ent.name] = val
  }
  return { env, source: dir, skipped }
}
