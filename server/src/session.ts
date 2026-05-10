import { query, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { WSContext } from "hono/ws"
import { appendFile, readFile, readdir } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { loopClaudeDir, loopHistoryPath } from "./paths"
import { resolveClaudeBinary } from "./claude-binary"
import { loadConfig, getActiveProvider } from "./config"
import { buildLoopatAppend } from "./system-prompt"
import { getLoop } from "./loops"
import { spawn as nodeSpawn } from "node:child_process"
import { buildOuterBwrapArgs, V_LOOP, V_LOOP_CLAUDE } from "./outer-sandbox"

const CLAUDE_BINARY = resolveClaudeBinary()

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

class LoopSession {
  id: string
  private q: Query | null = null
  private input = pushIterable<SDKUserMessage>()
  private subscribers = new Map<WSContext, SubscriberState>()
  private history: SDKMessage[] = []
  private historyLoaded: Promise<void>

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

    // Prebuild bwrap base argv (resolves personal-dep symlinks etc.) so the
    // spawnClaudeCodeProcess callback can run synchronously.
    const bwrapBase = await buildOuterBwrapArgs(loopId, {
      ANTHROPIC_API_KEY: provider.apiKey,
      ANTHROPIC_BASE_URL: provider.baseUrl,
      CLAUDE_CONFIG_DIR: V_LOOP_CLAUDE(loopId),
    })

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
        stderr: (s) => console.error(`[sdk:${loopId.slice(0, 8)}] ${s.trimEnd()}`),
        pathToClaudeCodeExecutable: CLAUDE_BINARY,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // Read user-tier settings.json from CLAUDE_CONFIG_DIR — that's where
        // we wrote autoMemoryDirectory: /personal/memory. SDK's auto-memory
        // recall will then scan the virtual path (which the outer bwrap maps
        // to the real personal/<user>/memory/).
        settingSources: ["user"],
        // Inner SDK sandbox disabled — outer bwrap (single layer) wraps the
        // CLI process itself; bash subprocesses inherit the same namespace.
        // No nested sandbox needed.
        sandbox: { enabled: false },
        // Wrap CLI spawn in outer bwrap. Synchronous: argv is prebuilt above.
        spawnClaudeCodeProcess: ({ command, args, signal }) => {
          const fullArgs = [...bwrapBase, "--", command, ...args]
          return nodeSpawn("bwrap", fullArgs, {
            stdio: ["pipe", "pipe", "pipe"],
            signal,
          }) as any
        },
        // Stream text deltas + tool progress to the UI for live visibility.
        includePartialMessages: true,
        ...(shouldContinue ? { continue: true } : {}),
      },
    })
    this.consume(this.q)
  }

  private async consume(q: Query) {
    try {
      for await (const msg of q) {
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
      const err = { type: "error", message: e?.message ?? String(e) }
      this.history.push(err as any)
      this.persist(err)
      this.broadcast(err)
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
