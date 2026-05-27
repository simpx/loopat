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
 *     server/templates/sandbox/Containerfile (FROM ubuntu:24.04 + bash +
 *     coreutils + util-linux + procps + less). Keeps the image small + boring
 *     — every "heavy" tool (claude binary, node, mise, host caches) is bound
 *     in from the host at container-create time via --volume. Glibc inside
 *     the image matches the host (both Ubuntu 24.04 lineage), so host-built
 *     binaries Just Work.
 *   - --network host (v1): API calls work zero-config; port collisions across
 *     loops are not yet isolated. Future: --network slirp4netns + per-loop
 *     netns.
 *   - --userns=keep-id: host uid is mapped to the same uid inside, so files
 *     created by the AI are owned by the user on the host too. Rootless
 *     subuid/subgid mappings (see /etc/subuid) make this work.
 *   - --init: podman auto-injects catatonit (or tini) as PID 1 so zombies
 *     from orphaned background processes get reaped.
 *   - Long-lived container with `sleep infinity` as the main command. Both
 *     SDK and PTY are `podman exec` siblings of this.
 *
 * Two mount-authority tiers (same model as bwrap):
 *   - operator: ~/.dashscope/config.json `mounts` (any host path)
 *   - member:   convention-based via `vaults/<v>/mounts/home/<rel>/...` → $HOME/<rel>/...
 *   - admin:    no mount capability
 *
 * See memory: project_loop_dir_is_sandbox.md
 */
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import {
  WORKSPACE,
  loopWorkdir,
  loopClaudeDir,
  loopsDir,
  loopContextChatDir,
  workspaceKnowledgeDir,
  workspaceNotesDir,
  workspaceReposDir,
  loopContextKnowledge,
  loopContextNotes,
  personalDir,
  LOOPAT_INSTALL_DIR,
  loopHomeUpper,
  workspaceHomeSkelDir,
  loopDir,
} from "./paths"
import { loadConfig } from "./config"
import { DEFAULT_VAULT, listVaultHomeMounts } from "./vaults"

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

// $HOME inside the container. Deliberately NOT host's homedir — if we bound
// host's $HOME at its real path, podman would auto-create parent dirs for
// every nested bind (LOOPAT_HOME, LOOPAT_INSTALL_DIR, etc. all live under
// host $HOME in typical installs), and those intermediate dirs end up owned
// by a subuid that the user can't delete from the host. With $HOME under
// /loopat/ — outside the host's homedir tree — every host-absolute bind
// sits beside it, never inside.
export const V_HOME = (user: string) => `/loopat/home/${user}`

// Label keys for podman inspect.
const LABEL_LOOP = "loopat.loop-id"
const LABEL_WORKSPACE = "loopat.workspace"
const LABEL_CONFIG_HASH = "loopat.config-hash"

// Image used as the base for every loop container. Built locally from
// server/templates/sandbox/Containerfile via ensureSandboxImage().
export const SANDBOX_IMAGE = process.env.LOOPAT_SANDBOX_IMAGE || "loopat-sandbox:latest"

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
  /** Extra env vars to pre-bake into the container at create time. */
  extraEnv?: Record<string, string>
  /** Image to create the container from. Defaults to SANDBOX_IMAGE.
   *  Production callers resolve a per-loop child via ensureLoopImage; tests
   *  may omit this and get the base. */
  image?: string
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
  const { loopId, createdBy, vaultName, knowledgeRw, mountAllLoops } = opts
  const virtualHome = V_HOME(createdBy)
  const mounts: VolumeMount[] = []

  // /tmp: shared with host (for socat / mktemp / IPC sockets). Same as today.
  mounts.push({ src: "/tmp", dst: "/tmp" })

  // $HOME: per-loop upper layer, persistent across container restarts. We
  // place it under /loopat/home/<user> instead of host's actual homedir so
  // nothing nests under it. (See V_HOME comment for why.)
  mounts.push({ src: loopHomeUpper(loopId), dst: virtualHome })

  // Virtual mount points for AI / user:
  mounts.push({ src: loopWorkdir(loopId), dst: V_LOOP_WORKDIR(loopId) })
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
  // store absolute gitdir paths). Both RW.
  const reposDir = workspaceReposDir()
  if (existsSync(reposDir)) {
    mounts.push({ src: reposDir, dst: V_CONTEXT_REPOS })
    mounts.push({ src: reposDir, dst: reposDir })
  }

  // notes/knowledge main repos: re-bind at host-absolute path so per-loop
  // worktree `.git` files resolve.
  const notesRepo = workspaceNotesDir()
  if (existsSync(notesRepo)) {
    mounts.push({ src: notesRepo, dst: notesRepo })
  }
  const knowledgeRepo = workspaceKnowledgeDir()
  if (existsSync(knowledgeRepo)) {
    mounts.push({ src: knowledgeRepo, dst: knowledgeRepo, ro: !knowledgeRw })
  }

  // chat snapshots (per-loop, ro). Only mount if populated.
  const chatDir = loopContextChatDir(loopId)
  if (existsSync(chatDir)) {
    mounts.push({ src: chatDir, dst: V_CONTEXT_CHAT, ro: true })
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
  for (const [k, v] of Object.entries(opts.extraEnv ?? {})) {
    out[k] = v
  }
  return out
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
    // v1: share host network. Future per-loop netns: drop this and add
    // slirp4netns.
    "--network", "host",
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

  // Config hash. Covers mounts + opts but NOT env — see hashCreateArgs
  // doc for why.
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
 * Config hash: covers everything that, if changed, would require recreating
 * the container — mounts + loop-scoped opts. Deliberately EXCLUDES the env
 * map because different callers (term.ts / session.ts) legitimately pass
 * different extraEnv (PTY doesn't need ANTHROPIC_API_KEY; SDK does). If we
 * hashed env, those callers would force-recreate the container on every
 * activity flip, killing each other's exec'd processes with SIGKILL (the
 * actual bug behind "PTY exits 137 the moment a chat starts").
 *
 * Env still lands in `podman create --env` for convenience (so an exec
 * without explicit env inherits something sane), but the values that
 * actually matter at runtime should be passed at exec time anyway.
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
  return h.digest("hex").slice(0, 16)
}

// ── podman binary wrapping ────────────────────────────────────────────────

const PODMAN_BIN = process.env.LOOPAT_PODMAN_BIN || "podman"

async function runPodman(args: string[], opts: { allowFail?: boolean } = {}): Promise<{ stdout: string, stderr: string, code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(PODMAN_BIN, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (b) => stdout += b.toString())
    child.stderr.on("data", (b) => stderr += b.toString())
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
 * Containerfile is FROM ubuntu:24.04 + apt-installs basic shell tools; the
 * first build pulls ubuntu:24.04 from docker.io (~78MB), subsequent
 * `ensureContainer` calls reuse the cached image.
 *
 * Concurrency: build is idempotent at podman's layer cache, but we still
 * guard with a per-process Promise so two simultaneous ensureContainer
 * calls don't fire two builds.
 */
let _imageBuildInFlight: Promise<void> | null = null
export async function ensureSandboxImage(): Promise<void> {
  if (_imageBuildInFlight) return _imageBuildInFlight
  _imageBuildInFlight = (async () => {
    const present = await runPodman(["image", "exists", SANDBOX_IMAGE], { allowFail: true })
    if (present.code === 0) return
    const containerfile = join(LOOPAT_INSTALL_DIR, "server", "templates", "sandbox", "Containerfile")
    if (!existsSync(containerfile)) {
      throw new Error(`Cannot build sandbox image: Containerfile not found at ${containerfile}`)
    }
    console.log(`[podman] building sandbox image ${SANDBOX_IMAGE} (first run; may take ~30s)`)
    const r = await runPodman([
      "build",
      "-t", SANDBOX_IMAGE,
      "-f", containerfile,
      join(LOOPAT_INSTALL_DIR, "server", "templates", "sandbox"),
    ])
    if (r.code !== 0) {
      throw new Error(`sandbox image build failed: ${r.stderr || r.stdout}`)
    }
    console.log(`[podman] sandbox image ready`)
  })()
  try {
    await _imageBuildInFlight
  } finally {
    _imageBuildInFlight = null
  }
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
export async function ensureLoopImage(loopId: string): Promise<string> {
  await ensureSandboxImage()

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

  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16)
  const tag = `loopat-sandbox-${hash}:latest`

  const existing = _loopImageInFlight.get(tag)
  if (existing) return existing

  const built = (async () => {
    const present = await runPodman(["image", "exists", tag], { allowFail: true })
    if (present.code === 0) {
      _loopWarnings.delete(loopId)
      return tag
    }

    console.log(`[podman] building loop image ${tag} for loop ${loopId.slice(0, 8)}`)
    const buildDir = await mkdtemp(join(tmpdir(), "loopat-img-"))
    try {
      await copyFile(miseTomlPath, join(buildDir, "mise.toml"))
      // Override `mise trust` interactively by marking the config path
      // trusted via env. `mise install -y` installs everything in
      // mise.toml; `mise reshim` ensures /opt/loopat-mise/shims/ has a
      // shim for every tool.
      const childContainerfile = [
        `FROM ${SANDBOX_IMAGE}`,
        `COPY mise.toml /opt/loopat-mise/config/config.toml`,
        `RUN MISE_TRUSTED_CONFIG_PATHS=/opt/loopat-mise/config/config.toml \\`,
        `    mise install -y \\`,
        ` && MISE_TRUSTED_CONFIG_PATHS=/opt/loopat-mise/config/config.toml \\`,
        `    mise reshim`,
      ].join("\n") + "\n"
      await writeFile(join(buildDir, "Containerfile"), childContainerfile)

      const r = await runPodman([
        "build",
        "-t", tag,
        "-f", join(buildDir, "Containerfile"),
        buildDir,
      ], { allowFail: true })
      if (r.code !== 0) {
        // Don't throw — fall back to base so the loop still starts. The
        // user can inspect via terminal, fix mise.toml, and restart.
        const detail = (r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" | ").slice(0, 400)
        const msg = `toolchain build failed — sandbox started without baked tools. mise install rejected ${miseTomlPath}: ${detail}`
        console.error(`[podman] ${msg}`)
        _loopWarnings.set(loopId, msg)
        return SANDBOX_IMAGE
      }
      console.log(`[podman] loop image ${tag} ready`)
      _loopWarnings.delete(loopId)
    } finally {
      await rm(buildDir, { recursive: true, force: true }).catch(() => {})
    }
    return tag
  })()
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

/**
 * Idempotent: bring the container to "running with current config".
 *   - missing       → podman create + start
 *   - stopped, hash matches → start
 *   - stopped, hash drift   → rm + create + start
 *   - running, hash matches → no-op
 *   - running, hash drift   → stop + rm + create + start
 */
export async function ensureContainer(opts: ContainerOptions): Promise<void> {
  // Resolve the image first — for loops with a composed mise.toml this
  // builds (or reuses) a per-loop child image with toolchains baked in.
  // For loops without mise.toml, this returns the base SANDBOX_IMAGE.
  const image = opts.image ?? (await ensureLoopImage(opts.loopId))
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
  if (cur.running && cur.configHash === desiredHash && cur.imageId === curImageId) return
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
  await runPodman(["create", ...createArgs])
  await runPodman(["start", containerName(opts.loopId)])
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
