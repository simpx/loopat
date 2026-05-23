/**
 * MVP claude spawner.
 *
 * Launches CC against a materialized loop dir, with vault env injected.
 * Two modes:
 *
 *   1. direct   — `claude` runs with cwd=loopDir, env=process.env+vault
 *                 (no isolation; demonstrates the env injection working)
 *
 *   2. bwrap    — wraps claude in bubblewrap with minimal mounts:
 *                   /loopat/loop          ← loopDir (rw)
 *                   /loopat/knowledge     ← workspace/knowledge (ro)
 *                   /loopat/vault         ← personal/<u>/vaults/<v> (ro)
 *                 Real production bwrap (server/src/bwrap.ts) is 538 lines
 *                 of careful mount logic — this is a minimal demonstration,
 *                 not feature-parity.
 *
 * Exits with the same status as claude.
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

export type SpawnOpts = {
  loopDir: string
  /** Workspace dir for bwrap to mount knowledge from. */
  workspaceDir: string
  /** Personal vault dir to bind into bwrap (already resolved to vault subdir). */
  vaultDir?: string | null
  /** Vault env vars to inject. */
  vaultEnv: Record<string, string>
  /** Wrap claude in bubblewrap with restricted view. */
  useBwrap?: boolean
  /** Extra args to pass to claude. */
  claudeArgs?: string[]
}

/**
 * Spawn claude in the chosen mode. Returns claude's exit code (or 130 for SIGINT).
 * stdin/stdout/stderr are inherited — interactive.
 */
export async function spawnClaude(opts: SpawnOpts): Promise<number> {
  const { useBwrap, claudeArgs = [] } = opts

  const env = {
    ...process.env,
    ...opts.vaultEnv,
  }

  if (useBwrap) {
    return spawnWithBwrap(opts, env, claudeArgs)
  }
  return spawnDirect(opts, env, claudeArgs)
}

function spawnDirect(
  opts: SpawnOpts,
  env: NodeJS.ProcessEnv,
  claudeArgs: string[],
): Promise<number> {
  console.log(`[spawn:direct] claude cwd=${opts.loopDir}`)
  return new Promise((resolve) => {
    const child = spawn("claude", claudeArgs, {
      cwd: opts.loopDir,
      env,
      stdio: "inherit",
    })
    child.on("exit", (code, sig) => resolve(code ?? (sig ? 130 : 1)))
  })
}

/**
 * Build minimal bwrap argv:
 *   bwrap \
 *     --ro-bind / /                       (whole rootfs ro)
 *     --tmpfs /tmp                        (writable tmp)
 *     --proc /proc
 *     --dev /dev
 *     --bind <loopDir> /loopat/loop       (loop dir rw)
 *     --ro-bind <ws>/knowledge /loopat/knowledge
 *     --ro-bind <vaultDir> /loopat/vault   (if vault set)
 *     --bind /home/$USER/.claude /home/$USER/.claude   (CC needs to find installed plugins)
 *     --chdir /loopat/loop
 *     claude ...
 */
function spawnWithBwrap(
  opts: SpawnOpts,
  env: NodeJS.ProcessEnv,
  claudeArgs: string[],
): Promise<number> {
  // Per-component ro-binds rather than `--ro-bind / /` — a fully-ro root would
  // prevent bwrap from mkdir'ing /loopat/ for our subsequent binds. (Same
  // pattern as production server/src/bwrap.ts.)
  const SYSTEM_RO = ["/usr", "/lib", "/lib64", "/lib32", "/bin", "/sbin", "/etc", "/opt", "/var"]
  const args: string[] = []
  for (const p of SYSTEM_RO) args.push("--ro-bind-try", p, p)
  args.push(
    "--proc", "/proc",
    "--dev", "/dev",
    "--bind", "/tmp", "/tmp",
    "--bind", opts.loopDir, "/loopat/loop",
  )

  // CC's plugins + auth live under $HOME/.claude; bind that mutable
  if (env.HOME) {
    args.push("--bind", join(env.HOME, ".claude"), join(env.HOME, ".claude"))
    // /etc/passwd lookups need $HOME to exist for the user — overlay as tmpfs
    // first so other things in $HOME aren't visible, then bind .claude into it.
    // Simplification: just bind whole $HOME (lower isolation, simpler MVP).
    args.push("--bind", env.HOME, env.HOME)
  }

  const knowledgeSrc = join(opts.workspaceDir, "knowledge")
  if (existsSync(knowledgeSrc)) {
    args.push("--ro-bind", knowledgeSrc, "/loopat/knowledge")
  }

  if (opts.vaultDir && existsSync(opts.vaultDir)) {
    args.push("--ro-bind", opts.vaultDir, "/loopat/vault")
  }

  args.push("--chdir", "/loopat/loop")
  // Don't unshare net — CC needs Anthropic API
  args.push("--unshare-pid", "--die-with-parent")
  args.push("claude", ...claudeArgs)

  console.log(`[spawn:bwrap] bwrap ${args.slice(0, 12).join(" ")} ...`)
  console.log(`[spawn:bwrap]   loop=${opts.loopDir} → /loopat/loop`)
  if (knowledgeSrc) console.log(`[spawn:bwrap]   knowledge=${knowledgeSrc} → /loopat/knowledge (ro)`)
  if (opts.vaultDir) console.log(`[spawn:bwrap]   vault=${opts.vaultDir} → /loopat/vault (ro)`)

  return new Promise((resolve) => {
    const child = spawn("bwrap", args, {
      env,
      stdio: "inherit",
    })
    child.on("exit", (code, sig) => resolve(code ?? (sig ? 130 : 1)))
    child.on("error", (e) => {
      console.error(`[spawn:bwrap] failed: ${e.message}`)
      resolve(127)
    })
  })
}
