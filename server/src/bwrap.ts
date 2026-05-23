/**
 * bwrap argv builder: wraps a single command (e.g. claude CLI driver, or
 * interactive bash for PTY) inside a virtualized fs view.
 *
 * Naming note: this module is internal — "bwrap" is the implementation
 * mechanism. User-facing concept is "sandbox" (the runtime environment a
 * loop activates). See docs/sandbox.md.
 *
 * Key decisions:
 *   - Single layer (this is the only sandboxing layer; SDK's internal
 *     sandbox-runtime is disabled for CLI; PTY also goes through here)
 *   - Virtual paths Claude / user sees (all under /loopat/):
 *       /loopat/loop/<id>/workdir/    ← workdir (rw)
 *       /loopat/loop/<id>/.claude/    ← SDK CLAUDE_CONFIG_DIR (rw)
 *       /loopat/context/knowledge/    ← workspace docs (ro)
 *       /loopat/context/notes/        ← workspace prose (rw)
 *       /loopat/context/personal/     ← driver private (rw)
 *       /loopat/context/repos/<name>/ ← workspace repos (rw)
 *   - $HOME (/home/$USER) is tmpfs; operator/member mounts go back on top
 *   - Workspace repos are ALSO re-bound at their host absolute path because
 *     git worktrees store absolute gitdir paths
 *   - Network is not unshared (host network shared); API calls work directly
 *
 * Three mount-authority tiers (see docs/sandbox.md "三层 mount 权责"):
 *   - operator: ~/.dashscope/config.json `mounts` (any host path)
 *   - member:   personal/<user>/.loopat/config.json `mounts` (personal-relative)
 *   - admin:    no mount capability (would let knowledge-pushers poison team)
 *
 * See memory: project_loop_dir_is_sandbox.md
 */
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { mkdir } from "node:fs/promises"
import {
  loopWorkdir,
  loopClaudeDir,
  loopsDir,
  loopSandboxDir,
  loopSandboxPath,
  loopContextChatDir,
  workspaceKnowledgeDir,
  workspaceLoopatSandboxDir,
  workspaceNotesDir,
  workspaceReposDir,
  loopContextKnowledge,
  loopContextNotes,
  workspaceClaudePath,
  personalDir,
  LOOPAT_INSTALL_DIR,
  serverPluginCacheRoot,
  loopHomeUpper,
  loopHomeWork,
  loopHomeMerged,
  workspaceHomeSkelDir,
} from "./paths"
import { resolveSandboxFile } from "./sandboxes"
import { loadConfig, loadPersonalConfig } from "./config"
import { DEFAULT_VAULT, resolveVaultRoot } from "./vaults"

const execFileP = promisify(execFile)

/**
 * Run `mise install` + `mise env --json` in the given sandbox dir (which
 * contains mise.toml and optionally mise.lock). Returns the env vars mise
 * would activate (PATH + any [env] keys).
 *
 * Why cwd-based instead of MISE_OVERRIDE_CONFIG_FILENAMES: mise's lockfile
 * generation requires the config to be discovered via cwd with the standard
 * `mise.toml` name. Override silently disables lockfile writes. With cwd
 * discovery + MISE_LOCKFILE=true, mise reads/writes `mise.lock` naturally.
 *
 * `mise install` is idempotent — already-installed versions are skipped.
 * Failure is fatal: if the sandbox was selected for a loop, we don't silently
 * fall back to a barren PATH; surface the error to the caller.
 */
async function activateMiseSandbox(sandboxDirPath: string): Promise<Record<string, string>> {
  const env = {
    ...process.env,
    // Trust this sandbox dir so `mise install` doesn't prompt.
    MISE_TRUSTED_CONFIG_PATHS: sandboxDirPath,
    MISE_LOCKFILE: "true",
  }
  try {
    await execFileP("mise", ["install"], { env, cwd: sandboxDirPath })
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
    throw new Error(`mise install failed for ${sandboxDirPath}: ${e?.stderr ?? e?.message ?? e}`)
  }
  let stdout: string
  try {
    const r = await execFileP("mise", ["env", "--json"], { env, cwd: sandboxDirPath })
    stdout = r.stdout
  } catch (e: any) {
    throw new Error(`mise env failed for ${sandboxDirPath}: ${e?.stderr ?? e?.message ?? e}`)
  }
  let parsed: Record<string, string>
  try {
    parsed = JSON.parse(stdout)
  } catch (e: any) {
    throw new Error(`mise env produced invalid JSON for ${sandboxDirPath}: ${e?.message ?? e}`)
  }
  return parsed
}

/**
 * Resolve a sandbox-side path. Only recognizes `~` and `$HOME` (sandbox's
 * $HOME is the same path as host's homedir since tmpfs overlays it).
 * Absolute paths pass through. No general `$VAR` expansion — sandbox-side
 * env vars shouldn't resolve against host's env.
 */
function expandSandboxPath(p: string, home: string): string {
  if (p === "~" || p === "$HOME") return home
  if (p.startsWith("~/")) return home + p.slice(1)
  if (p.startsWith("$HOME/")) return home + p.slice("$HOME".length)
  return p
}

/** Validate a member-side relative path (used for both PathRef variants).
 *  No `..`, no absolute, no empty segments. */
function isValidRelPath(s: unknown): s is string {
  if (typeof s !== "string" || !s) return false
  if (s.startsWith("/")) return false
  return !s.split("/").some((seg) => seg === ".." || seg === "")
}

/**
 * Operator-config src: any host path expressible as `~/...`, `$HOME/...`,
 * or absolute `/...`. Operator owns the host, so we don't restrict scope —
 * we just reject `..` traversal so a typo can't escape the declared root
 * accidentally.
 */
function isValidOperatorMountSrc(s: unknown): s is string {
  if (typeof s !== "string" || !s) return false
  if (!(s === "~" || s === "$HOME" || s.startsWith("~/") || s.startsWith("$HOME/") || s.startsWith("/"))) {
    return false
  }
  return !s.split("/").some((seg) => seg === "..")
}

/** dst: rooted in the sandbox — `$HOME/...`, `~/...`, `~`, or absolute `/...`. */
function isValidMountDst(s: unknown): s is string {
  if (typeof s !== "string" || !s) return false
  return s === "~" || s === "$HOME" || s.startsWith("~/") || s.startsWith("$HOME/") || s.startsWith("/")
}

export const V_LOOP = (id: string) => `/loopat/loop/${id}`
export const V_LOOP_WORKDIR = (id: string) => `/loopat/loop/${id}/workdir`
export const V_LOOP_CLAUDE = (id: string) => `/loopat/loop/${id}/.claude`
// All-loops view (admin / cross-loop distill only). When `mountAllLoops`
// is set, the entire LOOPAT_HOME/loops/ tree is ro-bound here so this loop
// can read every other loop's meta.json / messages.jsonl / workdir.
export const V_ALL_LOOPS = "/loopat/loops"
export const V_CONTEXT_KNOWLEDGE = "/loopat/context/knowledge"
export const V_CONTEXT_NOTES = "/loopat/context/notes"
export const V_CONTEXT_NOTES_MEMORY = "/loopat/context/notes/memory"
export const V_CONTEXT_PERSONAL = "/loopat/context/personal"
export const V_CONTEXT_PERSONAL_MEMORY = "/loopat/context/personal/memory"
export const V_CONTEXT_REPOS = "/loopat/context/repos"
export const V_CONTEXT_CHAT = "/loopat/context/chat"
export const V_CONTEXT_VAULT = "/loopat/context/vault"

export type SandboxExtraEnv = Record<string, string>

/**
 * Build bwrap argv list. Caller appends `[, "--", cmd, ...args]` and spawns.
 *
 * `sandboxName` (optional): a workspace sandbox catalog entry. When set,
 * `mise install` + `mise env --json` run on the host; the env vars mise
 * produces (PATH plus any [env] keys) are injected via --setenv, and
 * `$HOME/.local/share/mise` is bound RO into the sandbox so the tool
 * binaries those PATH entries point to are visible inside.
 */
export async function buildBwrapArgs(
  loopId: string,
  createdBy: string,
  extraSetenv: SandboxExtraEnv = {},
  sandboxName?: string,
  vaultName?: string,
  knowledgeRw?: boolean,
  homeOverlay: boolean = true,
  mountAllLoops?: boolean,
): Promise<string[]> {
  const home = homedir()

  // Resolve sandbox up front so failures surface before we've built argv.
  // Prefer the per-loop snapshot dir (loops/<id>/sandbox/) over the workspace
  // catalog so this loop is frozen at creation time — later catalog edits
  // don't perturb running loops.
  let miseEnv: Record<string, string> | null = null
  if (sandboxName) {
    const snapshotDir = loopSandboxDir(loopId)
    const haveSnapshot = existsSync(loopSandboxPath(loopId))
    const sandboxDirPath = haveSnapshot
      ? snapshotDir
      : (resolveSandboxFile(sandboxName) ? workspaceLoopatSandboxDir(sandboxName) : null)
    if (!sandboxDirPath) {
      throw new Error(`sandbox "${sandboxName}" not found (no snapshot at ${snapshotDir}, no catalog entry)`)
    }
    miseEnv = await activateMiseSandbox(sandboxDirPath)
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
    // host home → either overlayfs merged dir (if homeOverlay) or tmpfs.
    // Overlay needs the unshare wrapper + bwrap ≥ 0.9 nested-userns uid drop;
    // on envs where that fails (e.g. bwrap 0.4.0 on some cloud images), we
    // fall back to a per-spawn tmpfs (no persistence, but works everywhere).
    // operator/member mounts go back on top below.
    ...(homeOverlay
      ? (["--bind", loopHomeMerged(loopId), home] as const)
      : (["--tmpfs", home] as const)),
    // virtual mount points: bind directly. bwrap auto-creates parents.
    "--bind", loopWorkdir(loopId), V_LOOP_WORKDIR(loopId),
    "--bind", loopClaudeDir(loopId), V_LOOP_CLAUDE(loopId),
    // notes/knowledge: bind the per-loop worktree (not the shared repo)
    // so concurrent loops don't trample each other. Publish flow goes through
    // `git push . HEAD:<trunk>` from within the worktree.
    knowledgeRw ? "--bind" : "--ro-bind", loopContextKnowledge(loopId), V_CONTEXT_KNOWLEDGE,
    "--bind", loopContextNotes(loopId), V_CONTEXT_NOTES,
    "--bind", personalDir(createdBy), V_CONTEXT_PERSONAL,
    // loopat install dir (claude binary lives here)
    "--ro-bind", LOOPAT_INSTALL_DIR, LOOPAT_INSTALL_DIR,
  )

  // Server-side plugin cache (workspace + personal marketplace clones +
  // plugin checkouts). Bound same-to-same so loop-internal symlinks (whose
  // targets are host paths under this dir) resolve inside the sandbox. Only
  // bind when the dir exists — empty workspaces don't need it.
  const pluginCache = serverPluginCacheRoot()
  if (existsSync(pluginCache)) {
    args.push("--ro-bind", pluginCache, pluginCache)
  }

  // ── vault symlink ──
  // Personal is bound wholesale above, so all named vaults under
  // .loopat/vaults/ are visible inside the sandbox (no isolation between
  // named vaults — they're per-user, not per-loop). Convenience symlink for
  // the AI: it accesses the selected loop's credentials through
  // /loopat/context/vault, not by digging into personal/.loopat/vaults/.
  // Doctrine tells the AI to stick to this entrypoint and ignore the other
  // vaults present in personal/.
  //
  // History: we previously per-file-bound each vault file into a sandbox-side
  // `.loopat/vault/` dir, but bwrap creates an empty stub on the host at each
  // bind target. Those stubs accumulated in personal repo and got committed.
  // A symlink avoids any host-side file creation.
  const vault = vaultName?.trim() || DEFAULT_VAULT
  const vaultRoot = resolveVaultRoot(createdBy, vault)
  if (vaultRoot) {
    args.push("--symlink", `${V_CONTEXT_PERSONAL}/.loopat/vaults/${vault}`, V_CONTEXT_VAULT)
  } else {
    console.warn(`[loopat] loop ${loopId}: vault "${vault}" not found for user ${createdBy} — running with no credentials`)
  }

  // skills + agents: composed into loops/<id>/.claude/{skills,agents}/ by
  // `composeLoopClaudeConfig()` (see compose.ts) BEFORE this argv is built.
  // Plugins: SDK passes `--plugin-dir <path>` per resolved plugin from the
  // server-side cache (see plugin-installer.ts + session.ts plugins option);
  // nothing is written into the loop's .claude/plugins/.
  // The whole .claude/ dir is already rw-bound above (V_LOOP_CLAUDE).

  // workspace CLAUDE.md supplement: bind to CLAUDE_CONFIG_DIR/CLAUDE.md so Claude
  // Code natively loads it as user-tier (settingSources includes "user").
  // The platform doctrine (L2) is still injected via systemPrompt.append.
  const workspaceClaudeMd = workspaceClaudePath()
  if (existsSync(workspaceClaudeMd)) {
    args.push("--ro-bind", workspaceClaudeMd, join(V_LOOP_CLAUDE(loopId), "CLAUDE.md"))
  }

  // We used to ro-bind `~/.claude/.credentials.json` here, intending to share
  // MCP OAuth tokens — but that file only ever contains `claudeAiOauth` (the
  // host driver's Anthropic subscription token), not MCP server OAuth state.
  // Binding it in caused the sandboxed CC to consume the refresh token (which
  // rotates per-refresh) without being able to write the new one back through
  // a RO mount; the host's CC then sees a stale token and gets logged out.
  //
  // loopat is BYO-API-key by design (ANTHROPIC_API_KEY env injected per
  // sandbox), so the sandboxed CC never needs the host's subscription token.
  // If we ever ship per-loop MCP OAuth, the right home is a loop-private
  // credentials file under the sandbox's CLAUDE_CONFIG_DIR, not a host bind.

  // repos: bind at the virtual path (for AI / user) AND re-bind at the host
  // absolute path (for git internals — worktree `.git` files store absolute
  // gitdir paths). Same source, two paths. Rw because git writes
  // HEAD/index/logs in the main repo for each worktree.
  const reposDir = workspaceReposDir()
  if (existsSync(reposDir)) {
    args.push("--bind", reposDir, V_CONTEXT_REPOS)
    args.push("--bind", reposDir, reposDir)
  }

  // notes/knowledge main repos: re-bind at host absolute path so the
  // per-loop worktree's `.git` file (which stores the absolute gitdir path)
  // resolves inside the sandbox. Same trick as repos above. Notes is always
  // RW (gitdir writes during publish). Knowledge follows the rw flag.
  const notesRepo = workspaceNotesDir()
  if (existsSync(notesRepo)) {
    args.push("--bind", notesRepo, notesRepo)
  }
  const knowledgeRepo = workspaceKnowledgeDir()
  if (existsSync(knowledgeRepo)) {
    args.push(knowledgeRw ? "--bind" : "--ro-bind", knowledgeRepo, knowledgeRepo)
  }

  // chat snapshots (per-loop). Each conv that seeded this loop drops a jsonl
  // here. Read-only — AI consumes, doesn't write. Only mount if populated
  // (most loops never spawn from chat).
  const chatDir = loopContextChatDir(loopId)
  if (existsSync(chatDir)) {
    args.push("--ro-bind", chatDir, V_CONTEXT_CHAT)
  }

  // All-loops ro view (admin-gated). When set, expose the entire
  // LOOPAT_HOME/loops/ tree at /loopat/loops so this loop can read every
  // other loop's chat / workdir / meta for cross-loop distill. Strictly
  // read-only — this loop never mutates other loops' state. The current
  // loop's own data is still rw at /loopat/loop/<id>/ via the binds above
  // (bwrap stacks the two non-overlapping paths cleanly).
  if (mountAllLoops) {
    args.push("--ro-bind", loopsDir(), V_ALL_LOOPS)
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

  // ── three-layer mount authority ──
  // operator: ~/.dashscope/config.json `mounts` — any host path is fair
  //   game (operator owns the host); intended for cross-user shared host
  //   caches (e.g. /etc/pki/ca-trust) or operator-only host conveniences.
  // member: personal/<user>/.loopat/config.json `mounts` — src strictly
  //   within personal/<user>/ subtree, so one member can't reach into
  //   another's data or operator's host paths.
  // admin: no mount field in sandbox.json (would let a knowledge pusher mount
  //   anything across the whole team).
  const workspaceCfg = await loadConfig()
  for (const m of workspaceCfg.mounts ?? []) {
    if (!isValidOperatorMountSrc(m.src) || !isValidMountDst(m.dst)) {
      console.warn(`[loopat] skipping invalid workspace mount ${JSON.stringify(m)}`)
      continue
    }
    const src = expandSandboxPath(m.src, home)
    const dst = expandSandboxPath(m.dst, home)
    args.push(m.rw ? "--bind-try" : "--ro-bind-try", src, dst)
  }

  const personalCfg = await loadPersonalConfig(createdBy, vault)
  const personalRoot = personalDir(createdBy)
  for (const m of personalCfg.mounts ?? []) {
    if (!isValidMountDst(m.dst)) {
      console.warn(`[loopat] skipping invalid personal mount ${JSON.stringify(m)}`)
      continue
    }
    // PathRef: bare string → personal-relative; { vault } → active-vault-relative.
    let src: string | null = null
    if (typeof m.src === "string") {
      if (!isValidRelPath(m.src)) {
        console.warn(`[loopat] skipping invalid personal mount ${JSON.stringify(m)}`)
        continue
      }
      src = join(personalRoot, m.src)
    } else if (m.src && typeof m.src === "object" && "vault" in m.src && isValidRelPath((m.src as any).vault)) {
      if (!vaultRoot) {
        // No active vault → silently skip vault-relative mounts. Matches the
        // "missing source is skipped" policy in the Mount JSDoc.
        continue
      }
      src = join(vaultRoot, (m.src as { vault: string }).vault)
    } else {
      console.warn(`[loopat] skipping invalid personal mount ${JSON.stringify(m)}`)
      continue
    }
    const dst = expandSandboxPath(m.dst, home)
    args.push(m.rw ? "--bind-try" : "--ro-bind-try", src, dst)
  }

  // mise data dir: tools mise installs live under $HOME/.local/share/mise
  // on the host. $HOME inside the sandbox is tmpfs, so without re-binding, the
  // tool binaries that mise's PATH points to are invisible. ro-bind-try so a
  // host without mise installs yet doesn't error out.
  if (miseEnv) {
    const miseData = join(home, ".local", "share", "mise")
    args.push("--ro-bind-try", miseData, miseData)
  }

  // If a sandbox is selected, mise's PATH already includes both the tool
  // install bins and the host PATH; pass it through wholesale. Without a
  // sandbox, leave PATH alone (sandbox inherits process.env.PATH).
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

// ── docker-style $HOME overlay ─────────────────────────────────────────────
// bwrap 0.9.0 (Ubuntu noble) ships without overlay support compiled in. We
// achieve docker container-layer semantics for $HOME by wrapping bwrap in an
// outer `unshare -Umr`: unshare gives us a user+mount NS where we can mount
// overlayfs (kernel ≥ 5.11 supports it unprivileged); bwrap then inherits
// that mount NS and binds the overlay's merged dir at the sandbox $HOME.
//
//   Image (lower) = workspaceHomeSkelDir() — shared, immutable, typically empty
//   Container layer (upper) = loops/<id>/home-upper/ — per-loop, persistent
//   Workdir = loops/<id>/home-work/ — overlayfs scratch
//   Merged mount point = loops/<id>/home-merged/ — bwrap binds this at $HOME
//
// On bwrap exit, the unshare NS dies and the overlay mount auto-unmounts.
// The upper dir persists on host disk; next spawn sees previous writes.
//
// `unshare -Umr` maps host_uid → 0 inside the userns so we can mount overlay
// (requires CAP_SYS_ADMIN, granted by being uid 0). But claude refuses to run
// with `--dangerously-skip-permissions` when uid==0. Fix: bwrap creates a
// nested userns via `--unshare-user --uid <host_uid>` and maps back to the
// original uid for the sandboxed process.

export type SandboxOverlayPaths = {
  lower: string
  upper: string
  work: string
  merged: string
}

// Probe (once per server lifetime) whether the unshare + bwrap-nested-userns
// uid drop combination actually works on this host. bwrap 0.9 supports it;
// 0.4 (still shipped on some Aliyun/EL8-derivative images) fails with
// "bwrap: unable to drop root uid: Invalid argument" because the nested
// userns uid_map semantics differ. When unsupported, callers must skip the
// unshare wrapper entirely and use --tmpfs $HOME instead of the overlay.
let _homeOverlayProbe: Promise<boolean> | null = null
export function isHomeOverlaySupported(): Promise<boolean> {
  if (process.env.LOOPAT_NO_HOME_OVERLAY === "1") return Promise.resolve(false)
  if (!_homeOverlayProbe) {
    _homeOverlayProbe = (async () => {
      const uid = String(process.getuid?.() ?? 0)
      const gid = String(process.getgid?.() ?? 0)
      try {
        await execFileP(
          "unshare",
          [
            "-Umr", "--",
            "bwrap", "--unshare-user", "--uid", uid, "--gid", gid,
            "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
            "--", "/bin/true",
          ],
          { timeout: 5000 },
        )
        return true
      } catch (e: any) {
        const msg = e?.stderr?.toString?.() || e?.message || String(e)
        console.warn(
          `[loopat] $HOME overlay disabled — host bwrap can't drop uid via nested userns ` +
          `(likely bwrap < 0.9). Falling back to --tmpfs $HOME (no per-loop persistence). ` +
          `Probe error: ${msg.trim()}`,
        )
        return false
      }
    })()
  }
  return _homeOverlayProbe
}

/** Idempotently mkdir the four dirs the overlay mount needs. */
export async function prepareSandboxOverlay(loopId: string): Promise<SandboxOverlayPaths> {
  const lower = workspaceHomeSkelDir()
  const upper = loopHomeUpper(loopId)
  const work = loopHomeWork(loopId)
  const merged = loopHomeMerged(loopId)
  await Promise.all([
    mkdir(lower, { recursive: true }),
    mkdir(upper, { recursive: true }),
    mkdir(work, { recursive: true }),
    mkdir(merged, { recursive: true }),
  ])
  return { lower, upper, work, merged }
}

// Script body executed in the unshare NS: mount overlay using $1..$4 as
// lower/upper/work/merged, then shift those off and exec the remainder
// ($5+ = "bwrap" plus its argv, ending with "--", command, command args).
const SANDBOX_SPAWN_SCRIPT =
  'mount -t overlay overlay -o "lowerdir=$1,upperdir=$2,workdir=$3" "$4" && shift 4 && exec "$@"'

/**
 * Build the argv for `unshare` that wraps bwrap + overlay mount. Caller
 * spawns the binary "unshare" with the returned args (NOT "bwrap" directly).
 * Sync: caller must `await prepareSandboxOverlay(loopId)` beforehand so the
 * mount points exist.
 */
export function buildSandboxSpawnArgv(
  overlay: SandboxOverlayPaths,
  bwrapArgs: string[],
  command: string,
  commandArgs: string[],
): string[] {
  // Drop bwrap back to the host uid/gid via a nested userns. Outer `-Umr` is
  // uid 0 in userns A; bwrap's `--unshare-user --uid X` creates userns B where
  // inner_uid X maps to outer_userns_uid 0 (which is the host uid). Without
  // this, claude sees uid==0 and refuses `--dangerously-skip-permissions`.
  const hostUid = process.getuid?.() ?? 0
  const hostGid = process.getgid?.() ?? 0
  const uidDrop = ["--unshare-user", "--uid", String(hostUid), "--gid", String(hostGid)]
  return [
    "-Umr",
    "--",
    "bash", "-c", SANDBOX_SPAWN_SCRIPT,
    "_", // $0 placeholder (unused inside script)
    overlay.lower, overlay.upper, overlay.work, overlay.merged, // $1..$4
    "bwrap", ...uidDrop, ...bwrapArgs, "--", command, ...commandArgs, // $5+ → exec'd after shift
  ]
}
