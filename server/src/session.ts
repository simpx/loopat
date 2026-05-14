import { query, type Query, type SDKMessage, type SDKUserMessage, type PermissionMode as SdkPermissionMode } from "@anthropic-ai/claude-agent-sdk"
import type { WSContext } from "hono/ws"
import { appendFile, readFile, readdir, writeFile, mkdir } from "node:fs/promises"
import { createWriteStream, mkdirSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { loopClaudeDir, loopDir, loopHistoryPath } from "./paths"
import { resolveClaudeBinary } from "./claude-binary"
import { loadConfig, loadPersonalConfig, loadTeamClaudeJson, type ProviderConfig } from "./config"
import { buildLoopatAppend } from "./system-prompt"
import { getLoop, patchLoopMeta } from "./loops"
import { spawn as nodeSpawn } from "node:child_process"
import { buildOuterBwrapArgs, V_LOOP_WORKDIR, V_LOOP_CLAUDE } from "./outer-sandbox"

const CLAUDE_BINARY = resolveClaudeBinary()
const DEBUG = !!process.env.LOOPAT_DEBUG || !!process.env.LOOPAT_DEBUG_SPAWN

/**
 * Mirror cli's ff(): explicit override wins; otherwise [1m] tag → 1M;
 * any claude opus-4-7/4-6/sonnet-4/sonnet-4-6 → still defaults to 200K
 * unless tagged [1m] (1M is opt-in via beta on those). Fallback 200K.
 */
function resolveContextWindow(p: ProviderConfig): number {
  if (p.maxContextTokens && p.maxContextTokens > 0) return p.maxContextTokens
  if (/\[1m\]/i.test(p.model)) return 1_000_000
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

class LoopSession {
  id: string
  private q: Query | null = null
  private input = pushIterable<SDKUserMessage>()
  private subscribers = new Map<WSContext, SubscriberState>()
  private history: SDKMessage[] = []
  private historyLoaded: Promise<void>
  private pendingQuestions = new Map<string, AskQuestionPending>()
  private pendingPermissions = new Map<string, PermissionPending>()
  private providerOverride: string | null = null
  private currentPermissionMode: SdkPermissionMode = "bypassPermissions"
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private consuming = false

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

  /** Walk personal + workspace configs, preferring candidateNames order, and
   *  return the first matching provider. If requireKey is true, skip providers
   *  with an empty apiKey and keep searching. Returns null if nothing matches.
   *
   *  Selection order:
   *    1. explicit candidates (caller-supplied: WS override, loop.meta.config)
   *    2. personal config's `default` field
   *    3. workspace config's `default` field
   *    4. enumeration of all providers (personal first, then workspace) */
  private async resolveProvider(meta: { createdBy: string }, candidateNames: (string | null | undefined)[], requireKey: boolean): Promise<{ name: string; provider: ProviderConfig } | null> {
    const pCfg = await loadPersonalConfig(meta.createdBy)
    const wCfg = await loadConfig()
    const names = [
      ...candidateNames,
      pCfg.default,
      (wCfg as any).default,
      ...Object.keys(pCfg.providers),
      ...Object.keys((wCfg as any).providers ?? {}),
    ].filter(Boolean) as string[]
    const seen = new Set<string>()
    for (const name of names) {
      if (seen.has(name)) continue
      seen.add(name)
      const p = pCfg.providers[name] ?? (wCfg as any).providers?.[name] as ProviderConfig | undefined
      if (p && (!requireKey || p.apiKey)) return { name, provider: p }
    }
    return null
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
    if (this.q) {
      const dying = this.q
      this.q = null
      this.input = pushIterable<SDKUserMessage>()
      dying.interrupt().catch(() => {})
    }
    return true
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
    const resolved = await this.resolveProvider(meta, [
      this.providerOverride,
      meta.config?.default_model,
    ], true)
    if (!resolved) {
      throw new Error(`no provider with a valid apiKey — set one in personal/${meta.createdBy}/.loopat/secrets/provider-keys/`)
    }
    const providerName = resolved.name
    const provider = resolved.provider

    const loopatAppend = await buildLoopatAppend(meta)
    const loopId = this.id
    // Team Claude config (mcpServers et al) lives in knowledge/.loopat/claude/claude.json.
    // Passed through to SDK as-is — secret substitution removed; static-auth
    // servers should keep their token in `env`/`headers` directly (only ever
    // commit OAuth-flow servers like `coop` to the team repo).
    const team = await loadTeamClaudeJson()
    const mcpServers = team.mcpServers

    // Prebuild bwrap base argv (resolves personal-dep symlinks etc.) so the
    // spawnClaudeCodeProcess callback can run synchronously.
    const extraEnv: Record<string, string> = {
      ANTHROPIC_API_KEY: provider.apiKey,
      ANTHROPIC_BASE_URL: provider.baseUrl,
      CLAUDE_CONFIG_DIR: V_LOOP_CLAUDE(loopId),
    }
    // Override cli's hardcoded model→context-window map for gateway-routed
    // models. Both env vars are required (cli checks DISABLE_COMPACT first
    // to enable the override path, then reads CLAUDE_CODE_MAX_CONTEXT_TOKENS).
    if (provider.maxContextTokens && provider.maxContextTokens > 0) {
      extraEnv.DISABLE_COMPACT = "1"
      extraEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(provider.maxContextTokens)
    }
    const bwrapBase = await buildOuterBwrapArgs(loopId, meta.createdBy, extraEnv)
    if (DEBUG) {
      const tag = loopId.slice(0, 8)
      console.error(`[sdk:${tag}] config: provider=${providerName} model=${provider.model} baseUrl=${provider.baseUrl} apiKey=${provider.apiKey ? `<set len=${provider.apiKey.length}>` : "<empty>"}`)
      console.error(`[sdk:${tag}] config: continue=${shouldContinue} cwd=${V_LOOP_WORKDIR(loopId)} CLAUDE_CONFIG_DIR=${V_LOOP_CLAUDE(loopId)}`)
      console.error(`[sdk:${tag}] config: bwrap-argc=${bwrapBase.length} binary=${CLAUDE_BINARY}`)
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
        model: provider.model,
        permissionMode: this.currentPermissionMode,
        // Required by SDK when using permissionMode: "bypassPermissions"
        ...(this.currentPermissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
        systemPrompt: { type: "preset", preset: "claude_code", append: loopatAppend },
        mcpServers,
        stderr: (s) => console.error(`[sdk:${loopId.slice(0, 8)}] ${s.trimEnd()}`),
        pathToClaudeCodeExecutable: CLAUDE_BINARY,
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
        settingSources: ["user", "project"],
        // Inner SDK sandbox disabled — outer bwrap (single layer) wraps the
        // CLI process itself; bash subprocesses inherit the same namespace.
        // No nested sandbox needed.
        sandbox: { enabled: false },
        // Wrap CLI spawn in outer bwrap. Synchronous: argv is prebuilt above.
        spawnClaudeCodeProcess: ({ command, args, signal }) => {
          const fullArgs = [...bwrapBase, "--", command, ...args]
          const tag = loopId.slice(0, 8)
          // Always tee stderr to a per-loop file so it survives terminal
          // truncation (bun --filter, tools that elide). Path also printed
          // on non-zero exit.
          mkdirSync(loopDir(loopId), { recursive: true })
          const stderrLogPath = join(loopDir(loopId), "stderr.log")
          const stderrFile = createWriteStream(stderrLogPath, { flags: "a" })
          stderrFile.write(`\n=== ${new Date().toISOString()} spawn ===\n`)
          stderrFile.write(`binary: ${command}\n`)
          stderrFile.write(`bwrap argc: ${fullArgs.length}\n`)
          if (DEBUG) {
            const argvLine = `bwrap ${fullArgs.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`
            console.error(`[sdk:${tag}] binary: ${command}`)
            console.error(`[sdk:${tag}] spawn cmd: ${argvLine}`)
            stderrFile.write(`argv: ${argvLine}\n`)
          }

          const proc = nodeSpawn("bwrap", fullArgs, {
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
    try {
      for await (const msg of q) {
        if (DEBUG) {
          const subtype = (msg as any).subtype ? `/${(msg as any).subtype}` : ""
          const event = (msg as any).event?.type ? ` event=${(msg as any).event.type}` : ""
          console.error(`[sdk:${tag}] msg ${msg.type}${subtype}${event}`)
        }
        // ephemeral live-feed events: don't persist or replay; just broadcast
        // so already-attached clients see the streaming.
        const ephemeral = msg.type === "stream_event" || msg.type === "tool_progress"
        if (!ephemeral) {
          this.history.push(msg)
          this.persist(msg)
        }
        this.broadcast(msg)
      }
    } catch (e: any) {
      console.error(`[sdk:${tag}] consume error:`, e?.message ?? e)
      if (DEBUG && e?.stack) console.error(e.stack)
      const err = { type: "error", message: e?.message ?? String(e) }
      this.history.push(err as any)
      this.persist(err)
      this.broadcast(err)
    } finally {
      this.consuming = false
      // Always emit a result marker so the frontend knows the run is done,
      // even if the generator ended without one (e.g. after interrupt).
      const result = { type: "result" as const }
      this.history.push(result as any)
      this.broadcast(result)
      if (this.subscribers.size === 0) this.scheduleIdleCleanup()
    }
  }

  private persist(msg: any) {
    appendFile(loopHistoryPath(this.id), JSON.stringify(msg) + "\n").catch((e) => {
      console.error("[loopat] persist failed", e)
    })
  }

  private broadcast(msg: any) {
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
          ws.send(JSON.stringify({
            type: "provider",
            name: resolved.name,
            model: resolved.provider.model,
            contextWindow: resolveContextWindow(resolved.provider),
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
    try {
      ws.send(JSON.stringify({ type: "history_end" }))
    } catch {}
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
    // Apply permission mode before ensureStarted so the initial query() gets it.
    // When switching to bypassPermissions the q.setPermissionMode() call alone
    // is sufficient — the SDK re-evaluates permissions for the next turn.
    if (permissionMode && permissionMode !== this.currentPermissionMode) {
      this.currentPermissionMode = permissionMode
      // Persist to loop meta so it survives page reloads
      patchLoopMeta(this.id, { config: { permission_mode: permissionMode } }).catch(() => {})
      if (this.q) {
        try { await this.q.setPermissionMode(permissionMode) } catch {}
      }
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
    if (this.q) await this.q.interrupt().catch(() => {})
  }

  /** Tear down the SDK process and disconnect all subscribers. Used when a
   *  loop is archived so no orphaned processes remain. */
  async destroy() {
    this.cancelIdleCleanup()
    sessions.delete(this.id)
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
