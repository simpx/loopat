/**
 * Outer sandbox: build bwrap argv that wraps a single command (e.g. claude
 * CLI driver, or interactive bash for PTY) inside a virtualized fs view.
 *
 * Key decisions:
 *   - Single layer (this is the only sandbox; SDK's internal sandbox-runtime
 *     is disabled for CLI; PTY also goes through here)
 *   - Virtual paths Claude / user sees (all under /loopat/):
 *       /loopat/loop/<id>/workdir/    ← workdir (rw)
 *       /loopat/loop/<id>/.claude/    ← SDK CLAUDE_CONFIG_DIR (rw)
 *       /loopat/context/knowledge/    ← workspace docs (ro)
 *       /loopat/context/notes/        ← workspace prose (rw)
 *       /loopat/context/personal/     ← driver private (rw, memory/ + .loopat/{config.json,secrets/})
 *       /loopat/context/repos/<name>/ ← workspace repos (rw; commits go via workdir worktree)
 *   - $HOME (/home/$USER) is tmpfs; personal-dep symlink targets are re-bound
 *     to their real paths under $HOME so tools like ssh find $HOME/.ssh
 *   - Workspace repos are ALSO re-bound at their host absolute path because
 *     git worktrees store absolute gitdir paths. The virtual path is what the
 *     AI / user references; git internals follow the host path.
 *   - Network is not unshared (host network shared); API calls work directly
 *
 * See memory: project_loop_dir_is_sandbox.md
 */
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import {
  loopWorkdir,
  loopClaudeDir,
  loopEnvDir,
  loopEnvPath,
  workspaceKnowledgeDir,
  workspaceLoopatSkillsDir,
  workspaceLoopatEnvDir,
  workspaceNotesDir,
  workspaceReposDir,
  workspaceClaudePath,
  personalDir,
  LOOPAT_INSTALL_DIR,
} from "./paths"
import { resolveEnvFile } from "./envs"
import { resolvePersonalDeps } from "./personal-deps"
import { loadPersonalConfig } from "./config"

const execFileP = promisify(execFile)

/**
 * Run `mise install` + `mise env --json` in the given env dir (which contains
 * mise.toml and optionally mise.lock). Returns the env vars mise would
 * activate (PATH + any [env] keys).
 *
 * Why cwd-based instead of MISE_OVERRIDE_CONFIG_FILENAMES: mise's lockfile
 * generation requires the config to be discovered via cwd with the standard
 * `mise.toml` name. Override silently disables lockfile writes. With cwd
 * discovery + MISE_LOCKFILE=true, mise reads/writes `mise.lock` naturally.
 *
 * `mise install` is idempotent — already-installed versions are skipped.
 * Failure is fatal: if the env was selected for a loop, we don't silently
 * fall back to a barren PATH; surface the error to the caller.
 */
async function activateMiseEnv(envDirPath: string): Promise<Record<string, string>> {
  const env = {
    ...process.env,
    // Trust this env dir so `mise install` doesn't prompt.
    MISE_TRUSTED_CONFIG_PATHS: envDirPath,
    MISE_LOCKFILE: "true",
  }
  try {
    await execFileP("mise", ["install"], { env, cwd: envDirPath })
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      throw new Error(
        `mise not found on host. Install with one of:\n` +
          `  curl -fsSL https://mise.run | sh   (official)\n` +
          `  brew install mise                  (macOS)\n` +
          `  cargo install mise                 (rust)\n` +
          `Then ensure 'mise' is on the server process's PATH and restart loopat.`,
      )
    }
    throw new Error(`mise install failed for ${envDirPath}: ${e?.stderr ?? e?.message ?? e}`)
  }
  let stdout: string
  try {
    const r = await execFileP("mise", ["env", "--json"], { env, cwd: envDirPath })
    stdout = r.stdout
  } catch (e: any) {
    throw new Error(`mise env failed for ${envDirPath}: ${e?.stderr ?? e?.message ?? e}`)
  }
  let parsed: Record<string, string>
  try {
    parsed = JSON.parse(stdout)
  } catch (e: any) {
    throw new Error(`mise env produced invalid JSON for ${envDirPath}: ${e?.message ?? e}`)
  }
  return parsed
}

/**
 * Resolve a sandbox-side path. Only recognizes `~` and `$HOME` (sandbox's
 * $HOME is the same path as host's homedir since tmpfs overlays it). Absolute
 * paths pass through. No general `$VAR` expansion — sandbox-side env vars
 * shouldn't resolve against host's env.
 */
function expandSandboxPath(p: string, home: string): string {
  if (p === "~" || p === "$HOME") return home
  if (p.startsWith("~/")) return home + p.slice(1)
  if (p.startsWith("$HOME/")) return home + p.slice("$HOME".length)
  return p
}

/** src: relative under personal/<user>/, no `..`, no absolute. */
function isValidMountSrc(s: unknown): s is string {
  if (typeof s !== "string" || !s) return false
  if (s.startsWith("/")) return false
  return !s.split("/").some((seg) => seg === ".." || seg === "")
}

/** dst: rooted in the sandbox — `$HOME/...`, `~/...`, `~`, or absolute `/...`. */
function isValidMountDst(s: unknown): s is string {
  if (typeof s !== "string" || !s) return false
  return s === "~" || s === "$HOME" || s.startsWith("~/") || s.startsWith("$HOME/") || s.startsWith("/")
}

export const V_LOOP = (id: string) => `/loopat/loop/${id}`
export const V_LOOP_WORKDIR = (id: string) => `/loopat/loop/${id}/workdir`
export const V_LOOP_CLAUDE = (id: string) => `/loopat/loop/${id}/.claude`
export const V_LOOP_CLAUDE_SKILLS = (id: string) => `/loopat/loop/${id}/.claude/skills`
export const V_CONTEXT_KNOWLEDGE = "/loopat/context/knowledge"
export const V_CONTEXT_NOTES = "/loopat/context/notes"
export const V_CONTEXT_NOTES_MEMORY = "/loopat/context/notes/memory"
export const V_CONTEXT_PERSONAL = "/loopat/context/personal"
export const V_CONTEXT_PERSONAL_MEMORY = "/loopat/context/personal/memory"
export const V_CONTEXT_REPOS = "/loopat/context/repos"

export type SandboxExtraEnv = Record<string, string>

/**
 * Build bwrap argv list. Caller appends `[, "--", cmd, ...args]` and spawns.
 *
 * `envName` (optional): a workspace env (knowledge/.loopat/envs/<name>.toml).
 * When set, `mise install` + `mise env --json` run on the host; the env vars
 * mise produces (PATH plus any [env] keys) are injected via --setenv, and
 * `$HOME/.local/share/mise` is bound RO into the sandbox so the tool
 * binaries those PATH entries point to are visible inside.
 */
export async function buildOuterBwrapArgs(
  loopId: string,
  createdBy: string,
  extraSetenv: SandboxExtraEnv = {},
  envName?: string,
): Promise<string[]> {
  const home = homedir()
  const personalDeps = await resolvePersonalDeps(createdBy)

  // Resolve env up front so failures surface before we've built argv.
  // Prefer the per-loop snapshot dir (loops/<id>/env/) over the workspace
  // catalog so this loop is frozen at creation time — later catalog edits
  // don't perturb running loops.
  let miseEnv: Record<string, string> | null = null
  if (envName) {
    const snapshotDir = loopEnvDir(loopId)
    const haveSnapshot = existsSync(loopEnvPath(loopId))
    const envDirPath = haveSnapshot
      ? snapshotDir
      : (resolveEnvFile(envName) ? workspaceLoopatEnvDir(envName) : null)
    if (!envDirPath) {
      throw new Error(`env "${envName}" not found (no snapshot at ${snapshotDir}, no catalog entry)`)
    }
    miseEnv = await activateMiseEnv(envDirPath)
  }

  // Per-component ro-binds (NOT `--ro-bind / /`) — RO root prevents bwrap from
  // mkdir'ing virtual paths like /loop. With selective binds, the sandbox
  // root is a fresh tmpfs that bwrap can populate freely.
  const SYSTEM_RO = ["/usr", "/etc", "/lib", "/lib64", "/bin", "/sbin", "/opt", "/var", "/run"]
  const args: string[] = ["--new-session", "--die-with-parent"]
  for (const p of SYSTEM_RO) {
    // some paths may not exist on every distro — use --ro-bind-try
    args.push("--ro-bind-try", p, p)
  }
  args.push(
    // /tmp shared (writable, for socat / mktemp / IPC sockets)
    "--bind", "/tmp", "/tmp",
    // host home: tmpfs; personal-dep targets bound back below
    "--tmpfs", home,
    // virtual mount points: bind directly. bwrap auto-creates parents.
    "--bind", loopWorkdir(loopId), V_LOOP_WORKDIR(loopId),
    "--bind", loopClaudeDir(loopId), V_LOOP_CLAUDE(loopId),
    "--ro-bind", workspaceKnowledgeDir(), V_CONTEXT_KNOWLEDGE,
    "--bind", workspaceNotesDir(), V_CONTEXT_NOTES,
    "--bind", personalDir(createdBy), V_CONTEXT_PERSONAL,
    // loopat install dir (claude binary lives here)
    "--ro-bind", LOOPAT_INSTALL_DIR, LOOPAT_INSTALL_DIR,
  )

  // workspace skills: nested ro-bind over .claude/ so Claude Code discovers them
  // as user-tier skills (CLAUDE_CONFIG_DIR/skills). Only mount if populated.
  const skillsSrc = workspaceLoopatSkillsDir()
  if (existsSync(skillsSrc)) {
    args.push("--ro-bind", skillsSrc, V_LOOP_CLAUDE_SKILLS(loopId))
  }

  // workspace CLAUDE.md supplement: bind to CLAUDE_CONFIG_DIR/CLAUDE.md so Claude
  // Code natively loads it as user-tier (settingSources includes "user").
  // The platform doctrine (L2) is still injected via systemPrompt.append.
  const workspaceClaudeMd = workspaceClaudePath()
  if (existsSync(workspaceClaudeMd)) {
    args.push("--ro-bind", workspaceClaudeMd, join(V_LOOP_CLAUDE(loopId), "CLAUDE.md"))
  }

  // Claude Code's OAuth credentials for MCP servers (coop / yuque / aone-* …)
  // live at `~/.claude/.credentials.json` on the host. ro-bind into the
  // sandbox's CLAUDE_CONFIG_DIR so MCPs that use OAuth flow reuse the host
  // driver's tokens. Refresh-on-expiry will fail (ro), needs separate flow.
  const credsSrc = join(home, ".claude", ".credentials.json")
  if (existsSync(credsSrc)) {
    args.push("--ro-bind", credsSrc, join(V_LOOP_CLAUDE(loopId), ".credentials.json"))
  }

  // repos: bind at the virtual path (for AI / user) AND re-bind at the host
  // absolute path (for git internals — worktree `.git` files store absolute
  // gitdir paths). Same source, two paths. Rw because git writes
  // HEAD/index/logs in the main repo for each worktree.
  const reposDir = workspaceReposDir()
  if (existsSync(reposDir)) {
    args.push("--bind", reposDir, V_CONTEXT_REPOS)
    args.push("--bind", reposDir, reposDir)
  }

  args.push(
    // proc, dev, pid namespace
    "--proc", "/proc",
    "--dev", "/dev",
    "--unshare-pid",
    // cwd = workdir (the worktree); sibling .claude/ holds SDK state
    "--chdir", V_LOOP_WORKDIR(loopId),
    "--setenv", "PWD", V_LOOP_WORKDIR(loopId),
  )

  // re-bind personal-dep targets so e.g. /home/<user>/.ssh works for ssh client.
  // User-owned ssh keys (push to git, ssh to jumpboxes) live encrypted under
  // personal/<user>/.loopat/secrets/.ssh/ and reach $HOME/.ssh inside the
  // sandbox via a personal-deps symlink the user sets up themselves.
  // Loopat's deploy key (host-secrets/<user>/deploy-key) is NEVER bound here —
  // it's loopat-the-platform's clone credential, not for sandbox use.
  for (const target of personalDeps) {
    args.push("--bind", target, target)
  }

  // user-declared personal -> sandbox mounts. src is relative to
  // personalDir(user); dst is rooted in the sandbox ($HOME/..., ~/, or abs).
  // Always RO. Invalid entries (escape attempts, unrooted dst) are skipped
  // with a warn — one bad mount shouldn't block the loop from starting.
  const personalCfg = await loadPersonalConfig(createdBy)
  const sandboxCfg = personalCfg.sandbox ?? {}
  for (const m of sandboxCfg.mounts ?? []) {
    if (!isValidMountSrc(m.src) || !isValidMountDst(m.dst)) {
      console.warn(`[loopat] skipping invalid mount ${JSON.stringify(m)}`)
      continue
    }
    const src = join(personalDir(createdBy), m.src)
    const dst = expandSandboxPath(m.dst, home)
    args.push("--ro-bind-try", src, dst)
  }

  // env (mise) data dir: tools mise installs live under $HOME/.local/share/mise
  // on the host. $HOME inside the sandbox is tmpfs, so without re-binding, the
  // tool binaries that mise's PATH points to are invisible. ro-bind-try so a
  // host without mise installs yet doesn't error out.
  if (miseEnv) {
    const miseData = join(home, ".local", "share", "mise")
    args.push("--ro-bind-try", miseData, miseData)
  }

  // If an env is selected, mise's PATH already includes both the tool install
  // bins and the host PATH; pass it through wholesale. Without env, leave
  // PATH alone (sandbox inherits process.env.PATH).
  if (miseEnv) {
    for (const [k, v] of Object.entries(miseEnv)) {
      args.push("--setenv", k, v)
    }
  }

  for (const [k, v] of Object.entries(extraSetenv)) {
    args.push("--setenv", k, v)
  }

  return args
}
