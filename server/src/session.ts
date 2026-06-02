import { query, type Query, type SDKMessage, type SDKUserMessage, type PermissionMode as SdkPermissionMode, type StopHookInput } from "@anthropic-ai/claude-agent-sdk"
import type { WSContext } from "hono/ws"
import { appendFile, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises"
import { createWriteStream, mkdirSync, existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { loopClaudeDir, loopDir, loopHistoryPath, personalSkillsDir, workspaceTeamSkillsDir } from "./paths"
import { resolveSandboxClaudeBinary } from "./claude-binary"
import { loadConfig, loadPersonalConfig, parseDefault, type ProviderConfig } from "./config"
import { buildLoopatAppend } from "./system-prompt"
import { composeLoopClaudeConfig, writeLoopSettings } from "./compose"
import { ensureLoopPluginsInstalled, lookupPluginInstallPath, BUILTIN_LOOPAT_PLUGIN_PATH } from "./plugin-installer"
import { effectiveDriver, getLoop, loopEphemeralPorts, patchLoopMeta } from "./loops"
import { spawn as nodeSpawn } from "node:child_process"
import { ensureContainer, buildPodmanExecArgs, markActive, markInactive, V_LOOP_WORKDIR, V_LOOP_CLAUDE } from "./podman"
import { updateLoopStatus, setLoopPhase } from "./loop-status"

// Tests override LOOPAT_CLAUDE_BIN to point at a mock binary (a script that
// reads stream-json from stdin and writes canned messages back) so we can
// exercise the full chat pipeline without burning real API credits.
// Resolved lazily — each spawn re-reads the env var so the full-suite test
// run, where module load order isn't guaranteed, sees the test's override
// even if session.ts was imported earlier with the env var unset.
// The AI runs inside the linux sandbox, so it needs the linux claude binary
// (resolveSandboxClaudeBinary) — on a linux host that's the host claude; on a
// darwin/win host it's the linux binary postinstall fetched into sandbox-claude.
function getClaudeBinary(): string {
  return process.env.LOOPAT_CLAUDE_BIN || resolveSandboxClaudeBinary()
}
const DEBUG = !!process.env.LOOPAT_DEBUG || !!process.env.LOOPAT_DEBUG_SPAWN

function parseSkillDescription(content: string): string | undefined {
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fm) return undefined
  const desc = fm[1].match(/^description:\s*(.+)$/m)
  return desc ? desc[1].trim() : undefined
}

async function readSkillDescription(skillsDir: string, skillName: string): Promise<string> {
  try {
    const content = await readFile(join(skillsDir, skillName, "SKILL.md"), "utf-8")
    return parseSkillDescription(content) ?? ""
  } catch {
    return ""
  }
}

/**
 * Pick a provider from personal + workspace configs given a candidate list,
 * applying the priority order:
 *   1. explicit candidates (caller-supplied: WS override, loop.meta.config)
 *   2. personal config's `default` field
 *   3. workspace config's `default` field
 *   4. enumeration (personal first, then workspace)
 *
 * `requireKey=true` skips providers with empty apiKey and keeps walking.
 * Returns null when no match found. Pure function; tests use it directly.
 */
export function pickProvider(
  pCfg: { default: string; providers: Record<string, ProviderConfig> },
  wCfg: { default?: string; providers?: Record<string, ProviderConfig> },
  candidateNames: (string | null | undefined)[],
  requireKey: boolean,
): { name: string; provider: ProviderConfig } | null {
  const names = [
    ...candidateNames,
    pCfg.default ? parseDefault(pCfg.default).providerName : undefined,
    wCfg.default ? parseDefault(wCfg.default).providerName : undefined,
    ...Object.keys(pCfg.providers),
    ...Object.keys(wCfg.providers ?? {}),
  ].filter(Boolean) as string[]
  const seen = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    const p = pCfg.providers[name] ?? wCfg.providers?.[name]
    if (p && (!requireKey || p.apiKey)) return { name, provider: p }
  }
  return null
}

/**
 * Mirror cli's ff(): explicit override wins; otherwise [1m] tag → 1M;
 * any claude opus-4-7/4-6/sonnet-4/sonnet-4-6 → still defaults to 200K
 * unless tagged [1m] (1M is opt-in via beta on those). Fallback 200K.
 */
function resolveContextWindow(p: ProviderConfig, modelId?: string): number {
  // Per-model override takes precedence
  const model = modelId ? p.models.find(m => m.id === modelId) : undefined
  if (model?.maxContextTokens && model.maxContextTokens > 0) return model.maxContextTokens
  // Provider-level fallback
  if (p.maxContextTokens && p.maxContextTokens > 0) return p.maxContextTokens
  if (/\[1m\]/i.test(model?.id ?? p.models[0]?.id ?? "")) return 1_000_000
  return 200_000
}

/** Subset of SDK PermissionMode that the frontend sends. */
const VALID_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const
type FrontendPermissionMode = (typeof VALID_MODES)[number]

function isValidMode(m: unknown): m is FrontendPermissionMode {
  return typeof m === "string" && (VALID_MODES as readonly string[]).includes(m)
}

function maskEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    if (/key|token|secret|password/i.test(k)) {
      out[k] = v ? `<set len=${v.length}>` : "<empty>"
    } else {
      out[k] = v
    }
  }
  return out
}

function pushIterable<T>() {
  const queue: T[] = []
  let resolver: ((v: IteratorResult<T>) => void) | null = null
  let done = false

  const iter: AsyncIterableIterator<T> = {
    [Symbol.asyncIterator]() {
      return this
    },
    next(): Promise<IteratorResult<T>> {
      if (queue.length > 0) {
        return Promise.resolve({ value: queue.shift()!, done: false })
      }
      if (done) {
        return Promise.resolve({ value: undefined as any, done: true })
      }
      return new Promise((r) => {
        resolver = r
      })
    },
    return(value?: any): Promise<IteratorResult<T>> {
      done = true
      return Promise.resolve({ value, done: true })
    },
  }

  return {
    push(v: T) {
      if (done) return
      if (resolver) {
        const r = resolver
        resolver = null
        r({ value: v, done: false })
      } else {
        queue.push(v)
      }
    },
    end() {
      done = true
      if (resolver) {
        const r = resolver
        resolver = null
        r({ value: undefined as any, done: true })
      }
    },
    iter,
  }
}

async function hasPriorSdkSession(loopId: string): Promise<boolean> {
  const projectsDir = join(loopClaudeDir(loopId), "projects")
  try {
    const projects = await readdir(projectsDir)
    for (const p of projects) {
      const files = await readdir(join(projectsDir, p))
      if (files.some((f) => f.endsWith(".jsonl"))) return true
    }
  } catch {}
  return false
}

type SubscriberState = { pending: any[] | null }

interface AskQuestionPending {
  toolUseID: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiSelect: boolean
  }>
  resolve: (result: { behavior: 'allow'; updatedInput: Record<string, unknown> }) => void
  reject: (err: Error) => void
}

interface PermissionPending {
  toolUseID: string
  toolName: string
  promptMsg: Record<string, unknown>
  resolve: (result: PermissionResult) => void
  reject: (err: Error) => void
}

type PermissionResult = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }

/** Tools that are always safe (read-only) — auto-allowed in every mode. */
const SAFE_TOOLS = new Set([
  "Read", "Grep", "Glob", "WebSearch", "WebFetch",
  "TaskOutput", "CronList", "TodoWrite",
  "EnterPlanMode", "ExitPlanMode",
])

/** Tools that edit files — auto-allowed in acceptEdits mode. */
const EDIT_TOOLS = new Set(["Write", "Edit", "NotebookEdit"])

const IDLE_TIMEOUT_MS = Number(process.env.LOOPAT_SESSION_IDLE_MS) || 5 * 60 * 1000

type QueuedMessage = { text: string; permissionMode?: SdkPermissionMode }

export type LoopSessionMessageListener = (msg: any) => void

class LoopSession {
  id: string
  private q: Query | null = null
  private input = pushIterable<SDKUserMessage>()
  private subscribers = new Map<WSContext, SubscriberState>()
  private history: SDKMessage[] = []
  private historyLoaded: Promise<void>
  private pendingQuestions = new Map<string, AskQuestionPending>()
  private pendingPermissions = new Map<string, PermissionPending>()
  private messageListeners = new Set<LoopSessionMessageListener>()
  private providerOverride: string | null = null
  private currentPermissionMode: SdkPermissionMode = "bypassPermissions"
  private currentGoal: string | null = null
  private goalSetAt: string | null = null
  private goalStatus: "active" | "completed" | null = null
  /** Set of CC task_ids spawned while this goal was active. Used to gauge progress. */
  private goalTaskIds = new Set<string>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private consuming = false
  private generating = false
  private messageQueue: QueuedMessage[] = []
  private queueProcessing = false

  constructor(id: string) {
    this.id = id
    this.historyLoaded = this.loadHistoryFromDisk()
  }

  private cancelIdleCleanup() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private scheduleIdleCleanup() {
    if (this.idleTimer) return
    if (this.subscribers.size > 0) return
    if (this.consuming) return // never interrupt an active generation
    const tag = this.id.slice(0, 8)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.subscribers.size === 0) {
        console.log(`[loop:${tag}] idle timeout — destroying session`)
        this.destroy()
      }
    }, IDLE_TIMEOUT_MS)
  }

  private async resolveProvider(meta: { createdBy: string; driver?: string; config?: { vault?: string } }, candidateNames: (string | null | undefined)[], requireKey: boolean): Promise<{ name: string; provider: ProviderConfig } | null> {
    const pCfg = await loadPersonalConfig(effectiveDriver(meta), meta.config?.vault)
    const wCfg = await loadConfig()
    return pickProvider(pCfg, wCfg, candidateNames, requireKey)
  }

  /**
   * Set the active provider. Takes effect on the next user message — the
   * current claude-binary child (if any) is interrupted and torn down so
   * `ensureStarted` re-spawns it with the new provider's env (baseUrl /
   * apiKey / model). Conversation history is preserved via `--continue`,
   * which reads the existing SDK jsonl on disk, so the swap is transparent
   * to the user beyond the brief pause.
   *
   * Always returns true — provider switching is unconditional. The setter
   * is fire-and-forget; the interrupt runs in the background, and the next
   * sendUserText awaits the freshly-null `q` and re-enters ensureStarted.
   *
   * The pushIterable is also reset: the old `Query` is still holding the
   * old iter, so a fresh push would race the dying-but-not-dead loop. The
   * new query takes a brand-new iter; the orphaned iter is GC'd when the
   * old Query's internal loop unwinds.
   */
  setProvider(name: string | null) {
    this.providerOverride = name
    this.restartOnNextMessage()
    return true
  }

  /** Set the active goal. Broadcasts to all subscribers and restarts the
   *  query so the next system prompt includes the goal. Pass null to clear. */
  setGoal(goal: string | null, setAt?: string, status?: "active" | "completed") {
    this.currentGoal = goal
    this.goalSetAt = setAt ?? (goal ? new Date().toISOString() : null)
    this.goalStatus = goal ? (status ?? "active") : null
    if (goal) {
      this.goalTaskIds = new Set()
    }
    this.broadcast({
      type: "goal",
      goal,
      setAt: this.goalSetAt,
      status: this.goalStatus,
    })
    if (this.q) {
      // Re-compose: the next ensureStarted picks up the goal via buildLoopatAppend.
      this.restartOnNextMessage()
    }
  }

  /** Mark the current goal as completed. Called by the user or by detecting
   *  an AI self-report. */
  completeGoal() {
    if (!this.currentGoal || this.goalStatus !== "active") return
    this.goalStatus = "completed"
    this.broadcast({
      type: "goal",
      goal: this.currentGoal,
      setAt: this.goalSetAt,
      status: "completed",
    })
  }

  getGoal(): string | null {
    return this.currentGoal
  }

  /**
   * Interrupt the current `query()` and clear `this.q`, so the next user
   * message triggers a fresh `ensureStarted()` — picking up changes to env
   * vars, provider config, **mcpServers**, etc. Conversation history is
   * preserved because the SDK reads its session JSONL from disk on respawn
   * (`continue: true` when `hasPriorSdkSession` is true).
   *
   * Idempotent: calling on a session that doesn't currently hold a query is
   * a no-op. Fire-and-forget; the interrupt runs in the background.
   */
  restartOnNextMessage() {
    if (this.q) {
      const dying = this.q
      this.q = null
      this.input = pushIterable<SDKUserMessage>()
      dying.interrupt().catch(() => {})
    }
  }

  private async loadHistoryFromDisk() {
    try {
      const raw = await readFile(loopHistoryPath(this.id), "utf8")
      for (const line of raw.split("\n")) {
        if (!line) continue
        try {
          this.history.push(JSON.parse(line))
        } catch {}
      }
    } catch {}
  }

  private async ensureStarted() {
    if (this.q) return
    const shouldContinue = await hasPriorSdkSession(this.id)
    const meta = await getLoop(this.id)
    if (!meta) {
      throw new Error(`loop ${this.id} meta missing`)
    }
    // Effective driver — credentials, plugins, vault, env, personal mount
    // all follow this user, not the immutable createdBy. Updated by the
    // /api/loops/:id/drive handoff endpoint; next spawn picks it up here.
    const driver = effectiveDriver(meta)
    const resolved = await this.resolveProvider(meta, [
      this.providerOverride,
      meta.config?.default_model,
    ], true)
    if (!resolved) {
      throw new Error(`no provider with a valid apiKey for vault "${meta.config?.vault ?? "default"}" — set one in personal/${driver}/.loopat/vaults/${meta.config?.vault ?? "default"}/envs/`)
    }
    const providerName = resolved.name
    const provider = resolved.provider

    const loopatAppend = await buildLoopatAppend(meta)
    const loopId = this.id

    // Compose runs ONCE at loop creation (loops.ts:createLoop). At spawn we
    // only re-compose if the snapshot is missing — this happens for loops
    // created before the snapshot model landed, and self-heals on first spawn.
    //
    // The "compose once and freeze" semantics is what makes principle 1
    // (old loops never change) work: subsequent admin pushes to knowledge
    // don't affect a loop that's already been materialized.
    const composedSettingsPath = join(loopClaudeDir(loopId), "settings.json")
    if (!existsSync(composedSettingsPath)) {
      await composeLoopClaudeConfig(loopId, driver, meta.config?.profiles)
    }
    // Ensure host CC has every marketplace registered + every enabled plugin
    // installed. We don't need the resolved paths (sandbox sees host
    // ~/.claude/plugins/ via a wholesale ro-bind in bwrap, and the inner SDK
    // resolves enabledPlugins natively from settings.json). This is purely
    // side-effectful: drive `claude plugin marketplace add/remove` +
    // `claude plugin install` as needed. See plugin-installer.ts.
    await ensureLoopPluginsInstalled(loopId)

    // Nuke CC's MCP-related cache files that linger across spawns:
    //   `.credentials.json`         — CC's ephemeral OAuth state.
    //   `mcp-needs-auth-cache.json` — CC's "this server needs auth" short-circuit.
    // Tokens flow through vault envs/MCP_*_TOKEN now, substituted into the
    // workspace `mcpServers[*].headers.Authorization` template by the spawned
    // binary at startup. Stale CC cache files would shortcircuit that, so we
    // clear them every spawn.
    for (const f of [".credentials.json", "mcp-needs-auth-cache.json"]) {
      try {
        await rm(join(loopClaudeDir(loopId), f), { force: true })
      } catch {}
    }

    // mcpServers come straight from the merged settings.json (workspace +
    // profiles + personal — compose wrote it to loops/<id>/.claude/settings.json
    // above). Any `${VAR}` references in headers / env are substituted by the
    // spawned claude binary against its own process env — which inherits the
    // vault envs we inject into extraEnv below.
    const mergedSettingsPath = join(loopClaudeDir(loopId), "settings.json")
    let mcpServers: Record<string, any> = {}
    if (existsSync(mergedSettingsPath)) {
      try {
        const merged = JSON.parse(await readFile(mergedSettingsPath, "utf8"))
        // Strip loopat-only inline metadata (e.g. `x-loopat-resource`, used by
        // the MCP setup UI) so the SDK / CC only sees standard MCP fields.
        mcpServers = Object.fromEntries(
          Object.entries((merged.mcpServers ?? {}) as Record<string, any>).map(([name, srv]) => {
            if (srv && typeof srv === "object") {
              const clean: Record<string, any> = {}
              for (const [k, v] of Object.entries(srv)) if (!k.startsWith("x-loopat")) clean[k] = v
              return [name, clean]
            }
            return [name, srv]
          }),
        )
      } catch (e: any) {
        console.warn(`[session ${loopId.slice(0,8)}] could not read merged mcpServers: ${e?.message ?? e}`)
      }
    }

    // Build sandbox env. Order matters: vault envs first (so the spawned binary
    // can substitute ${VAR} in mcpServers headers passed via SDK options),
    // then platform-controlled vars (which can't be overridden by a stray
    // vault env file).
    const personalCfg = await loadPersonalConfig(driver, meta.config?.vault)
    const extraEnv: Record<string, string> = {
      ...personalCfg.vaultEnvs,
      ANTHROPIC_API_KEY: provider.apiKey,
      ANTHROPIC_BASE_URL: provider.baseUrl,
      CLAUDE_CONFIG_DIR: V_LOOP_CLAUDE(loopId),
    }
    // Override cli's hardcoded model→context-window map for gateway-routed
    // models. Both env vars are required (cli checks DISABLE_COMPACT first
    // to enable the override path, then reads CLAUDE_CODE_MAX_CONTEXT_TOKENS).
    // Per-model override takes precedence over provider-level.
    //
    // Resolve the active model: loop meta override first, then personal
    // config default model, then first enabled, then models[0].
    let modelId: string | undefined = meta.config?.default_model_id
    if (!modelId) {
      const pCfg = await loadPersonalConfig(driver, meta.config?.vault)
      const defaultParsed = parseDefault(pCfg.default)
      if (defaultParsed.modelId && defaultParsed.providerName === providerName) {
        modelId = defaultParsed.modelId
      }
    }
    const activeModel = (modelId ? provider.models.find(m => m.id === modelId) : undefined)
      ?? provider.models.find(m => m.enabled !== false)
      ?? provider.models[0]
    const contextTokenOverride = activeModel?.maxContextTokens ?? provider.maxContextTokens
    if (contextTokenOverride && contextTokenOverride > 0) {
      extraEnv.DISABLE_COMPACT = "1"
      extraEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(contextTokenOverride)
    }
    // Mise toolchain: baked into the per-loop image at ensureLoopImage
    // build time. The image's ENV puts /opt/loopat-mise/shims on PATH, so
    // every process inside the container (SDK + PTY) finds the right
    // toolchain — no host-side activation needed here.
    //
    // Ensure the per-loop podman container exists and is running. Idempotent:
    // if the container is already up with the same config-hash, no-op. Both
    // this SDK driver AND the PTY (term.ts) call ensureContainer with the
    // same options, so they end up sharing one container (same PID / Mount /
    // IPC namespace) — that's the whole point of the podman refactor.
    // Mirrors term.ts: only raise the `preparing` gate once a build/pull
    // actually emits progress; clear it to `ready` once the container is up.
    let building = false
    await ensureContainer({
      loopId,
      createdBy: driver,
      vaultName: meta.config?.vault,
      knowledgeRw: meta.config?.knowledge_rw,
      mountAllLoops: meta.config?.mount_all_loops,
      repo: meta.repo,
      extraEnv,
      ephemeralPorts: loopEphemeralPorts(meta),
    }, {
      onProgress: (msg) => {
        if (!building) { building = true; setLoopPhase(loopId, "preparing") }
        updateLoopStatus(loopId, msg)
      },
    })
    if (building) setLoopPhase(loopId, "ready")
    updateLoopStatus(loopId, "Ready")
    // Tell the container lifecycle scheduler that this loop has an active
    // SDK source. Released in destroy() via markInactive(loopId, "sdk").
    markActive(loopId, "sdk")
    const claudeBinary = getClaudeBinary()
    if (DEBUG) {
      const tag = loopId.slice(0, 8)
      console.error(`[sdk:${tag}] config: provider=${providerName} model=${activeModel?.id ?? "?"} baseUrl=${provider.baseUrl} apiKey=${provider.apiKey ? `<set len=${provider.apiKey.length}>` : "<empty>"}`)
      console.error(`[sdk:${tag}] config: continue=${shouldContinue} cwd=${V_LOOP_WORKDIR(loopId)} CLAUDE_CONFIG_DIR=${V_LOOP_CLAUDE(loopId)}`)
      console.error(`[sdk:${tag}] config: binary=${claudeBinary}`)
    }

    this.q = query({
      prompt: this.input.iter,
      options: {
        cwd: V_LOOP_WORKDIR(loopId),
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: V_LOOP_CLAUDE(loopId),
          ANTHROPIC_API_KEY: provider.apiKey,
          ANTHROPIC_BASE_URL: provider.baseUrl,
        },
        model: activeModel?.id ?? "",
        permissionMode: this.currentPermissionMode,
        // Required by SDK when using permissionMode: "bypassPermissions"
        ...(this.currentPermissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
        systemPrompt: { type: "preset", preset: "claude_code", append: loopatAppend },
        mcpServers,
        // External marketplace plugins (enabledPlugins in settings.json) are
        // resolved natively by the inner SDK now — ~/.claude/plugins/ is
        // ro-bound wholesale, so installed_plugins.json + each installPath is
        // reachable inside the sandbox. The only thing we still pass via
        // `plugins:` is the loopat-shipped builtin, which lives under
        // LOOPAT_INSTALL_DIR (not in CC's plugin cache).
        plugins: [{ type: "local" as const, path: BUILTIN_LOOPAT_PLUGIN_PATH }],
        stderr: (s) => console.error(`[sdk:${loopId.slice(0, 8)}] ${s.trimEnd()}`),
        pathToClaudeCodeExecutable: claudeBinary,
        canUseTool: async (toolName, input, { toolUseID, signal, title, displayName }) => {
          // ── AskUserQuestion: always broadcast to frontend ──
          if (toolName === "AskUserQuestion") {
            const questions = (input as any)?.questions
            if (!Array.isArray(questions) || questions.length === 0) {
              return { behavior: "allow" as const, updatedInput: {} }
            }
            const questionMsg = {
              type: "question",
              tool_use_id: toolUseID,
              questions,
            }
            this.broadcast(questionMsg)
            return new Promise((resolve, reject) => {
              const timeout = setTimeout(() => {
                this.pendingQuestions.delete(toolUseID)
                reject(new Error("question timed out"))
              }, 300_000)
              this.pendingQuestions.set(toolUseID, {
                toolUseID,
                questions,
                resolve: (result) => {
                  clearTimeout(timeout)
                  resolve(result)
                },
                reject: (err) => {
                  clearTimeout(timeout)
                  reject(err)
                },
              })
              signal.addEventListener("abort", () => {
                clearTimeout(timeout)
                this.pendingQuestions.delete(toolUseID)
                reject(new Error("question cancelled"))
              }, { once: true })
            })
          }

          // ── Safe (read-only) tools: always allow ──
          if (SAFE_TOOLS.has(toolName)) {
            return { behavior: "allow" as const, updatedInput: {} }
          }

          const mode = this.currentPermissionMode

          // ── Full-auto modes: allow everything ──
          if (mode === "bypassPermissions" || mode === "auto" || mode === "dontAsk") {
            return { behavior: "allow" as const, updatedInput: {} }
          }

          // ── acceptEdits: auto-allow file-editing tools; prompt for the rest ──
          if (mode === "acceptEdits" && EDIT_TOOLS.has(toolName)) {
            return { behavior: "allow" as const, updatedInput: {} }
          }

          // ── default / plan / acceptEdits(non-edit): prompt the user ──
          const promptMsg = {
            type: "permission_prompt",
            tool_use_id: toolUseID,
            tool_name: toolName,
            title: title || `Claude wants to use ${toolName}`,
            displayName: displayName || toolName,
          }
          this.broadcast(promptMsg)

          return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              this.pendingPermissions.delete(toolUseID)
              resolve({ behavior: "deny" as const, message: "Permission timed out" })
            }, 120_000) // 2 min timeout
            this.pendingPermissions.set(toolUseID, {
              toolUseID,
              toolName,
              promptMsg,
              resolve: (result) => {
                clearTimeout(timeout)
                resolve(result)
              },
              reject: (err) => {
                clearTimeout(timeout)
                reject(err)
              },
            })
            signal.addEventListener("abort", () => {
              clearTimeout(timeout)
              this.pendingPermissions.delete(toolUseID)
              reject(new Error("permission cancelled"))
            }, { once: true })
          })
        },
        // user-tier: read autoMemoryDirectory (/loopat/context/personal/memory)
        // from CLAUDE_CONFIG_DIR/settings.json (SDK auto-memory uses that path).
        // project-tier: auto-load <workdir>/CLAUDE.md so per-repo conventions
        // (e.g. the project's own CLAUDE.md) layer on top of platform doctrine.
        // local-tier: pick up <workdir>/.claude/settings.local.json + .local.md
        // agents/skills so users can drop per-checkout overrides without
        // committing them.
        settingSources: ["user", "project", "local"],
        // Stop hook: when an active goal exists, prevent the session from
        // ending if there is unfinished background work. Mirrors CC's /goal
        // behavior — the hook fires on session-end and blocks the stop while
        // goal-related tasks are still running.
        hooks: {
          Stop: [{
            hooks: [async (input) => {
              const si = input as StopHookInput
              const hasGoal = !!this.currentGoal && this.goalStatus === "active"
              if (!hasGoal) return { continue: true }
              const busy = (si.background_tasks?.length ?? 0) > 0
              if (busy) {
                return {
                  continue: false,
                  stopReason: `goal "${this.currentGoal}" still in progress — background work is running`,
                }
              }
              // No background work and model is stopping naturally (first
              // invocation). Auto-complete the goal — matches CC's /goal
              // behavior where finishing the task marks the goal done.
              if (!si.stop_hook_active) {
                this.completeGoal()
              }
              return { continue: true }
            }],
          }],
        },
        // Inner SDK sandbox disabled — outer podman container wraps everything;
        // bash subprocesses from the Bash tool inherit the same namespace via
        // exec-in-container. No nested sandbox needed.
        sandbox: { enabled: false },
        // Spawn CLI inside the per-loop podman container via `podman exec`.
        spawnClaudeCodeProcess: ({ command, args, signal }) => {
          // SDK has already injected the resolved plugins via its `plugins`
          // option → `--plugin-dir <path>` flags in `args`. We just wrap +
          // spawn here.
          //
          // `interactive: true` is CRITICAL — without `-i` on `podman exec`,
          // stdin from the host (which the SDK uses to push user messages
          // as stream-json) is NOT forwarded to the claude binary inside
          // the container, so claude reads EOF and exits immediately with
          // code 0 producing no output ("chat sends but never responds").
          // NO `tty: true` though — SDK speaks line-delimited stream-json
          // over pipes, not via PTY.
          const spawnBinary = process.env.LOOPAT_PODMAN_BIN || "podman"
          const fullArgs = buildPodmanExecArgs({
            loopId,
            command,
            args,
            env: extraEnv,
            workdir: V_LOOP_WORKDIR(loopId),
            interactive: true,
          })
          const tag = loopId.slice(0, 8)
          // Always tee stderr to a per-loop file so it survives terminal
          // truncation (bun --filter, tools that elide). Path also printed
          // on non-zero exit.
          mkdirSync(loopDir(loopId), { recursive: true })
          const stderrLogPath = join(loopDir(loopId), "stderr.log")
          const stderrFile = createWriteStream(stderrLogPath, { flags: "a" })
          stderrFile.write(`\n=== ${new Date().toISOString()} spawn ===\n`)
          stderrFile.write(`binary: ${command}\n`)
          stderrFile.write(`${spawnBinary} argc: ${fullArgs.length}\n`)
          if (DEBUG) {
            const argvLine = `${spawnBinary} ${fullArgs.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`
            console.error(`[sdk:${tag}] binary: ${command}`)
            console.error(`[sdk:${tag}] spawn cmd: ${argvLine}`)
            stderrFile.write(`argv: ${argvLine}\n`)
          }

          const proc = nodeSpawn(spawnBinary, fullArgs, {
            stdio: ["pipe", "pipe", "pipe"],
            signal,
          })

          if (DEBUG) {
            console.error(`[sdk:${tag}] spawned pid=${proc.pid}`)
          }
          proc.on("error", (e) => {
            console.error(`[sdk:${tag}] spawn error:`, e?.message ?? e)
            stderrFile.write(`spawn error: ${e?.message ?? e}\n`)
          })

          // pipe stderr to file (always) and to console (always, lossy if
          // terminal eats it, lossless via the file).
          proc.stderr?.on("data", (chunk: Buffer) => {
            stderrFile.write(chunk)
            const text = chunk.toString("utf8")
            for (const line of text.split("\n")) {
              if (line.trim()) console.error(`[sdk:${tag}:stderr] ${line}`)
            }
          })

          if (DEBUG) {
            // mirror stdout too — useful for seeing the SDK protocol if the
            // SDK itself isn't surfacing what came back. Capped to avoid
            // flooding when chat is healthy.
            proc.stdout?.on("data", (chunk: Buffer) => {
              const s = chunk.toString("utf8")
              const head = s.length > 400 ? s.slice(0, 400) + `…+${s.length - 400}b` : s
              for (const line of head.split("\n")) {
                if (line.trim()) console.error(`[sdk:${tag}:stdout] ${line}`)
              }
            })
          }

          proc.on("exit", (code, sig) => {
            stderrFile.end(`=== exit code=${code} sig=${sig ?? ""} ===\n`)
            if (code !== 0 && code !== null) {
              console.error(`[sdk:${tag}] child exited code=${code}${sig ? ` sig=${sig}` : ""}; full stderr at ${stderrLogPath}`)
            } else if (DEBUG) {
              console.error(`[sdk:${tag}] child exited code=${code}${sig ? ` sig=${sig}` : ""}`)
            }
          })
          return proc as any
        },
        // Stream text deltas + tool progress to the UI for live visibility.
        includePartialMessages: true,
        ...(shouldContinue ? { continue: true } : {}),
      },
    })
    this.consume(this.q)
  }

  private async consume(q: Query) {
    this.consuming = true
    const tag = this.id.slice(0, 8)
    // Set after we receive a `result` message — at that point the turn is
    // semantically complete. If the SDK subsequently throws (e.g. the SIGKILL
    // dance against an idle claude binary that podman exec can't forward
    // SIGTERM into), the error is cleanup noise, not a real failure — we
    // suppress it from the user-visible history / broadcast.
    let resultReceived = false
    try {
      for await (const msg of q) {
        if (DEBUG) {
          const subtype = (msg as any).subtype ? `/${(msg as any).subtype}` : ""
          const event = (msg as any).event?.type ? ` event=${(msg as any).event.type}` : ""
          console.error(`[sdk:${tag}] msg ${msg.type}${subtype}${event}`)
        }
        // Track generating state: init → true, result → false
        if (msg.type === "system" && (msg as any).subtype === "init") {
          this.generating = true
        } else if (msg.type === "result") {
          this.generating = false
          this.queueProcessing = false
          this.q = null
          this.processNextInQueue()
          resultReceived = true
        } else if (
          // Inject queued messages at tool-result boundaries — matching
          // real Claude Code's per-step queue consumption.
          this.messageQueue.length > 0 &&
          msg.type === "user" &&
          Array.isArray((msg as any).message?.content) &&
          (msg as any).message.content.some((b: any) => b?.type === "tool_result")
        ) {
          this.generating = false
          this.queueProcessing = false
          await q.interrupt().catch(() => {})
          this.q = null
          this.processNextInQueue()
          return
        }

        // ephemeral live-feed events: don't persist or replay; just broadcast
        // so already-attached clients see the streaming.
        const ephemeral = msg.type === "stream_event" || msg.type === "tool_progress"
        if (!ephemeral) {
          this.history.push(msg)
          this.persist(msg)
        }
        this.broadcast(msg)
        this.updateStatus(msg)
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      // Post-result cleanup noise: the SDK kills the idle claude child after
      // ~7s (SIGTERM → 5s grace → SIGKILL). With our podman-exec wrapper, the
      // host-side SIGTERM doesn't propagate to claude inside the container,
      // so the SIGKILL fires and podman reports exit 137. The turn already
      // succeeded — don't pollute history or alarm the frontend.
      if (resultReceived && /exited with code|aborted by user|terminated by signal/.test(msg)) {
        console.warn(`[sdk:${tag}] post-result cleanup noise (suppressed): ${msg}`)
      } else {
        console.error(`[sdk:${tag}] consume error:`, msg)
        if (DEBUG && e?.stack) console.error(e.stack)
        const err = { type: "error", message: msg }
        this.history.push(err as any)
        this.persist(err)
        this.broadcast(err)
      }
    } finally {
      // If a new Query was started by processNextInQueue() above, skip cleanup —
      // the new consume owns the lifecycle from here on.
      if (this.q !== q) return
      this.consuming = false
      this.generating = false
      this.queueProcessing = false
      this.q = null
      this.input = pushIterable<SDKUserMessage>()
      // Emit a result marker so the frontend knows the run is done,
      // even if the generator ended without one (e.g. after interrupt).
      const result = { type: "result" as const }
      this.history.push(result as any)
      this.broadcast(result)
      if (this.subscribers.size === 0) this.scheduleIdleCleanup()
    }
  }

  private persist(msg: any) {
    const stamped = { ...msg, _ts: new Date().toISOString() }
    appendFile(loopHistoryPath(this.id), JSON.stringify(stamped) + "\n").catch((e) => {
      console.error("[loopat] persist failed", e)
    })
  }

  private broadcast(msg: any) {
    for (const listener of this.messageListeners) {
      try { listener(msg) } catch {}
    }
    const data = JSON.stringify(msg)
    for (const [ws, state] of this.subscribers) {
      if (state.pending !== null) {
        state.pending.push(msg)
        continue
      }
      try {
        ws.send(data)
      } catch {}
    }
  }

  private broadcastViewers() {
    const msg = { type: "viewers", count: this.subscribers.size }
    const data = JSON.stringify(msg)
    for (const [ws, state] of this.subscribers) {
      if (state.pending !== null) continue
      try {
        ws.send(data)
      } catch {}
    }
  }

  private updateStatus(msg: any) {
    // 1. 用户输入状态
    if (msg.type === "user") {
      const text = typeof msg.content === "string" ? msg.content : msg.content?.[0]?.text || ""
      if (text) {
        updateLoopStatus(this.id, `User: ${text.slice(0, 50)}${text.length > 50 ? "..." : ""}`)
      }
      return
    }

    // 2. AI 响应状态 (assistant 消息)
    if (msg.type === "assistant") {
      const content = Array.isArray(msg.content) ? msg.content : []
      // 优先捕获 tool_use 或 thinking
      for (const block of content) {
        if (block.type === "tool_use") {
          updateLoopStatus(this.id, `Using ${block.name || "tool"}...`)
          return
        }
        if (block.type === "thinking" || block.type === "reasoning") {
          updateLoopStatus(this.id, "Thinking...")
          return
        }
      }
      // 其次捕获文本输出
      const textBlock = content.find((b: any) => b.type === "text")
      if (textBlock?.text) {
        const text = textBlock.text
        const preview = text.trim().slice(-60).replace(/\n/g, " ")
        updateLoopStatus(this.id, preview || "Generating...")
      }
      return
    }

    // 3. Stream events (Real-time updates)
    if (msg.type === "stream_event") {
      const evt = msg.event || msg.data
      if (evt?.type === "content_block_start") {
        const block = evt.content_block || evt.data
        if (block?.type === "tool_use") {
          updateLoopStatus(this.id, `Using ${block.name || "tool"}...`)
          return
        }
        if (block?.type === "thinking") {
          updateLoopStatus(this.id, "Thinking...")
          return
        }
      }
      if (evt?.type === "content_block_delta") {
        const delta = evt.delta || evt.data
        if (delta?.type === "text" && delta.text) {
          updateLoopStatus(this.id, delta.text.slice(-60).replace(/\n/g, " "))
          return
        }
      }
      return
    }

    // 4. 兼容独立事件类型
    if (msg.type === "tool_use" || msg.type === "tool_call") {
      updateLoopStatus(this.id, `Using ${msg.name || msg.tool_name || "tool"}...`)
      return
    }
    if (msg.type === "thinking" || msg.type === "reasoning") {
      updateLoopStatus(this.id, "Thinking...")
      return
    }
    if (msg.type === "content_block_start" || msg.type === "content_block_delta") {
      const delta = msg.delta || msg.content_block
      if (delta?.type === "tool_use") {
        updateLoopStatus(this.id, `Using ${delta.name || "tool"}...`)
      } else if (delta?.type === "thinking" || delta?.type === "reasoning") {
        updateLoopStatus(this.id, "Thinking...")
      } else if (delta?.type === "text" && delta.text) {
        updateLoopStatus(this.id, delta.text.slice(-60).replace(/\n/g, " "))
      }
      return
    }

    // 5. 结束状态
    if (msg.type === "result" || msg.stop_reason || msg.type === "message_stop") {
      updateLoopStatus(this.id, "Done")
    }
  }

  /**
   * Read subdirectory names from a path — silently returns [] if missing.
   * Includes symlinks (composeTier creates symlinks-to-dirs under
   * .claude/plugins/cache/, which isDirectory() reports as false).
   */
  private async listDirNames(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      return entries
        .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
        .map((e) => e.name)
    } catch {
      return []
    }
  }

  /**
   * Build a best-effort list of slash commands from the loop's workspace /
   * personal config. Used to seed the frontend before CC's real init arrives.
   * Includes well-known CC builtins, loose skills from knowledge/personal,
   * AND plugin sub-commands (<plugin>:<skill>) read from the same paths the
   * SDK is about to load — so the menu is complete on first open, not after
   * the first message has triggered a spawn.
   */
  private async buildInitialSlashCommands(user: string): Promise<{ name: string; description: string }[]> {
    const map = new Map<string, string>()
    // CC built-in commands (descriptions handled by frontend's local COMMANDS)
    for (const c of ["help", "model", "clear", "compress", "review", "init", "foxtrot"]) {
      if (!map.has(c)) map.set(c, "")
    }
    // Workspace skills
    for (const name of await this.listDirNames(workspaceTeamSkillsDir())) {
      if (!map.has(name)) {
        map.set(name, await readSkillDescription(workspaceTeamSkillsDir(), name))
      }
    }
    // Personal skills (higher precedence)
    for (const name of await this.listDirNames(personalSkillsDir(user))) {
      map.set(name, await readSkillDescription(personalSkillsDir(user), name))
    }
    // Plugin sub-commands: scan each enabled plugin's skills/ dir on the host
    // and surface as `<plugin>:<skill>`. Best-effort pre-spawn seed so the
    // chip shows useful numbers before CC's init payload arrives; CC's init
    // is the authoritative list.
    try {
      const settingsPath = join(loopClaudeDir(this.id), "settings.json")
      if (existsSync(settingsPath)) {
        const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
          enabledPlugins?: Record<string, boolean>
        }
        const enabled = Object.entries(settings.enabledPlugins ?? {})
          .filter(([_, v]) => v)
          .map(([k]) => k)
        for (const spec of enabled) {
          const pluginPath = await lookupPluginInstallPath(spec)
          if (!pluginPath) continue
          const pluginName = spec.split("@")[0]
          const skillsDir = join(pluginPath, "skills")
          for (const skill of await this.listDirNames(skillsDir)) {
            map.set(`${pluginName}:${skill}`, await readSkillDescription(skillsDir, skill))
          }
        }
      }
    } catch (e: any) {
      console.warn(`[session ${this.id.slice(0,8)}] seed plugin scan failed: ${e?.message ?? e}`)
    }
    return [...map.entries()]
      .map(([name, description]) => ({ name, description }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async attach(ws: WSContext) {
    await this.historyLoaded
    const state: SubscriberState = { pending: [] }
    this.subscribers.set(ws, state)
    // Send active provider info up-front so UI can render badge + true context window.
    try {
      const meta = await getLoop(this.id)
      if (meta) {
        const resolved = await this.resolveProvider(meta, [
          this.providerOverride,
          meta.config?.default_model,
        ], false)
        if (resolved) {
          let attachModelId: string | undefined = meta.config?.default_model_id
          if (!attachModelId) {
            try {
              const driver = effectiveDriver(meta)
              const pCfg = await loadPersonalConfig(driver, meta.config?.vault)
              const defaultParsed = parseDefault(pCfg.default)
              if (defaultParsed.modelId && defaultParsed.providerName === resolved.name) {
                attachModelId = defaultParsed.modelId
              }
            } catch {}
          }
          const activeModel = (attachModelId ? resolved.provider.models.find(m => m.id === attachModelId) : undefined)
            ?? resolved.provider.models.find(m => m.enabled !== false)
            ?? resolved.provider.models[0]
          const activeModelId = activeModel?.id ?? ""
          ws.send(JSON.stringify({
            type: "provider",
            name: resolved.name,
            model: activeModelId,
            models: resolved.provider.models,
            contextWindow: resolveContextWindow(resolved.provider, activeModelId),
          }))
        } else {
          console.warn(`[loop:${this.id.slice(0, 8)}] no provider found in personal or workspace config`)
        }
        // Restore persisted permission mode
        const pm = meta.config?.permission_mode
        if (isValidMode(pm) && pm !== this.currentPermissionMode) {
          this.currentPermissionMode = pm
          if (this.q) {
            try { await this.q.setPermissionMode(pm) } catch {}
          }
        }
        // Tell frontend the current mode so it can sync its selector
        ws.send(JSON.stringify({
          type: "permission_mode",
          mode: this.currentPermissionMode,
        }))
        // Send current goal so reconnecting clients see it
        if (this.currentGoal) {
          try {
            ws.send(JSON.stringify({ type: "goal", goal: this.currentGoal, setAt: this.goalSetAt }))
          } catch {}
        }
      }
    } catch (e: any) {
      console.error(`[loop:${this.id.slice(0, 8)}] attach provider error:`, e?.message ?? e)
    }
    const snapshot = this.history.slice()
    for (const m of snapshot) {
      try {
        ws.send(JSON.stringify(m))
      } catch {}
    }
    if (state.pending) {
      for (const m of state.pending) {
        try {
          ws.send(JSON.stringify(m))
        } catch {}
      }
      state.pending = null
    }
    // history_end — signals the frontend that replay is done.
    // When not generating, also embed a best-effort slash-command list
    // so the / menu works immediately (before CC starts). CC's real
    // system/init replaces this with the accurate list later.
    const meta = await getLoop(this.id)
    if (this.generating) {
      try {
        ws.send(JSON.stringify({ type: "history_end" }))
      } catch {}
      // The frontend also needs a synthetic init to show running status
      // (the history-replayed init was ignored during loadingHistory).
      try {
        ws.send(JSON.stringify({ type: "system", subtype: "init" }))
      } catch {}
    } else {
      const user = meta?.createdBy
      const slashCommands = user ? await this.buildInitialSlashCommands(user) : undefined
      try {
        ws.send(JSON.stringify({ type: "history_end", slash_commands: slashCommands }))
      } catch {}
    }
    // Re-broadcast active permission prompts that survived history replay
    for (const [_, pending] of this.pendingPermissions) {
      try {
        ws.send(JSON.stringify(pending.promptMsg))
      } catch {}
    }
    // Re-broadcast active AskUserQuestion prompts
    for (const [_id, pending] of this.pendingQuestions) {
      try {
        ws.send(JSON.stringify({
          type: "question",
          tool_use_id: pending.toolUseID,
          questions: pending.questions,
        }))
      } catch {}
    }
    // Send current queue status to reconnected clients
    if (this.messageQueue.length > 0) {
      try { ws.send(JSON.stringify({ type: "queue_update", queue: this.messageQueue.map(m => m.text) })) } catch {}
    }
    this.cancelIdleCleanup()
    this.broadcastViewers()
    console.log(`[loop:${this.id.slice(0, 8)}] attach → viewers=${this.subscribers.size}`)
  }

  detach(ws: WSContext) {
    this.subscribers.delete(ws)
    this.broadcastViewers()
    if (this.subscribers.size === 0) this.scheduleIdleCleanup()
    console.log(`[loop:${this.id.slice(0, 8)}] detach → viewers=${this.subscribers.size}`)
  }

  async sendUserText(text: string, permissionMode?: SdkPermissionMode) {
    updateLoopStatus(this.id, `User: ${text.slice(0, 50)}${text.length > 50 ? "..." : ""}`)
    if (this.generating || this.messageQueue.length > 0 || this.queueProcessing) {
      this.messageQueue.push({ text, permissionMode })
      this.broadcast({ type: "queue_update", queue: this.messageQueue.map(m => m.text) })
      return
    }
    // _pushUserMessage can throw BEFORE the query starts (e.g. ensureStarted's
    // "no provider with a valid apiKey" when the user hasn't set an AI key) —
    // in which case `consume` never runs and never broadcasts. Catch it here so
    // the frontend gets a visible error instead of hanging on "Reasoning…".
    try {
      await this._pushUserMessage(text, permissionMode)
    } catch (e: any) {
      this.generating = false
      const message = e?.message ?? String(e)
      console.error(`[loopat] sendUserText failed for ${this.id}: ${message}`)
      this.broadcast({ type: "error", message })
    }
  }

  isBusy(): boolean {
    return this.generating || this.messageQueue.length > 0 || this.queueProcessing
  }

  onMessage(listener: LoopSessionMessageListener): () => void {
    this.messageListeners.add(listener)
    return () => {
      this.messageListeners.delete(listener)
    }
  }

  /** Push a synthetic message through the broadcast pipeline. Used by the
   *  v1 API to dispatch control events (choice_resolved / interrupted) to
   *  all active SSE listeners without polluting persisted history. */
  notifyListeners(msg: any): void {
    for (const listener of this.messageListeners) {
      try { listener(msg) } catch {}
    }
  }

  hasPendingPermission(toolUseId: string): boolean {
    return this.pendingPermissions.has(toolUseId)
  }

  hasPendingQuestion(toolUseId: string): boolean {
    return this.pendingQuestions.has(toolUseId)
  }

  private async _pushUserMessage(text: string, permissionMode?: SdkPermissionMode) {
    if (permissionMode && permissionMode !== this.currentPermissionMode) {
      this.currentPermissionMode = permissionMode
      patchLoopMeta(this.id, { config: { permission_mode: permissionMode } }).catch(() => {})
      if (this.q) {
        try { await this.q.setPermissionMode(permissionMode) } catch {}
      }
    }
    // Driver-handoff preamble: if POST /api/loops/:id/drive set a one-shot
    // pendingDriverNote, prepend a system-style line to this user message so
    // the model knows the human it's talking to has just changed. Cleared
    // atomically before ensureStarted so a transient crash doesn't leak it
    // into a second message.
    const meta = await getLoop(this.id)
    if (meta?.pendingDriverNote) {
      const { from, to, at } = meta.pendingDriverNote
      text = `[loopat] Driver handoff: this loop was previously driven by ${from}; from now on the active driver is ${to} (handoff at ${at}). The user you're now talking to may differ from the one who started the conversation.\n\n${text}`
      await patchLoopMeta(this.id, { pendingDriverNote: undefined }).catch(() => {})
    }
    await this.ensureStarted()
    const userMsg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      uuid: randomUUID(),
    }
    this.history.push(userMsg)
    this.persist(userMsg)
    this.broadcast(userMsg)
    this.input.push(userMsg)
  }

  /** Process the next queued message. Called from consume()'s finally block
   *  after each generation completes. Only starts the next message; subsequent
   *  messages are handled recursively by consume()'s finally. */
  private processNextInQueue() {
    if (this.queueProcessing) return // already processing
    if (this.messageQueue.length === 0) {
      this.broadcast({ type: "queue_update", queue: [] })
      return
    }
    this.queueProcessing = true
    const next = this.messageQueue.shift()!
    this.broadcast({ type: "queue_update", queue: this.messageQueue.map(m => m.text) })
    this._pushUserMessage(next.text, next.permissionMode).catch((e) => {
      console.error("[loopat] queued message failed:", e)
      this.queueProcessing = false
      // Try next message on failure
      if (this.messageQueue.length > 0) this.processNextInQueue()
      else this.broadcast({ type: "queue_update", queue: [] })
    })
  }

  async answerQuestions(toolUseID: string, answers: Record<string, string>) {
    const pending = this.pendingQuestions.get(toolUseID)
    if (!pending) return
    this.pendingQuestions.delete(toolUseID)
    // Include original questions alongside answers so the CLI tool receives both
    pending.resolve({ behavior: "allow", updatedInput: { questions: pending.questions, answers } })
  }

  async answerPermission(toolUseID: string, allow: boolean) {
    const pending = this.pendingPermissions.get(toolUseID)
    if (!pending) return
    this.pendingPermissions.delete(toolUseID)
    if (allow) {
      pending.resolve({ behavior: "allow", updatedInput: {} })
    } else {
      pending.resolve({ behavior: "deny", message: "User denied permission" })
    }
  }

  async setMaxThinkingTokens(tokens: number | null) {
    if (this.q) {
      try { await this.q.setMaxThinkingTokens(tokens) } catch {}
    }
  }

  async getContextUsage() {
    if (!this.q) return null
    try {
      return await this.q.getContextUsage()
    } catch {
      return null
    }
  }

  async interrupt() {
    this.generating = false
    if (this.q) await this.q.interrupt().catch(() => {})
  }

  getQueueLength(): number {
    return this.messageQueue.length
  }

  removeQueueItem(index: number) {
    if (index >= 0 && index < this.messageQueue.length) {
      this.messageQueue.splice(index, 1)
      this.broadcast({ type: "queue_update", queue: this.messageQueue.map(m => m.text) })
    }
  }

  clearQueue() {
    this.messageQueue = []
    this.queueProcessing = false
    this.broadcast({ type: "queue_update", queue: [] })
  }

  /** Tear down the SDK process and disconnect all subscribers. Used when a
   *  loop is archived so no orphaned processes remain. */
  async destroy() {
    this.cancelIdleCleanup()
    this.generating = false
    this.queueProcessing = false
    this.messageQueue = []
    sessions.delete(this.id)
    // Release the SDK side of the container activity registry; the container
    // will be `podman stop`'d after CONTAINER_IDLE_MS unless something else
    // (e.g. PTY subscribers) keeps it active.
    markInactive(this.id, "sdk")
    if (this.q) {
      try { await this.q.interrupt() } catch {}
      this.q = null
    }
    for (const [, pending] of this.pendingQuestions) {
      pending.reject(new Error("loop archived"))
    }
    this.pendingQuestions.clear()
    const closeMsg = JSON.stringify({ type: "error", message: "loop archived" })
    for (const [ws] of this.subscribers) {
      try { ws.send(closeMsg) } catch {}
      try { ws.close() } catch {}
    }
    this.subscribers.clear()
  }

  /**
   * Equivalent to CC TUI's `/clear`: ends the in-flight SDK conversation
   * and makes the next message start with zero AI context — while keeping
   * old session jsonls intact (still resumable via `claude --resume`).
   *
   * Mechanism: touch a fresh empty `<new-uuid>.jsonl` in the same
   * `projects/<encoded-cwd>/` dir(s) the SDK uses. `claude --continue`
   * picks "the most recent" jsonl by mtime, so on the next query it finds
   * this empty file and resumes with 0 prior turns. Older jsonls stay in
   * place — `claude --resume` still lists them, matching CC behavior. No
   * persistent session-id state is needed.
   *
   * messages.jsonl (our chat record) is NOT modified beyond appending a
   * `clear-boundary` marker. Marker broadcasts to clients (UI divider),
   * persists to disk (segments the log into per-session ranges), and is
   * visible to future readers (humans + AI) so they can tell which
   * messages belong to which SDK session window.
   */
  /**
   * Strip all `thinking` / `redacted_thinking` content blocks from every
   * SDK jsonl in this loop. Used before swapping to a provider that won't
   * recognize the existing thinking signatures (different baseUrl / account
   * / gateway). The plain user/assistant text stays — the AI's context is
   * preserved minus the cryptographically-signed reasoning chains, which
   * are useless to the new provider anyway.
   *
   * Originals backed up to `.claude/projects-archive/<ts>/<sub>/<file>`.
   * Returns the number of blocks stripped across all sessions.
   *
   * Side effects: interrupts current query and resets the pushIterable so
   * the next sendUserText spawns fresh against the rewritten jsonl.
   */
  async stripThinkingBlocks(): Promise<{ stripped: number; sessionsTouched: number }> {
    if (this.q) {
      try { await this.q.interrupt() } catch {}
      this.q = null
      this.input = pushIterable<SDKUserMessage>()
    }
    const projectsDir = join(loopClaudeDir(this.id), "projects")
    let stripped = 0
    let sessionsTouched = 0
    const ts = new Date().toISOString().replace(/[:.]/g, "-")
    const archiveDir = join(loopClaudeDir(this.id), "projects-archive", ts)
    try {
      const subdirs = await readdir(projectsDir)
      for (const sub of subdirs) {
        const subPath = join(projectsDir, sub)
        const files = await readdir(subPath).catch(() => [])
        for (const f of files) {
          if (!f.endsWith(".jsonl")) continue
          const filePath = join(subPath, f)
          const raw = await readFile(filePath, "utf8")
          const lines = raw.split("\n")
          const out: string[] = []
          let changed = false
          for (const line of lines) {
            if (!line) { out.push(line); continue }
            try {
              const obj = JSON.parse(line)
              const content = obj?.message?.content
              if (Array.isArray(content)) {
                const filtered = content.filter((c: any) => c?.type !== "thinking" && c?.type !== "redacted_thinking")
                if (filtered.length !== content.length) {
                  stripped += content.length - filtered.length
                  obj.message.content = filtered
                  changed = true
                  out.push(JSON.stringify(obj))
                  continue
                }
              }
              out.push(line)
            } catch {
              out.push(line)
            }
          }
          if (changed) {
            sessionsTouched++
            await mkdir(join(archiveDir, sub), { recursive: true })
            await writeFile(join(archiveDir, sub, f), raw)
            await writeFile(filePath, out.join("\n"))
          }
        }
      }
    } catch {}
    return { stripped, sessionsTouched }
  }

  async clear(by: string) {
    // 1. Stop in-flight generation if any.
    if (this.q) {
      try { await this.q.interrupt() } catch {}
      this.q = null
    }
    // 2. Drop SDK context without deleting history. Touch an empty new
    //    jsonl in each existing encoded-cwd subdir so --continue picks it.
    //    If no subdir exists yet (no SDK has spawned in this loop), the
    //    first post-clear message creates one naturally and starts fresh.
    const projectsDir = join(loopClaudeDir(this.id), "projects")
    try {
      const subdirs = await readdir(projectsDir)
      for (const sub of subdirs) {
        const newPath = join(projectsDir, sub, randomUUID() + ".jsonl")
        try { await writeFile(newPath, "") } catch {}
      }
    } catch {
      // projects/ doesn't exist yet — nothing to do; SDK state is already empty
    }
    // 3. Append boundary marker (in-memory + jsonl + broadcast).
    const marker = { type: "clear-boundary" as const, ts: new Date().toISOString(), by }
    this.history.push(marker as any)
    this.persist(marker)
    this.broadcast(marker)
  }
}

const sessions = new Map<string, LoopSession>()

/**
 * Snapshot of in-memory session activity for the admin dashboard.
 * Only includes loops whose `LoopSession` has been instantiated (i.e. someone
 * touched them via attach / sendUserText / etc.). Idle loops aren't here.
 */
export function getActivitySnapshot(): Array<{
  id: string
  wsCount: number
  generating: boolean
}> {
  return [...sessions.entries()].map(([id, s]) => ({
    id,
    wsCount: (s as any).subscribers.size as number,
    generating: (s as any).generating as boolean,
  }))
}

export function getSession(id: string): LoopSession {
  let s = sessions.get(id)
  if (!s) {
    s = new LoopSession(id)
    sessions.set(id, s)
  }
  return s
}

/** Destroy a loop's session if one exists. No-op if there is no active session. */
export function destroySession(id: string): boolean {
  const s = sessions.get(id)
  if (!s) return false
  s.destroy()
  return true
}

/**
 * Restart the in-memory LoopSession for one loop, if it exists.
 *
 * "Restart" means: interrupt the current `query()` so the next user message
 * re-runs `ensureStarted` — which re-reads vault tokens, `mcpServers`,
 * provider env, etc. The SDK reads its session JSONL on respawn
 * (`continue: true`), so conversation history is preserved.
 *
 * Returns true if a session was restarted, false if the loop had no active
 * session (no-op).
 */
export function restartSession(id: string): boolean {
  const s = sessions.get(id)
  if (!s) return false
  s.restartOnNextMessage()
  return true
}

