/**
 * Loopat-managed SSH keypair for the user's personal git repo (deploy key).
 *
 * Lives under `host-secrets/<user>/deploy-key` — OUTSIDE personal/<user>/ so
 * it never enters the sandbox bind view. The user can't see this key from
 * inside their loop. It's loopat-the-platform's clone credential, not a
 * user-owned tool.
 *
 * Public key is rendered to the UI once at register time so the user can
 * register it as a deploy key on their personal git repo (aone / github).
 *
 * Idempotent: if the keypair already exists, returns the existing public key.
 */
import { existsSync } from "node:fs"
import { mkdir, readFile, chmod } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  hostSecretsDir,
  hostDeployKeyPath,
  hostDeployKeyPubPath,
} from "./paths"

const execFileP = promisify(execFile)

/**
 * Generate ed25519 keypair if missing. Tolerant: if `ssh-keygen` is not on
 * PATH (host missing openssh-client) returns `{ publicKey: null }` so the
 * rest of register/provision proceeds — user can install ssh-keygen later
 * and retrigger key gen via /api/personal/import (which calls this again).
 */
export async function ensurePersonalKeypair(userId: string): Promise<{ publicKey: string | null }> {
  const dir = hostSecretsDir(userId)
  const priv = hostDeployKeyPath(userId)
  const pub = hostDeployKeyPubPath(userId)

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
  const pub = hostDeployKeyPubPath(userId)
  if (!existsSync(pub)) return null
  return (await readFile(pub, "utf8")).trim()
}
