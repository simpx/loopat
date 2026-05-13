/**
 * Loopat-managed SSH keypair for the user's personal git repo (deploy key).
 *
 * - Private key lives at `personal/<user>/.loopat/secrets/.ssh/id_ed25519`
 *   (mode 0600). Only that user's sandbox sees it (via the personal bind +
 *   outer-sandbox $HOME/.ssh rebind).
 * - Public key is rendered to the UI once at register time so the user can
 *   register it as a deploy key on their GitHub personal repo.
 *
 * Idempotent: if the keypair already exists, returns the existing public key.
 */
import { existsSync } from "node:fs"
import { mkdir, readFile, chmod } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  personalSshDir,
  personalSshPrivateKeyPath,
  personalSshPublicKeyPath,
} from "./paths"

const execFileP = promisify(execFile)

/**
 * Generate ed25519 keypair if missing. Tolerant: if `ssh-keygen` is not on
 * PATH (host missing openssh-client) returns `{ publicKey: null }` so the
 * rest of register/provision proceeds — user can install ssh-keygen later
 * and retrigger key gen via /api/personal/import (which calls this again).
 */
export async function ensurePersonalKeypair(userId: string): Promise<{ publicKey: string | null }> {
  const dir = personalSshDir(userId)
  const priv = personalSshPrivateKeyPath(userId)
  const pub = personalSshPublicKeyPath(userId)

  await mkdir(dir, { recursive: true })
  await chmod(dir, 0o700).catch(() => {})

  if (!existsSync(priv) || !existsSync(pub)) {
    const comment = `loopat:${userId}`
    try {
      await execFileP("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", comment, "-f", priv, "-q"])
    } catch (e: any) {
      console.warn(`[loopat] ssh-keygen failed for user=${userId}: ${e?.message ?? e}. Install openssh-client to enable deploy-key flow.`)
      return { publicKey: null }
    }
    await chmod(priv, 0o600).catch(() => {})
    await chmod(pub, 0o644).catch(() => {})
  }

  const publicKey = (await readFile(pub, "utf8")).trim()
  return { publicKey }
}

export async function getPublicKey(userId: string): Promise<string | null> {
  const pub = personalSshPublicKeyPath(userId)
  if (!existsSync(pub)) return null
  return (await readFile(pub, "utf8")).trim()
}
