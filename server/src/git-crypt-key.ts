/**
 * Per-user git-crypt symmetric key. Decrypts the user's personal repo
 * worktree (specifically `.loopat/vaults/**`).
 *
 * Storage: host-secrets/<user>/git-crypt.key — host-only, NOT bound into the
 * sandbox, NOT in any git repo. Mode 0600.
 *
 * Phase A (now): plain file on disk. Anyone with host access can read it and
 * decrypt the repo. Trade-off documented — see design discussion notes.
 *
 * Phase B (future, optional upgrade): replace this module's read path with an
 * in-memory map populated at server start via passphrase prompt. Callers stay
 * the same — `getGitCryptKey(userId)` interface is the migration boundary.
 */
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises"
import { dirname } from "node:path"
import { hostSecretsDir, personalGitCryptKeyPath } from "./paths"

export async function getGitCryptKey(userId: string): Promise<Buffer> {
  return await readFile(personalGitCryptKeyPath(userId))
}

export async function gitCryptKeyExists(userId: string): Promise<boolean> {
  return existsSync(personalGitCryptKeyPath(userId))
}

export async function saveGitCryptKey(userId: string, keyData: Buffer): Promise<void> {
  const dir = hostSecretsDir(userId)
  await mkdir(dir, { recursive: true })
  await chmod(dir, 0o700).catch(() => {})
  const path = personalGitCryptKeyPath(userId)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, keyData, { mode: 0o600 })
  await chmod(path, 0o600).catch(() => {})
}
