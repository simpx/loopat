/**
 * Podman-based sandbox: one long-lived rootless container per loop. Both SDK
 * CLI and PTY bash run inside the same container via `podman exec`, so they
 * share PID / Mount / IPC namespaces — the terminal can `ps` and see what the
 * AI is running, and vice versa. Idle → `podman stop` → kernel reaps the
 * namespace.
 *
 * Naming note: this module is internal — "podman" is the implementation
 * mechanism. User-facing concept stays "sandbox" (see docs/sandbox.md).
 *
 * Key decisions:
 *   - Base image is `loopat-sandbox:latest`, built locally on first run from
 *     server/templates/sandbox/Containerfile (FROM Aliyun AC2 Ubuntu 24.04 + bash +
 *     coreutils + util-linux + procps + less). Keeps the image small + boring
 *     — every "heavy" tool (claude binary, node, mise, host caches) is bound
 *     in from the host at container-create time via --volume. Glibc inside
 *     the image matches the host (both Ubuntu 24.04 lineage), so host-built
 *     binaries Just Work.
 *   - slirp4netns (default rootless): each container gets a private IP
 *     (10.0.2.x); outbound API calls via NAT, inbound via container IP.
 *   - --userns=keep-id: host uid is mapped to the same uid inside, so files
 *     created by the AI are owned by the user on the host too. Rootless
 *     subuid/subgid mappings (see /etc/subuid) make this work.
 *   - --init: podman auto-injects catatonit (or tini) as PID 1 so zombies
 *     from orphaned background processes get reaped.
 *   - Long-lived container with `sleep infinity` as the main command. Both
 *     SDK and PTY are `podman exec` siblings of this.
 *
 * Two mount-authority tiers (same model as bwrap):
 *   - operator: ~/.loopat/config.json `mounts` (any host path)
 *   - member:   convention-based via `vaults/<v>/mounts/home/<rel>/...` → $HOME/<rel>/...
 *   - admin:    no mount capability
 *
 * See memory: project_loop_dir_is_sandbox.md
 */
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, statSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { promisify } from "node:util"
import {
  WORKSPACE,
  loopWorkdir,
  loopClaudeDir,
  loopsDir,
  loopContextChatDir,
  loopContextKnowledge,
  loopContextNotes,
  personalDir,
  personalKnowledgeDir,
  personalNotesDir,
  personalReposDir,
  personalRepoCacheDir,
  LOOPAT_INSTALL_DIR,
  loopHomeUpper,
  workspaceHomeSkelDir,
  loopDir,
  personalVaultMountsHomeDir,
} from "./paths"
import { loadConfig, loadPersonalConfig, parseDefault, pickProvider, type ProviderConfig } from "./config"
import { DEFAULT_VAULT, listVaultHomeMounts } from "./vaults"
import { hostExecDir, writeHostShims } from "./host-exec"
import { resolveSandboxClaudeBinary } from "./claude-binary"
import { parse as tomlParse, stringify as tomlStringify } from "smol-toml"
import { withSpan } from "./tracer"

const execFileP = promisify(execFile)

// ── Virtual paths (kept identical to bwrap era so AI doctrine still applies) ──
export const V_LOOP = (id: string) => `/loopat/loop/${id}`
export const V_LOOP_WORKDIR = (id: string) => `/loopat/loop/${id}/workdir`
export const V_LOOP_CLAUDE = (id: string) => `/loopat/loop/${id}/.claude`
export const V_ALL_LOOPS = "/loopat/loops"
export const V_CONTEXT_KNOWLEDGE = "/loopat/context/knowledge"
export const V_CONTEXT_NOTES = "/loopat/context/notes"
export const V_CONTEXT_NOTES_MEMORY = "/loopat/context/notes/memory"
export const V_CONTEXT_PERSONAL = "/loopat/context/personal"
export const V_CONTEXT_PERSONAL_MEMORY = "/loopat/context/personal/memory"
export const V_CONTEXT_REPOS = "/loopat/context/repos"
export const V_CONTEXT_CHAT = "/loopat/context/chat"

// host-cli proxy: the dir holding the host-exec unix socket, mounted in so the
// loop's `loopat-host` forwarder can reach the host. Mount the DIR (not the
// socket file) so a server restart that recreates the socket inode stays
// visible inside running containers.
export const V_HOST_EXEC_DIR = "/loopat/host-exec"
export const V_HOST_EXEC_SOCK = "/loopat/host-exec/host-exec.sock"

// $HOME inside the container. MUST equal the sandbox user's /etc/passwd home,
// otherwise ssh/git resolve `~` (e.g. ~/.ssh) via getpwuid (= passwd home), NOT
// $HOME — so a vault mounted at $HOME/.ssh is invisible to ssh and every
// sandbox-side `git push`/clone fails "Host key verification failed" / can't
// find the key. The image's `loopat` user (uid 2000) has passwd home
// /home/loopat, so we use exactly that.
//
// Still NOT the host's homedir: binding host $HOME at its real path makes podman
// auto-create nested-bind parent dirs owned by a subuid the host can't delete.
// /home/loopat is a CONTAINER-internal path — host-absolute binds sit outside
// it, and it vanishes with the container, so there's no host residue. (Per-user
// distinction is unnecessary: each loop has its own isolated container + home
// overlay; the home path inside need not encode the user.)
export const V_HOME = (_user: string) => `/home/loopat`

// Label keys for podman inspect.
const LABEL_LOOP = "loopat.loop-id"
const LABEL_WORKSPACE = "loopat.workspace"
const LABEL_CONFIG_HASH = "loopat.config-hash"

// Image used as the base for every loop container. Built locally from
// server/templates/sandbox/Containerfile via ensureSandboxImage().
// Per-workspace image name so multiple LOOPAT_HOMEs on one host don't share
// (and can't accidentally delete) each other's images. `uninstall` finds them
// by the loopat.workspace label, not this name — the name only prevents tag
// collisions. Same-Containerfile builds still share overlay layers, so the
// per-workspace tags don't multiply disk usage.
// Image tag is content-addressed (no workspace prefix) so the same image is
// reused across workspaces/LOOPAT_HOMEs instead of rebuilt per workspace. The
// trade-off (deliberate): deleting a workspace no longer prunes its images —
// we'd rather leave a residual image than rebuild on every fresh workspace.
// Containers + their LABEL_WORKSPACE stay workspace-scoped (runtime isolation).
export const SANDBOX_IMAGE = process.env.LOOPAT_SANDBOX_IMAGE || `loopat-sandbox:latest`
// Prebuilt multi-arch base image published to GHCR by CI, tagged by the
// Containerfile content hash. ensureSandboxImage pulls this instead of building
// locally — a pull is faster and far more reliable than apt-installing ~150
// packages over a flaky China mirror. Falls back to a local build when the pull
// fails (ghcr unreachable on this network, or a locally-modified Containerfile
// whose hash was never published). Override the repo via env for forks.
const SANDBOX_IMAGE_REF = process.env.LOOPAT_SANDBOX_IMAGE_REF || "ghcr.io/simpx/loopat-sandbox"

// Container name: prefix with workspace to avoid collisions between loopat
// instances running on the same host with different LOOPAT_HOME. Loop UUIDs
// are already globally unique; the prefix is for human grep.
export function containerName(loopId: string): string {
  return `loopat-${WORKSPACE}-${loopId}`
}

export type ContainerOptions = {
  loopId: string
  createdBy: string
  vaultName?: string
  knowledgeRw?: boolean
  mountAllLoops?: boolean
  /** Source roster repo for this loop's workdir (meta.repo). The workdir is a
   *  `git worktree add` off this repo's bare mirror (repo-cache/<repo>), so its
   *  .git gitdir points into that mirror. When set, the mirror is bind-mounted
   *  at its host path (src=dst, rw) so the worktree resolves inside the sandbox. */
  repo?: string
  /** Extra env vars to pre-bake into the container at create time. */
  extraEnv?: Record<string, string>
  /** Image to create the container from. Defaults to SANDBOX_IMAGE.
   *  Production callers resolve a per-loop child via ensureLoopImage; tests
   *  may omit this and get the base. */
  image?: string
  /** Ephemeral port publishing: when set, the container is created with
   *  `-p :<internalPort>[/<proto>]` so the kernel assigns a random host
   *  port. Host port is queried via `podman port` after start. Changing
   *  this list shifts the config hash → container recreate. */
  ephemeralPorts?: { internalPort: number; protocol?: "tcp" | "udp" }[]
}

/**
 * Resolve a sandbox-side path. `~` / `$HOME` resolve to V_HOME(user) — the
 * sandbox's virtual home, NOT the host's homedir. Absolute paths pass through.
 * Operator src side: `~` resolves to host homedir (since the operator config
 * names host paths).
 */
function expandSandboxPath(p: string, virtualHome: string): string {
  if (p === "~" || p === "$HOME") return virtualHome
  if (p.startsWith("~/")) return virtualHome + p.slice(1)
  if (p.startsWith("$HOME/")) return virtualHome + p.slice("$HOME".length)
  return p
}

function expandHostPath(p: string, hostHome: string): string {
  if (p === "~" || p === "$HOME") return hostHome
  if (p.startsWith("~/")) return hostHome + p.slice(1)
  if (p.startsWith("$HOME/")) return hostHome + p.slice("$HOME".length)
  return p
}

function isValidOperatorMountSrc(s: unknown): s is string {
  if (typeof s !== "string" || !s) return false
  if (!(s === "~" || s === "$HOME" || s.startsWith("~/") || s.startsWith("$HOME/") || s.startsWith("/"))) {
    return false
  }
  return !s.split("/").some((seg) => seg === "..")
}

function isValidMountDst(s: unknown): s is string {
  if (typeof s !== "string" || !s) return false
  return s === "~" || s === "$HOME" || s.startsWith("~/") || s.startsWith("$HOME/") || s.startsWith("/")
}

export type VolumeMount = {
  src: string
  dst: string
  /** true = read-only; false = read-write (default). */
  ro?: boolean
}

/**
 * Build the volume list for `podman create`. Returns the same logical bind
 * set the bwrap era built, just expressed as podman --volume pairs.
 *
 * NOTE: this is async (loads config + checks fs for existence-conditional
 * binds) but does NO container I/O.
 */
export async function buildVolumeMounts(opts: ContainerOptions): Promise<VolumeMount[]> {
  const hostHome = homedir()
  const { loopId, createdBy, vaultName, knowledgeRw, mountAllLoops, repo } = opts
  const virtualHome = V_HOME(createdBy)
  const mounts: VolumeMount[] = []

  // /tmp: shared with host (for socat / mktemp / IPC sockets). Same as today.
  // mounts.push({ src: "/tmp", dst: "/tmp" })

  // $HOME: per-loop upper layer, persistent across container restarts. We
  // place it under /loopat/home/<user> instead of host's actual homedir so
  // nothing nests under it. (See V_HOME comment for why.)
  mounts.push({ src: loopHomeUpper(loopId), dst: virtualHome })

  // Virtual mount points for AI / user:
  mounts.push({ src: loopWorkdir(loopId), dst: V_LOOP_WORKDIR(loopId) })

  // Workdir built from a roster repo is a `git worktree add` off the repo's
  // bare mirror (repo-cache/<repo>); the workdir's .git is a gitdir pointer INTO
  // that mirror. Bind the mirror at its host path (src=dst) so the worktree's
  // objects/refs/worktree-metadata resolve inside the sandbox — otherwise
  // `git status` in the workdir is "fatal: not a git repository". rw because git
  // writes the worktree's index/HEAD/logs under <mirror>/worktrees/<wt>/.
  if (repo) {
    const cache = personalRepoCacheDir(createdBy, repo)
    mounts.push({ src: cache, dst: cache })
  }
  mounts.push({ src: loopClaudeDir(loopId), dst: V_LOOP_CLAUDE(loopId) })
  mounts.push({
    src: loopContextKnowledge(loopId),
    dst: V_CONTEXT_KNOWLEDGE,
    ro: !knowledgeRw,
  })
  mounts.push({ src: loopContextNotes(loopId), dst: V_CONTEXT_NOTES })
  mounts.push({ src: personalDir(createdBy), dst: V_CONTEXT_PERSONAL })

  // Re-bind personal at the host-absolute path. compose.ts creates symlinks
  // under loops/<id>/.claude/skills/<name> whose targets are host-absolute
  // paths into personalDir(user); without this re-bind the targets wouldn't
  // resolve inside the container.
  mounts.push({ src: personalDir(createdBy), dst: personalDir(createdBy) })

  // LOOPAT_INSTALL_DIR ro (claude binary + builtin plugins).
  mounts.push({ src: LOOPAT_INSTALL_DIR, dst: LOOPAT_INSTALL_DIR, ro: true })

  // The claude binary may live OUTSIDE LOOPAT_INSTALL_DIR: under npx, loopat is
  // at _npx/<hash>/node_modules/loopat while claude is a sibling at
  // _npx/<hash>/node_modules/@anthropic-ai/claude-agent-sdk-<plat>/. The
  // sandbox exec's it by its host path, so bind that path in (ro) when it isn't
  // already covered by the install-dir mount — otherwise the AI is code 127.
  try {
    const claudeDir = dirname(resolveSandboxClaudeBinary())
    if (existsSync(claudeDir) && !claudeDir.startsWith(LOOPAT_INSTALL_DIR)) {
      mounts.push({ src: claudeDir, dst: claudeDir, ro: true })
    }
  } catch {}

  // ~/.claude/plugins/ ro-bind under the sandbox $HOME so the SDK's plugin
  // resolution (which reads from ~/.claude/plugins/) finds the same set the
  // host has. Source path is host's actual ~/.claude/plugins/; dst is the
  // sandbox $HOME's analogue.
  const hostUserPluginsDir = join(hostHome, ".claude", "plugins")
  const sandboxUserPluginsDir = join(virtualHome, ".claude", "plugins")
  if (existsSync(hostUserPluginsDir)) {
    mounts.push({ src: hostUserPluginsDir, dst: sandboxUserPluginsDir, ro: true })
  }

  // Per-loop installed_plugins.json snapshot (if compose wrote one): file-
  // level bind OVER the wholesale dir bind. podman --volume supports file
  // binds.
  const loopInstalledPlugins = join(loopClaudeDir(loopId), "plugins", "installed_plugins.json")
  if (existsSync(loopInstalledPlugins)) {
    mounts.push({
      src: loopInstalledPlugins,
      dst: join(sandboxUserPluginsDir, "installed_plugins.json"),
      ro: true,
    })
  }

  // Repos: bind at virtual path AND host-absolute path (git worktree internals
  // store absolute gitdir paths). Both RW. PER-USER (the loop's own roster).
  const reposDir = personalReposDir(createdBy)
  if (existsSync(reposDir)) {
    mounts.push({ src: reposDir, dst: V_CONTEXT_REPOS })
    mounts.push({ src: reposDir, dst: reposDir })
  }

  // notes/knowledge main repos: re-bind at host-absolute path so the per-loop
  // worktree `.git` files resolve. PER-USER — the worktrees are derived from
  // personalKnowledgeDir/personalNotesDir(createdBy), so the main repos bound
  // here must match (same as personalDir above).
  const notesRepo = personalNotesDir(createdBy)
  if (existsSync(notesRepo)) {
    mounts.push({ src: notesRepo, dst: notesRepo })
  }
  const knowledgeRepo = personalKnowledgeDir(createdBy)
  if (existsSync(knowledgeRepo)) {
    mounts.push({ src: knowledgeRepo, dst: knowledgeRepo, ro: !knowledgeRw })
  }

  // chat snapshots (per-loop, ro). Only mount if populated.
  const chatDir = loopContextChatDir(loopId)
  if (existsSync(chatDir)) {
    mounts.push({ src: chatDir, dst: V_CONTEXT_CHAT, ro: true })
  }

  // host-cli proxy: mount the host-exec socket dir so the loop's `loopat-host`
  // forwarder can reach the host. Mounting the socket IS the trust decision —
  // a loop with this mount may run any host cli (see host-exec.ts). The dir is
  // created by serveHostExec at boot; mount if present (bind-try semantics).
  const hostExec = hostExecDir()
  if (existsSync(hostExec)) {
    mounts.push({ src: hostExec, dst: V_HOST_EXEC_DIR })
  }

  // All-loops ro view (admin-gated): expose LOOPAT_HOME/loops/ at /loopat/loops.
  if (mountAllLoops) {
    mounts.push({ src: loopsDir(), dst: V_ALL_LOOPS, ro: true })
  }

  // Operator-tier mounts: from workspace config `mounts`. Any host path is
  // fair game; operator owns the host. src is a host path (expand against
  // host's home), dst is a sandbox path (expand against virtual home).
  const workspaceCfg = await loadConfig()
  for (const m of workspaceCfg.mounts ?? []) {
    if (!isValidOperatorMountSrc(m.src) || !isValidMountDst(m.dst)) {
      console.warn(`[loopat] skipping invalid workspace mount ${JSON.stringify(m)}`)
      continue
    }
    const src = expandHostPath(m.src, hostHome)
    const dst = expandSandboxPath(m.dst, virtualHome)
    if (!existsSync(src)) continue // bind-try semantics
    mounts.push({ src, dst, ro: !m.rw })
  }

  // Member-tier vault mounts: vaults/<v>/mounts/home/<top> → $HOME/<top>.
  const vault = vaultName?.trim() || DEFAULT_VAULT
  for (const m of listVaultHomeMounts(createdBy, vault)) {
    if (!existsSync(m.src)) continue
    mounts.push({ src: m.src, dst: join(virtualHome, m.rel) })
  }

  // No mise bind — toolchains are baked into the per-loop image instead
  // (see ensureLoopImage). The image's MISE_DATA_DIR=/opt/loopat-mise lives
  // outside $HOME so the home-upper overlay can't shadow installed tools.

  return mounts
}

/**
 * Build env-var map to bake into the container at create time.
 *
 * mise PATH is set by the IMAGE (ENV directives in base + per-loop child),
 * not here — so the toolchain works for any process inside the container
 * without needing host-side env extraction.
 */
export async function buildContainerEnv(opts: ContainerOptions): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  // Sandbox $HOME is /loopat/home/<user> (see V_HOME comment).
  out.HOME = V_HOME(opts.createdBy)
  // host-cli proxy: tell the loop's `loopat-host` forwarder where the mounted
  // socket is and which loop it speaks for (server uses it for the workdir).
  out.LOOPAT_HOST_SOCK = V_HOST_EXEC_SOCK
  out.LOOPAT_LOOP_ID = opts.loopId
  for (const [k, v] of Object.entries(opts.extraEnv ?? {})) {
    out[k] = v
  }
  return out
}

/**
 * Build the unified env for a loop — used by BOTH SDK (session.ts) and PTY
 * (term.ts). Every process inside the container sees the same env: vault
 * secrets, provider credentials, CC config dir, compact threshold.
 *
 * Callers may layer terminal-only vars (TERM, XDG_*) on top at exec time.
 */
export async function buildLoopEnv(opts: {
  loopId: string
  driver: string
  vault?: string
  providerOverride?: string | null
  modelIdOverride?: string
}): Promise<Record<string, string>> {
  const pCfg = await loadPersonalConfig(opts.driver, opts.vault)
  const wCfg = await loadConfig()
  const resolved = pickProvider(pCfg, wCfg, [opts.providerOverride], true)

  const env: Record<string, string> = {
    ...pCfg.vaultEnvs,
    CLAUDE_CONFIG_DIR: V_LOOP_CLAUDE(opts.loopId),
  }

  if (resolved) {
    env.ANTHROPIC_API_KEY = resolved.provider.apiKey
    env.ANTHROPIC_BASE_URL = resolved.provider.baseUrl
    // Per-tier / subagent models: written → pass native CC env; absent → CC defaults.
    const pv = resolved.provider
    if (pv.opus_model) env.ANTHROPIC_DEFAULT_OPUS_MODEL = pv.opus_model
    if (pv.sonnet_model) env.ANTHROPIC_DEFAULT_SONNET_MODEL = pv.sonnet_model
    if (pv.haiku_model) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = pv.haiku_model
    if (pv.agent_model) env.CLAUDE_CODE_SUBAGENT_MODEL = pv.agent_model
  }

  return env
}

/**
 * Build the `podman create` argv (after "podman create"). The container is
 * named, labeled with the loop id + a config-hash so we can detect spec
 * drift and recreate when needed.
 *
 * The image name comes from `opts.image` when provided (typically the
 * per-loop child image from ensureLoopImage); otherwise it defaults to
 * the base SANDBOX_IMAGE. Callers in the production path (ensureContainer)
 * always resolve via ensureLoopImage; tests that construct opts directly
 * get the base image without a build step.
 */
export async function buildPodmanCreateArgs(opts: ContainerOptions): Promise<string[]> {
  const mounts = await buildVolumeMounts(opts)
  const env = await buildContainerEnv(opts)
  const home = homedir()

  const args: string[] = [
    "--name", containerName(opts.loopId),
    // Self-heal a stale name collision (orphan with our name from a crash) so a
    // recreate doesn't loop on "name already in use" → 137; we own the name.
    "--replace",
    "--label", `${LABEL_LOOP}=${opts.loopId}`,
    "--label", `${LABEL_WORKSPACE}=${WORKSPACE}`,
    // --userns=keep-id:uid=2000,gid=2000 maps whatever uid is running
    // podman on the host → fixed container uid 2000. The image places
    // the `loopat` user at uid 2000, so `whoami` inside is always
    // "loopat" regardless of which host user owns the rootless daemon.
    //
    // File ownership across the boundary: container loopat ↔ host caller.
    // Files we write through bind mounts are owned by the host user (the
    // person who launched loopat), so they can manage them normally.
    //
    // Why not "USER root" instead: claude CLI refuses to run with
    // --dangerously-skip-permissions when uid == 0. loopat sandboxes use
    // bypassPermissions by default, so container-root is untenable for
    // the SDK driver.
    "--userns", "keep-id:uid=2000,gid=2000",
    // Init reaps zombies from orphaned bg processes.
    "--init",
    // Nested rootless podman: every sandbox can run podman without a
    // per-loop opt-in. --privileged is the only sustainable choice — a
    // precise cap set ends up chasing one new boundary per podman release
    // (NET_RAW for slirp, unmask for ro sysctls, ...). Tradeoff: outer
    // container loses kernel isolation, but the userns + bind-mount
    // boundary (uid 2000 ↔ host caller via keep-id) still constrains
    // host damage. Sandbox doctrine here is "containerized dev env",
    // not "untrusted-code prison". /dev/fuse is for the future switch
    // to fuse-overlayfs storage if vfs ever bites on disk pressure.
    "--privileged",
    "--device", "/dev/fuse",
    // Shared bridge network so the serve container can reach loop
    // containers by name (aardvark-dns). Outbound API calls via NAT.
    "--network", LOOPAT_NETWORK,
    // Reach the host's per-loop egress gateway (ANTHROPIC_BASE_URL) — claude
    // dials host.containers.internal:<port>. host-gateway maps it to the host.
    "--add-host", "host.containers.internal:host-gateway",
    "--hostname", `loop-${opts.loopId.slice(0, 8)}`,
    // Container cwd at creation; per-exec we override with -w.
    "--workdir", V_LOOP_WORKDIR(opts.loopId),
    // No interactive stdin / tty on the main process — it's just a sleeper.
  ]

  // Volumes.
  for (const m of mounts) {
    args.push("--volume", `${m.src}:${m.dst}${m.ro ? ":ro" : ""}`)
  }

  // Env.
  for (const [k, v] of Object.entries(env)) {
    args.push("--env", `${k}=${v}`)
  }

  // Ephemeral port publish. `-p :<inner>` tells podman to ask the kernel
  // for any free host port; query `podman port` after start to learn
  // which one. Different from the port-proxy path (which publishes the
  // whole range up front from a separate container) — here each loop
  // container directly owns its share port mapping.
  for (const ep of opts.ephemeralPorts ?? []) {
    const proto = ep.protocol === "udp" ? "/udp" : ""
    args.push("-p", `:${ep.internalPort}${proto}`)
  }

  const hash = hashCreateArgs(mounts, opts)
  args.push("--label", `${LABEL_CONFIG_HASH}=${hash}`)

  // Image + command tail. The image's CMD already runs `sleep infinity`, but
  // we pass it explicitly so a future image-CMD change can't accidentally
  // break the long-lived semantic.
  const image = opts.image ?? SANDBOX_IMAGE
  args.push(image, "/bin/sleep", "infinity")
  return args
}

/**
 * Config hash: covers mounts + loop-scoped opts. Deliberately EXCLUDES env
 * — env changes take effect on next session restart (podman exec --env),
 * not via container recreation. The container is a long-lived shell; env
 * is injected per-exec, matching CC's behavior where env changes need an
 * explicit restart to take effect.
 */
function hashCreateArgs(
  mounts: VolumeMount[],
  opts: ContainerOptions,
): string {
  const h = createHash("sha256")
  h.update("v1\n")
  h.update(`loop:${opts.loopId}\n`)
  h.update(`createdBy:${opts.createdBy}\n`)
  h.update(`vault:${opts.vaultName ?? ""}\n`)
  h.update(`knowledgeRw:${opts.knowledgeRw ? "1" : "0"}\n`)
  h.update(`mountAllLoops:${opts.mountAllLoops ? "1" : "0"}\n`)
  for (const m of [...mounts].sort((a, b) => a.dst.localeCompare(b.dst))) {
    h.update(`vol\t${m.src}\t${m.dst}\t${m.ro ? "ro" : "rw"}\n`)
  }
  for (const ep of [...(opts.ephemeralPorts ?? [])].sort((a, b) => a.internalPort - b.internalPort)) {
    h.update(`epport\t${ep.internalPort}\t${ep.protocol ?? "tcp"}\n`)
  }
  return h.digest("hex").slice(0, 16)
}

// ── podman binary wrapping ────────────────────────────────────────────────

const PODMAN_BIN = process.env.LOOPAT_PODMAN_BIN || "podman"

async function runPodman(
  args: string[],
  opts: { allowFail?: boolean; onLine?: (line: string) => void } = {},
): Promise<{ stdout: string, stderr: string, code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(PODMAN_BIN, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    const emit = (s: string) => {
      const trimmed = s.trim()
      if (trimmed) opts.onLine?.(trimmed)
    }
    child.stdout.on("data", (b: Buffer) => {
      const s = b.toString()
      stdout += s
      const lines = s.split("\n")
      for (const line of lines.slice(0, -1)) emit(line)
    })
    child.stderr.on("data", (b: Buffer) => {
      const s = b.toString()
      stderr += s
      const lines = s.split("\n")
      for (const line of lines.slice(0, -1)) emit(line)
    })
    child.on("error", (e: any) => {
      if (e?.code === "ENOENT") {
        reject(new Error(`podman binary not found (looked for "${PODMAN_BIN}"); install with: sudo apt install podman uidmap fuse-overlayfs`))
      } else {
        reject(e)
      }
    })
    child.on("exit", (code) => {
      const result = { stdout, stderr, code: code ?? -1 }
      if (code === 0 || opts.allowFail) {
        resolve(result)
      } else {
        const err: any = new Error(`podman ${args[0]} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`)
        err.result = result
        reject(err)
      }
    })
  })
}

export type PodmanProbeResult = {
  ok: boolean
  version?: string
  hint?: string
}

export async function probePodman(): Promise<PodmanProbeResult> {
  try {
    const { stdout } = await runPodman(["--version"])
    const version = stdout.trim()
    return { ok: true, version }
  } catch (e: any) {
    return {
      ok: false,
      hint: e?.message?.includes("not found")
        ? "install with: sudo apt install podman uidmap fuse-overlayfs"
        : `podman probe failed: ${e?.message ?? e}`,
    }
  }
}

/**
 * Ensure the loopat-sandbox base image exists in podman's local store. If
 * missing, build it from server/templates/sandbox/Containerfile. The
 * Containerfile is FROM Aliyun AC2 Ubuntu 24.04 + apt-installs basic shell
 * tools; the first build pulls the base (~104MB) from the AC2 registry
 * (anonymous, China-reachable — docker.io is not), subsequent
 * `ensureContainer` calls reuse the cached image.
 *
 * Concurrency: build is idempotent at podman's layer cache, but we still
 * guard with a per-process Promise so two simultaneous ensureContainer
 * calls don't fire two builds.
 */
/** Hash the base Containerfile content. Used both as the tag suffix for
 *  the base image itself and mixed into per-loop child image tags so that
 *  base-image changes (e.g. apt installs added to the Containerfile) cascade
 *  through and invalidate stale child images.
 */
export async function baseContainerfileHash(): Promise<string> {
  const dir = join(LOOPAT_INSTALL_DIR, "server", "templates", "sandbox")
  const containerfile = join(dir, "Containerfile")
  if (!existsSync(containerfile)) {
    throw new Error(`Containerfile not found at ${containerfile}`)
  }
  const h = createHash("sha256").update(await readFile(containerfile, "utf8"))
  // Files COPY'd by the Containerfile also affect the image — hash them too so
  // editing the forwarder rebuilds the base image.
  const forwarder = join(dir, "loopat-host")
  if (existsSync(forwarder)) h.update(await readFile(forwarder, "utf8"))
  return h.digest("hex").slice(0, 16)
}

let _imageBuildInFlight: Promise<void> | null = null
export async function ensureSandboxImage(opts?: { onProgress?: (msg: string) => void }): Promise<void> {
  if (_imageBuildInFlight) return _imageBuildInFlight
  _imageBuildInFlight = withSpan("ensureSandboxImage", async (span) => {
    const containerfile = join(LOOPAT_INSTALL_DIR, "server", "templates", "sandbox", "Containerfile")
    if (!existsSync(containerfile)) {
      throw new Error(`Cannot build sandbox image: Containerfile not found at ${containerfile}`)
    }

    // Hash the Containerfile so the base image auto-rebuilds when it changes.
    const hash = await baseContainerfileHash()
    const hashTag = `loopat-sandbox-${hash}:latest`

    const present = await runPodman(["image", "exists", hashTag], { allowFail: true })
    if (present.code === 0) {
      // Re-tag so the unversioned SANDBOX_IMAGE name always points at the
      // latest built version.
      await runPodman(["tag", hashTag, SANDBOX_IMAGE], { allowFail: true })
      span.setAttribute("sandbox.image.source", "cached")
      return
    }

    // Fast path: pull the prebuilt image CI published for this exact
    // Containerfile (content-hash tag). On success, tag it as both the hashTag
    // (so the next boot's existence check above short-circuits) and the
    // unversioned SANDBOX_IMAGE. Only fall back to a local build if the pull
    // fails — ghcr unreachable on this network, or a modified Containerfile
    // whose hash was never published.
    const remoteRef = `${SANDBOX_IMAGE_REF}:${hash}`
    console.log(`[podman] pulling prebuilt sandbox image ${remoteRef}`)
    opts?.onProgress?.("Pulling prebuilt sandbox image…")
    const pulled = await runPodman(["pull", remoteRef], { allowFail: true })
    if (pulled.code === 0) {
      await runPodman(["tag", remoteRef, hashTag], { allowFail: true })
      await runPodman(["tag", remoteRef, SANDBOX_IMAGE], { allowFail: true })
      span.setAttribute("sandbox.image.source", "pulled")
      console.log(`[podman] sandbox image ready (pulled ${remoteRef})`)
      return
    }
    console.log(`[podman] prebuilt image unavailable — building sandbox image ${SANDBOX_IMAGE} locally (may take a few minutes)`)
    opts?.onProgress?.("Building sandbox environment…")

    // Stream build output, parsing STEP lines into progress messages.
    const buildDir = join(LOOPAT_INSTALL_DIR, "server", "templates", "sandbox")
    let lastStep = ""
    const r = await runPodman(
      ["build", "-t", SANDBOX_IMAGE, "-t", hashTag, "--label", `${LABEL_WORKSPACE}=${WORKSPACE}`, "-f", containerfile, buildDir],
      {
        onLine: (line) => {
          const m = line.match(/^STEP\s+(\d+)\/(\d+):\s+(.+)/)
          if (m) {
            lastStep = descStep(m[3])
            opts?.onProgress?.(`Building sandbox: ${lastStep} (step ${m[1]}/${m[2]})`)
          }
        },
      },
    )
    if (r.code !== 0) {
      throw new Error(`sandbox image build failed: ${r.stderr || r.stdout}`)
    }
    span.setAttribute("sandbox.image.source", "built")
    console.log(`[podman] sandbox image ready`)
  })
  try {
    await _imageBuildInFlight
  } finally {
    _imageBuildInFlight = null
  }
}

/** Translate a podman build STEP instruction into a short human label. */
function descStep(instruction: string): string {
  const lower = instruction.toLowerCase()
  if (lower.startsWith("from ")) return "base image"
  if (lower.includes("apt-get")) return "system packages"
  if (lower.includes("userdel") || lower.includes("useradd") || lower.includes("groupadd")) return "user setup"
  if (lower.includes("curl") && lower.includes("mise")) return "mise tool manager"
  if (lower.includes("mkdir") && lower.includes("loopat-mise")) return "mise directories"
  if (lower.startsWith("env ")) return "environment"
  if (lower.startsWith("user ")) return "user"
  if (lower.startsWith("copy ")) return "copying config"
  if (lower.startsWith("run ")) return "running setup"
  if (lower.startsWith("cmd ")) return "entrypoint"
  return "building"
}

/**
 * Per-loop warning state set by ensureLoopImage when toolchain baking
 * fails. Read by attachTerm (term.ts) to surface a yellow banner in the
 * PTY so the user knows their mise.toml is broken — without losing the
 * loop entirely (we fall back to the base image and keep going).
 */
const _loopWarnings = new Map<string, string>()
export function getLoopWarning(loopId: string): string | undefined {
  return _loopWarnings.get(loopId)
}

/**
 * Ensure a per-loop image exists for this loop's composed mise.toml,
 * returning its tag. Behavior:
 *   - no mise.toml (or empty) → base SANDBOX_IMAGE
 *   - mise.toml present, build OK → loopat-sandbox-<hash>:latest, clear any
 *     prior warning for this loop
 *   - mise.toml present, build FAILS → log error, stash a per-loop warning,
 *     fall back to base SANDBOX_IMAGE so the loop still starts. The PTY
 *     surfaces the warning on attach; the user can fix mise.toml and
 *     restart the loop to re-attempt.
 *
 * The tag is `loopat-sandbox-<sha256-of-mise.toml-content>:latest`, so two
 * loops with the same toolchain spec share an image (and the build's mise
 * install layer caches via podman layer cache). Concurrent builds of the
 * same tag are coalesced via _loopImageInFlight.
 */
const _loopImageInFlight = new Map<string, Promise<string>>()
export async function ensureLoopImage(loopId: string, opts?: { onProgress?: (msg: string) => void }): Promise<string> {
  await ensureSandboxImage(opts)

  const miseTomlPath = join(loopClaudeDir(loopId), "mise.toml")
  if (!existsSync(miseTomlPath)) {
    _loopWarnings.delete(loopId)
    return SANDBOX_IMAGE
  }
  const content = await readFile(miseTomlPath, "utf8")
  if (!content.trim()) {
    _loopWarnings.delete(loopId)
    return SANDBOX_IMAGE
  }

  // Hash both mise.toml AND the base Containerfile so that base-image
  // changes (apt installs added, configs changed) cascade into a fresh
  // child build. Without the base part, child images stay frozen against
  // an old base layer set even after `loopat-sandbox:latest` is rebuilt
  // — silent skew that has bitten us (e.g. podman missing from loops
  // after the nested-podman base change shipped).
  const baseHash = await baseContainerfileHash()
  const hash = createHash("sha256").update(`base:${baseHash}\n`).update(content).digest("hex").slice(0, 16)
  const tag = `loopat-sandbox-${hash}:latest`

  const existing = _loopImageInFlight.get(tag)
  if (existing) return existing

  const built = withSpan("ensureLoopImage", async (span) => {
    span.setAttribute("loop.id", loopId.slice(0, 8))
    const present = await runPodman(["image", "exists", tag], { allowFail: true })
    if (present.code === 0) {
      span.setAttribute("loop.image.source", "cached")
      _loopWarnings.delete(loopId)
      return tag
    }

    console.log(`[podman] building loop image ${tag} for loop ${loopId.slice(0, 8)}`)
    opts?.onProgress?.("Installing tools from mise.toml…")
    const buildDir = await mkdtemp(join(tmpdir(), "loopat-img-"))
    try {
      // A loopat-native `[host]` table declares host-only clis (macOS /
      // machine-bound) the sandbox can't run natively. We bake a forwarding
      // shim per cli into the image's mise shims dir (already first on PATH),
      // and strip the table before mise sees it — mise would reject the
      // unknown table. The shim just hands off to `loopat-host` (in the base
      // image) → mounted socket → host execFile. See host-exec.ts.
      let hostClis: string[] = []
      let miseConfig = content
      try {
        const parsed: any = tomlParse(content)
        if (parsed && Array.isArray(parsed.host?.clis)) {
          hostClis = parsed.host.clis.filter((x: unknown): x is string => typeof x === "string" && !!x)
        }
        if (parsed && "host" in parsed) {
          const { host: _host, ...rest } = parsed
          miseConfig = tomlStringify(rest)
        }
      } catch {}
      await writeFile(join(buildDir, "mise.toml"), miseConfig)
      // Override `mise trust` interactively by marking the config path
      // trusted via env. `mise install -y` installs everything in
      // mise.toml; `mise reshim` ensures /opt/loopat-mise/shims/ has a
      // shim for every tool.
      const lines = [
        `FROM ${SANDBOX_IMAGE}`,
        `COPY mise.toml /opt/loopat-mise/config/config.toml`,
        `RUN MISE_TRUSTED_CONFIG_PATHS=/opt/loopat-mise/config/config.toml \\`,
        `    mise install -y \\`,
        ` && MISE_TRUSTED_CONFIG_PATHS=/opt/loopat-mise/config/config.toml \\`,
        `    mise reshim`,
      ]
      if (hostClis.length) {
        // Generate the shims into the build context, then COPY them in AFTER
        // reshim so mise's own reshim can't clobber them.
        await writeHostShims(join(buildDir, "host-bin"), hostClis)
        lines.push(`COPY host-bin/ /opt/loopat-mise/shims/`)
      }
      const childContainerfile = lines.join("\n") + "\n"
      await writeFile(join(buildDir, "Containerfile"), childContainerfile)

      const r = await runPodman(
        ["build", "-t", tag, "--label", `${LABEL_WORKSPACE}=${WORKSPACE}`, "-f", join(buildDir, "Containerfile"), buildDir],
        {
          allowFail: true,
          onLine: (line) => {
            const m = line.match(/^STEP\s+(\d+)\/(\d+):\s+(.+)/)
            if (m) {
              opts?.onProgress?.(`Installing tools: ${descStep(m[3])} (step ${m[1]}/${m[2]})`)
            }
          },
        },
      )
      if (r.code !== 0) {
        // Don't throw — fall back to base so the loop still starts. The
        // user can inspect via terminal, fix mise.toml, and restart.
        const detail = (r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" | ").slice(0, 400)
        const msg = `toolchain build failed — sandbox started without baked tools. mise install rejected ${miseTomlPath}: ${detail}`
        console.error(`[podman] ${msg}`)
        _loopWarnings.set(loopId, msg)
        return SANDBOX_IMAGE
      }
      span.setAttribute("loop.image.source", "built")
      console.log(`[podman] loop image ${tag} ready`)
      _loopWarnings.delete(loopId)
    } finally {
      await rm(buildDir, { recursive: true, force: true }).catch(() => {})
    }
    return tag
  })
  _loopImageInFlight.set(tag, built)
  try {
    return await built
  } finally {
    _loopImageInFlight.delete(tag)
  }
}

type ContainerInspectRow = {
  exists: boolean
  running: boolean
  configHash?: string
  imageId?: string
}

async function inspectContainer(loopId: string): Promise<ContainerInspectRow> {
  const name = containerName(loopId)
  const r = await runPodman(
    ["inspect", "--format", "{{.State.Running}}|{{index .Config.Labels \"" + LABEL_CONFIG_HASH + "\"}}|{{.Image}}", name],
    { allowFail: true },
  )
  if (r.code !== 0) return { exists: false, running: false }
  const [running, configHash, imageId] = r.stdout.trim().split("|")
  return {
    exists: true,
    running: running === "true",
    configHash: configHash === "<no value>" || configHash === "" ? undefined : configHash,
    imageId: imageId === "<no value>" || imageId === "" ? undefined : imageId,
  }
}

export async function containerExists(loopId: string): Promise<boolean> {
  return (await inspectContainer(loopId)).exists
}

export async function containerRunning(loopId: string): Promise<boolean> {
  return (await inspectContainer(loopId)).running
}

/** Return the container's bridge network IP, or null if not running. */
export async function getContainerIP(loopId: string): Promise<string | null> {
  const name = containerName(loopId)
  const r = await runPodman(
    ["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", name],
    { allowFail: true },
  )
  if (r.code !== 0) return null
  const ip = r.stdout.trim()
  if (!ip || ip === "<no value>") return null
  return ip
}

/** Look up the actual host port for an ephemeral `-p :<inner>` mapping.
 *
 * `podman port <ct> <inner>/<proto>` prints lines like `0.0.0.0:44513`.
 * Returns the first numeric port, or null if the container isn't running
 * or doesn't have a mapping for that internal port. Cheap (~ms), so we
 * call it on demand from the API rather than caching aggressively — the
 * mapping changes only when the container is recreated.
 */
export async function getEphemeralHostPort(
  loopId: string,
  internalPort: number,
  protocol: "tcp" | "udp" = "tcp",
): Promise<number | null> {
  const name = containerName(loopId)
  const r = await runPodman(
    ["port", name, `${internalPort}/${protocol}`],
    { allowFail: true },
  )
  if (r.code !== 0) return null
  // First line is the v4 binding (e.g. "0.0.0.0:44513"); take it.
  const first = r.stdout.split("\n").find((l) => l.trim().length > 0) ?? ""
  const m = first.trim().match(/:(\d+)$/)
  if (!m) return null
  const port = Number(m[1])
  return Number.isFinite(port) && port > 0 ? port : null
}

// Per-workspace network (+ loopat.workspace label) so parallel LOOPAT_HOMEs
// stay isolated and `uninstall` removes only its own.
const LOOPAT_NETWORK = `loopat-${WORKSPACE}`
const SERVE_CONTAINER = `loopat-${WORKSPACE}-serve`

let _networkReady = false
let _serveReady: Promise<void> | null = null

/** Ensure the shared bridge network exists so containers can reach each other. */
export async function ensureLoopatNetwork(): Promise<void> {
  if (_networkReady) return
  const r = await runPodman(["network", "exists", LOOPAT_NETWORK], { allowFail: true })
  if (r.code !== 0) {
    console.log(`[podman] creating network ${LOOPAT_NETWORK}`)
    const create = await runPodman(["network", "create", "--label", `${LABEL_WORKSPACE}=${WORKSPACE}`, LOOPAT_NETWORK])
    if (create.code !== 0) {
      throw new Error(`Failed to create podman network ${LOOPAT_NETWORK}: ${create.stderr}`)
    }
  }
  _networkReady = true
}

/** Ensure the workspace serve container is running on the shared network. */
export async function ensureServeContainer(): Promise<void> {
  if (_serveReady) return _serveReady
  _serveReady = (async () => {
    const cfg = await loadConfig()
    const enabled = cfg.serveEnabled ?? true // default on for backward compat

    // Check current container state
    const cur = await runPodman(
      ["inspect", "--format", "{{.State.Running}}", SERVE_CONTAINER],
      { allowFail: true },
    )

    if (!enabled) {
      // Disabled — stop and remove if exists
      if (cur.code === 0) {
        console.log(`[podman] serve disabled, removing serve container`)
        await runPodman(["stop", "--time", "5", SERVE_CONTAINER], { allowFail: true })
        await runPodman(["rm", "--force", SERVE_CONTAINER], { allowFail: true })
      }
      _serveReady = null
      return
    }

    await ensureLoopatNetwork()
    await ensureSandboxImage()

    if (cur.code === 0 && cur.stdout.trim() === "true") {
      _serveReady = null
      return
    }

    if (cur.code === 0) {
      // Exists but not running — start it
      console.log(`[podman] starting serve container`)
      await runPodman(["start", SERVE_CONTAINER])
      _serveReady = null
      return
    }

    // Create the serve container
    console.log(`[podman] creating serve container on network ${LOOPAT_NETWORK}`)
    const serveBinary = join(LOOPAT_INSTALL_DIR, "server", "src", "serve-rs", "target", "release", "loopat-serve")
    if (!existsSync(serveBinary)) {
      _serveReady = null
      throw new Error(`serve binary not found at ${serveBinary}. Run: cd server/src/serve-rs && cargo build --release`)
    }

    const createArgs = [
      "--name", SERVE_CONTAINER,
      "--network", LOOPAT_NETWORK,
      "--hostname", "loopat-serve",
      "--volume", `${loopsDir()}:/loopat/loops:ro`,
      "--volume", `${serveBinary}:/usr/local/bin/loopat-serve:ro`,
      "-p", `${SERVE_HOST}:${SERVE_PORT}:7788`,
      "-e", `LOOPAT_WORKSPACE=${WORKSPACE}`,
      "-e", `LOOPAT_LOOPS_DIR=/loopat/loops`,
      "--init",
      SANDBOX_IMAGE,
      "/usr/local/bin/loopat-serve",
    ]
    const r = await runPodman(["create", ...createArgs])
    if (r.code !== 0) {
      _serveReady = null
      throw new Error(`serve container create failed: ${r.stderr}`)
    }
    await runPodman(["start", SERVE_CONTAINER])
    console.log(`[podman] serve container ready on port ${SERVE_PORT}`)
  })()
  try {
    await _serveReady
  } finally {
    _serveReady = null
  }
}

const PORT_PROXY_CONTAINER = `loopat-${WORKSPACE}-port-proxy`

let _portProxyReady: Promise<void> | null = null

/** Find occupied TCP ports in a range.
 *
 * Uses `ss` instead of `lsof`: unprivileged `lsof` only sees sockets owned
 * by the current user, so cross-user services (ollama, system dashboards,
 * other devs on a shared box) get missed and the port-proxy container
 * fails to start with `bind: address already in use`. `ss` reads from
 * /proc/net/tcp directly and shows every listening socket on the host,
 * which is what we actually need to know when picking host ports to
 * publish.
 */
function findOccupiedPorts(lo: number, hi: number): Set<number> {
  const ports = new Set<number>()
  const { execFileSync } = require("node:child_process")
  const add = (port: number) => { if (port >= lo && port <= hi) ports.add(port) }
  // Linux: ss reads /proc/net/tcp (every listening socket).
  try {
    const out = execFileSync("ss", ["-tlnH"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }) as string
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 4) continue
      const addr = parts[3] // "0.0.0.0:8080" | "[::]:8080" | "127.0.0.1:8080"
      const colonIdx = addr.lastIndexOf(":")
      if (colonIdx !== -1) add(Number(addr.slice(colonIdx + 1)))
    }
    return ports
  } catch {}
  // macOS (no ss): lsof. NAME column looks like "*:8080" or "127.0.0.1:8080 (LISTEN)".
  try {
    const out = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }) as string
    for (const line of out.split("\n")) {
      const m = line.match(/:(\d+)\s*\(LISTEN\)/)
      if (m) add(Number(m[1]))
    }
  } catch {}
  return ports
}

/** Build port-proxy create args, excluding occupiedPorts from the -p range. */
function buildPortProxyCreateArgs(binary: string, portRange: string, occupiedPorts: Set<number>): string[] {
  const [lo, hi] = portRange.split("-").map(Number)
  const publishArgs: string[] = []
  for (let p = lo; p <= hi; p++) {
    if (!occupiedPorts.has(p)) {
      publishArgs.push("-p", `0.0.0.0:${p}:${p}`)
    }
  }
  return [
    "--name", PORT_PROXY_CONTAINER,
    "--network", LOOPAT_NETWORK,
    "--hostname", "loopat-port-proxy",
    "--volume", `${loopsDir()}:/loopat/loops:ro`,
    "--volume", `${binary}:/usr/local/bin/loopat-port-proxy:ro`,
    ...publishArgs,
    "-e", `LOOPAT_WORKSPACE=${WORKSPACE}`,
    "-e", `LOOPAT_LOOPS_DIR=/loopat/loops`,
    "--init",
    SANDBOX_IMAGE,
    "/usr/local/bin/loopat-port-proxy",
  ]
}

/** Ensure the port-proxy container is running for direct TCP/UDP forwarding. */
export async function ensurePortProxyContainer(): Promise<void> {
  if (_portProxyReady) return _portProxyReady
  _portProxyReady = (async () => {
    const cfg = await loadConfig()
    const enabled = cfg.serveDynamicEnabled ?? false
    const portRange = cfg.serveDynamicPortRange || (process.env.LOOPAT_EXTERNAL_PORT_RANGE ?? "10000-20000")

    const cur = await runPodman(
      ["inspect", "--format", "{{.State.Running}}", PORT_PROXY_CONTAINER],
      { allowFail: true },
    )

    if (!enabled) {
      if (cur.code === 0) {
        console.log(`[podman] dynamic port disabled, removing port-proxy container`)
        await runPodman(["stop", "--time", "5", PORT_PROXY_CONTAINER], { allowFail: true })
        await runPodman(["rm", "--force", PORT_PROXY_CONTAINER], { allowFail: true })
      }
      _portProxyReady = null
      return
    }

    await ensureLoopatNetwork()
    await ensureSandboxImage()

    if (cur.code === 0 && cur.stdout.trim() === "true") {
      _portProxyReady = null
      return
    }

    if (cur.code === 0) {
      // Exists but not running. Try start first, but if it fails with a
      // port conflict, fall through to recreate without occupied ports.
      const startR = await runPodman(["start", PORT_PROXY_CONTAINER], { allowFail: true })
      if (startR.code === 0) {
        _portProxyReady = null
        return
      }
      if (/(bind|address already in use|rootlessport)/i.test(startR.stderr + startR.stdout)) {
        console.log(`[podman] existing port-proxy container has port conflicts — recreating`)
        await runPodman(["rm", "--force", PORT_PROXY_CONTAINER], { allowFail: true })
      } else {
        _portProxyReady = null
        throw new Error(`port-proxy start failed: ${startR.stderr || startR.stdout}`)
      }
    }

    const binary = join(LOOPAT_INSTALL_DIR, "server", "src", "port-proxy-rs", "target", "release", "loopat-port-proxy")
    if (!existsSync(binary)) {
      _portProxyReady = null
      throw new Error(`port-proxy binary not found at ${binary}. Run: cd server/src/port-proxy-rs && cargo build --release`)
    }

    // Use lsof to find ports already in use, then exclude them from -p.
    // The port-proxy inside uses inotify for dynamic listener lifecycle —
    // no container restart needed when shareExternalPort configs change.
    const [lo, hi] = portRange.split("-").map(Number)
    if (!lo || !hi || lo >= hi) {
      _portProxyReady = null
      throw new Error(`invalid port range: ${portRange}`)
    }
    const occupied = findOccupiedPorts(lo, hi)
    if (occupied.size > 0) console.log(`[podman] ${occupied.size} port(s) in ${portRange} already in use — skipping`)

    const args = buildPortProxyCreateArgs(binary, portRange, occupied)
    const createR = await runPodman(["create", ...args])
    if (createR.code !== 0) {
      _portProxyReady = null
      throw new Error(`port-proxy container create failed: ${createR.stderr}`)
    }
    const startR = await runPodman(["start", PORT_PROXY_CONTAINER])
    if (startR.code !== 0) {
      _portProxyReady = null
      throw new Error(`port-proxy start failed: ${startR.stderr}`)
    }
    const mapped = (hi - lo + 1) - occupied.size
    console.log(`[podman] port-proxy container ready (${mapped} ports in ${portRange})`)
  })()
  try {
    await _portProxyReady
  } finally {
    _portProxyReady = null
  }
}

const SERVE_HOST = process.env.LOOPAT_SERVE_HOST ?? "127.0.0.1"
const SERVE_PORT = Number(process.env.LOOPAT_SERVE_PORT ?? 7788)

/**
 * Lock down the vault `.ssh` perms RIGHT BEFORE the container that bind-mounts
 * it starts. The vault's `.ssh` is git-crypt-decrypted / git-checked-out, so its
 * private key lands at the umask default (0664) and the dir at 0775 — and git
 * can't carry 0600 (it only tracks the exec bit). loops.ts chmods the key 0600
 * "at point of use" host-side, but that only runs when a HOST git op goes through
 * sshCommandForUser; a container that's created/recreated on a path that didn't
 * (server restart → first attach, config/image-drift recreate) would bind-mount
 * a stale-perms key. ssh then ignores the key (or rejects it under StrictModes)
 * and the FIRST sandbox ssh fails `Permission denied (publickey)`; a later op
 * that re-chmods host-side makes the retry succeed — exactly the intermittent
 * we saw. Do it here, in the one chokepoint every container start passes
 * through, so the perms are correct the instant the bind goes live. Cheap +
 * idempotent; best-effort (a missing vault is fine — the mount just won't exist).
 */
export async function ensureSandboxSshPerms(user: string, vault: string): Promise<void> {
  const sshDir = join(personalVaultMountsHomeDir(user, vault), ".ssh")
  if (!existsSync(sshDir)) return
  try {
    await chmod(sshDir, 0o700).catch(() => {})
    for (const name of readdirSync(sshDir)) {
      const p = join(sshDir, name)
      try {
        if (!statSync(p).isFile()) continue
      } catch { continue }
      // Private keys MUST be 0600 (id_*, *_rsa/_ed25519/_ecdsa with no .pub) and
      // `config` MUST NOT be group/world-writable or ssh silently ignores it.
      // .pub / known_hosts are fine readable; clamp them to 0644 to be safe.
      const isPub = name.endsWith(".pub")
      const isPrivKey = !isPub && /^id_|_rsa$|_ed25519$|_ecdsa$|_dsa$|^identity$/.test(name)
      if (name === "config" || isPrivKey) {
        await chmod(p, 0o600).catch(() => {})
      } else {
        await chmod(p, 0o644).catch(() => {})
      }
    }
  } catch {}
}

/**
 * Idempotent: bring the container to "running with current config".
 *   - missing       → podman create + start
 *   - stopped, hash matches → start
 *   - stopped, hash drift   → rm + create + start
 *   - running, hash matches → no-op
 *   - running, hash drift   → stop + rm + create + start
 */
export async function ensureContainer(opts: ContainerOptions, progress?: { onProgress?: (msg: string) => void }): Promise<void> {
  return withSpan("ensureContainer", async (span) => {
  span.setAttribute("loop.id", opts.loopId.slice(0, 8))
  await ensureLoopatNetwork()
  // Deterministically fix the vault ssh-key perms BEFORE the container that
  // bind-mounts them starts, so the first in-sandbox ssh authenticates reliably
  // regardless of how/when the key was git-checked-out (see ensureSandboxSshPerms).
  await ensureSandboxSshPerms(opts.createdBy, opts.vaultName?.trim() || DEFAULT_VAULT)
  // Resolve the image first — for loops with a composed mise.toml this
  // builds (or reuses) a per-loop child image with toolchains baked in.
  // For loops without mise.toml, this returns the base SANDBOX_IMAGE.
  const image = opts.image ?? (await ensureLoopImage(opts.loopId, progress))
  const resolvedOpts: ContainerOptions = { ...opts, image }

  // Pre-create every bind-destination's parent dir on the host. Otherwise
  // podman auto-creates them at container start as root-in-userns, which
  // maps to subuid 100000 outside — and then the host user can't delete
  // them. The bind targets under V_HOME (e.g. .claude/plugins/) and the
  // host-upper itself are the typical culprits.
  await mkdir(loopHomeUpper(opts.loopId), { recursive: true })
  await mkdir(join(loopHomeUpper(opts.loopId), ".claude", "plugins"), { recursive: true })
  await mkdir(join(loopHomeUpper(opts.loopId), ".local", "share"), { recursive: true })
  await mkdir(loopDir(opts.loopId), { recursive: true })

  const createArgs = await buildPodmanCreateArgs(resolvedOpts)
  // Extract hash from the args we just built.
  const hashIdx = createArgs.findIndex((a, i) =>
    createArgs[i - 1] === "--label" && a.startsWith(`${LABEL_CONFIG_HASH}=`),
  )
  const desiredHash = hashIdx >= 0 ? createArgs[hashIdx].split("=")[1] : ""

  // Include image ID in the drift check so a rebuilt image (mise tools
  // added, base layer changed, etc.) triggers container recreation even
  // when the config hash hasn't changed.
  const curImageId = (await runPodman(["image", "inspect", "--format", "{{.Id}}", image])).stdout.trim()

  const cur = await inspectContainer(opts.loopId)
  if (cur.running && cur.configHash === desiredHash && cur.imageId === curImageId) {
    span.setAttribute("container.action", "noop")
    return
  }
  const tag = opts.loopId.slice(0, 8)
  if (cur.exists) {
    if (cur.configHash !== desiredHash || cur.imageId !== curImageId) {
      // Spec or image drift — container has to be torn down and recreated.
      // This kills any process exec'd into the old container (PTY shells, an
      // active claude CLI). Log loudly so the cause is obvious if the user
      // reports "my terminal disconnected when I sent a chat".
      const reason = cur.configHash !== desiredHash ? "config hash drift" : "image drift (rebuilt)"
      console.warn(`[podman:${tag}] ${reason} — recreating container; any in-flight exec'd processes will be killed`)
      if (cur.running) await runPodman(["stop", "--time", "5", containerName(opts.loopId)])
      await runPodman(["rm", "--force", containerName(opts.loopId)])
    } else {
      // Hash matches; just (re)start.
      console.log(`[podman:${tag}] restarting stopped container`)
      await runPodman(["start", containerName(opts.loopId)])
      return
    }
  }
  console.log(`[podman:${tag}] creating + starting container (hash=${desiredHash})`)
  progress?.onProgress?.("Creating sandbox container…")
  await runPodman(["create", ...createArgs])
  progress?.onProgress?.("Starting sandbox container…")
  await runPodman(["start", containerName(opts.loopId)])
  }) // end withSpan("ensureContainer")
}

export async function stopContainer(loopId: string): Promise<void> {
  const r = await runPodman(["stop", "--time", "5", containerName(loopId)], { allowFail: true })
  if (r.code !== 0 && !r.stderr.includes("no such container")) {
    console.warn(`[podman] stop ${loopId} non-zero exit (${r.code}): ${r.stderr.trim()}`)
  }
}

export async function removeContainer(loopId: string): Promise<void> {
  await runPodman(["rm", "--force", containerName(loopId)], { allowFail: true })
}

/**
 * Stop ALL loopat containers for this workspace. Called on server shutdown
 * so the host isn't left with hundreds of idle sandbox containers.
 */
export async function stopAllWorkspaceContainers(): Promise<void> {
  const r = await runPodman(
    ["ps", "--all", "--filter", `label=${LABEL_WORKSPACE}=${WORKSPACE}`, "--format", "{{.Names}}"],
    { allowFail: true },
  )
  if (r.code !== 0) return
  const names = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean)
  await Promise.all(names.map((n) => runPodman(["stop", "--time", "5", n], { allowFail: true })))
}

// ── idle stop scheduler ───────────────────────────────────────────────────
// Each loop can have multiple activity "sources" — e.g. "sdk" (active SDK
// session) and "pty" (active terminal subscribers). The container stays up
// as long as ANY source is active. When the last source goes inactive, we
// arm an idle timer; if no source re-activates within the window, we
// `podman stop` the container so the namespace + overlay get released.
// User-launched background daemons (e.g. nohup server.py &) that linger
// past all SDK/PTY sources WILL be killed when idle stop fires — this is
// the explicit v1 trade-off (consistent with "idle = sandbox dies").

function containerIdleMs(): number {
  // Read env each call so tests can override per-spec (paths.ts captures
  // its env at module load, but lifecycle timing is OK to re-read).
  return Number(process.env.LOOPAT_CONTAINER_IDLE_MS) || 30 * 60 * 1000
}

type ActivityRegistry = {
  /** Per-loop set of active source ids. Empty / missing = nothing active. */
  active: Map<string, Set<string>>
  /** Per-loop idle timer; clears when any source becomes active again. */
  idleTimers: Map<string, ReturnType<typeof setTimeout>>
}

const registry: ActivityRegistry = {
  active: new Map(),
  idleTimers: new Map(),
}

export function markActive(loopId: string, source: string): void {
  let set = registry.active.get(loopId)
  if (!set) {
    set = new Set()
    registry.active.set(loopId, set)
  }
  set.add(source)
  const t = registry.idleTimers.get(loopId)
  if (t) {
    clearTimeout(t)
    registry.idleTimers.delete(loopId)
  }
}

export function markInactive(loopId: string, source: string): void {
  const set = registry.active.get(loopId)
  if (set) {
    set.delete(source)
    if (set.size === 0) registry.active.delete(loopId)
  }
  // If anything else is still active, no idle timer needed.
  if ((registry.active.get(loopId)?.size ?? 0) > 0) return
  scheduleIdleStop(loopId)
}

function scheduleIdleStop(loopId: string): void {
  const existing = registry.idleTimers.get(loopId)
  if (existing) clearTimeout(existing)
  const t = setTimeout(async () => {
    registry.idleTimers.delete(loopId)
    // Re-check: someone may have grabbed activity between scheduling and firing.
    if ((registry.active.get(loopId)?.size ?? 0) > 0) return
    try {
      await stopContainer(loopId)
      console.log(`[podman] idle-stopped container for loop ${loopId.slice(0, 8)}`)
    } catch (e: any) {
      console.warn(`[podman] idle stop failed for loop ${loopId.slice(0, 8)}: ${e?.message ?? e}`)
    }
  }, containerIdleMs())
  registry.idleTimers.set(loopId, t)
}

/** Test-only helper: clear all activity state + timers. */
export function _resetActivityRegistryForTests(): void {
  for (const t of registry.idleTimers.values()) clearTimeout(t)
  registry.idleTimers.clear()
  registry.active.clear()
}

/** Test-only: read current active sources for a loop. */
export function _getActiveSourcesForTests(loopId: string): string[] {
  return [...(registry.active.get(loopId) ?? [])]
}

// ── exec into the container ───────────────────────────────────────────────

export type ExecOptions = {
  loopId: string
  command: string
  args: string[]
  env?: Record<string, string>
  tty?: boolean
  interactive?: boolean
  workdir?: string
}

/**
 * Build the `podman exec` argv (after "podman exec"). Pure: no I/O. Caller
 * spawns "podman" with the returned args.
 *
 * Note: when both `interactive` and `tty` are set, callers typically use
 * bun-pty to provide a real PTY master; podman exec passes through.
 */
export function buildPodmanExecArgs(opts: ExecOptions): string[] {
  const args: string[] = ["exec"]
  if (opts.interactive) args.push("--interactive")
  if (opts.tty) args.push("--tty")
  if (opts.workdir) args.push("--workdir", opts.workdir)
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push("--env", `${k}=${v}`)
  }
  args.push(containerName(opts.loopId), opts.command, ...opts.args)
  return args
}
