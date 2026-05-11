import { query, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { WSContext } from "hono/ws"
import { appendFile, readFile, readdir } from "node:fs/promises"
import { createWriteStream, mkdirSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { loopClaudeDir, loopDir, loopHistoryPath } from "./paths"
import { resolveClaudeBinary } from "./claude-binary"
import { loadConfig, loadTeamClaudeJson, getActiveProvider, type ProviderConfig } from "./config"
import { buildLoopatAppend } from "./system-prompt"
import { loadPersonalSecrets, substituteVars } from "./personal-secrets"
import { getLoop } from "./loops"
import { spawn as nodeSpawn } from "node:child_process"
import { buildOuterBwrapArgs, V_LOOP, V_LOOP_CLAUDE } from "./outer-sandbox"

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

class LoopSession {
  id: string
  private q: Query | null = null
  private input = pushIterable<SDKUserMessage>()
  private subscribers = new Map<WSContext, SubscriberState>()
  private history: SDKMessage[] = []
  private historyLoaded: Promise<void>
  private pendingQuestions = new Map<string, AskQuestionPending>()

  constructor(id: string) {
    this.id = id
    this.historyLoaded = this.loadHistoryFromDisk()
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
    const cfg = await loadConfig()
    const { name: providerName, provider } = getActiveProvider(cfg)
    if (!provider.apiKey) {
      throw new Error(`config.json: provider "${providerName}" has empty apiKey — fill it in and restart`)
    }

    const meta = await getLoop(this.id)
    if (!meta) {
      throw new Error(`loop ${this.id} meta missing`)
    }
    const loopatAppend = await buildLoopatAppend(meta)
    const loopId = this.id
    // Team Claude config (mcpServers et al) lives in knowledge/.loopat/claude/claude.json.
    // Resolve ${VAR} refs against personal/<user>/secrets/ on the host; secret
    // files themselves never enter the sandbox — only the substituted strings.
    const team = await loadTeamClaudeJson()
    const secrets = await loadPersonalSecrets(meta.createdBy)
    const mcpServers = team.mcpServers ? substituteVars(team.mcpServers, secrets) : undefined

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
      console.error(`[sdk:${tag}] config: continue=${shouldContinue} cwd=${V_LOOP(loopId)} CLAUDE_CONFIG_DIR=${V_LOOP_CLAUDE(loopId)}`)
      console.error(`[sdk:${tag}] config: bwrap-argc=${bwrapBase.length} binary=${CLAUDE_BINARY}`)
    }

    this.q = query({
      prompt: this.input.iter,
      options: {
        cwd: V_LOOP(loopId),
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: V_LOOP_CLAUDE(loopId),
          ANTHROPIC_API_KEY: provider.apiKey,
          ANTHROPIC_BASE_URL: provider.baseUrl,
        },
        model: provider.model,
        systemPrompt: { type: "preset", preset: "claude_code", append: loopatAppend },
        mcpServers,
        stderr: (s) => console.error(`[sdk:${loopId.slice(0, 8)}] ${s.trimEnd()}`),
        pathToClaudeCodeExecutable: CLAUDE_BINARY,
        canUseTool: async (toolName, input, { toolUseID, signal }) => {
          // Only intercept AskUserQuestion — allow everything else immediately.
          // SDK Zod schema requires `updatedInput` on allow (echo input back).
          if (toolName !== "AskUserQuestion") {
            return { behavior: "allow" as const, updatedInput: input as Record<string, unknown> }
          }
          const questions = (input as any)?.questions
          if (!Array.isArray(questions) || questions.length === 0) {
            return { behavior: "allow" as const, updatedInput: input as Record<string, unknown> }
          }
          // Broadcast questions to frontend and wait for answers.
          // Don't persist to history — questions are ephemeral and stale on replay.
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
            }, 300_000) // 5 min timeout
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
        },
        // user-tier: read autoMemoryDirectory: /personal/memory from
        // CLAUDE_CONFIG_DIR/settings.json (SDK auto-memory uses that path).
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
      // Always emit a result marker so the frontend knows the run is done,
      // even if the generator ended without one (e.g. after interrupt).
      const result = { type: "result" as const }
      this.history.push(result as any)
      this.broadcast(result)
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
      const cfg = await loadConfig()
      const { name, provider } = getActiveProvider(cfg)
      ws.send(JSON.stringify({
        type: "provider",
        name,
        model: provider.model,
        contextWindow: resolveContextWindow(provider),
      }))
    } catch {}
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
    this.broadcastViewers()
    console.log(`[loop:${this.id.slice(0, 8)}] attach → viewers=${this.subscribers.size}`)
  }

  detach(ws: WSContext) {
    this.subscribers.delete(ws)
    this.broadcastViewers()
    console.log(`[loop:${this.id.slice(0, 8)}] detach → viewers=${this.subscribers.size}`)
  }

  async sendUserText(text: string) {
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

  async interrupt() {
    if (this.q) await this.q.interrupt().catch(() => {})
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
