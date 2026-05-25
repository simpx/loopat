/**
 * pi-agent RPC backend adapter.
 *
 * Spawns `pi` in RPC mode (JSON stdin/stdout) and translates between
 * loopat's SDKMessage protocol and pi's native RPC protocol.
 *
 * pi RPC protocol reference (from packages/coding-agent/src/modes/rpc/rpc-types.ts):
 *   Commands (stdin):  { type: "prompt", message: "..." }
 *   Events (stdout):   AgentSessionEvent objects (message_start, message_delta, etc.)
 *   Responses (stdout): { type: "response", command: "prompt", success: true }
 */

import { spawn, execSync, type ChildProcess } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { BackendAdapter, BackendStartOptions, BackendType } from "./backend"
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

const DEBUG = !!process.env.LOOPAT_DEBUG || !!process.env.LOOPAT_DEBUG_PI

/**
 * Resolve the `pi` binary to a real .js file path. Checks:
 * 1. PI_BINARY env var (explicit override)
 * 2. ~/.bun/bin/pi (global bun install)
 * 3. `which pi` (search PATH)
 * 4. `pi` on PATH (fallback)
 *
 * Symlinks are resolved via realpathSync so the shebang-resolved node
 * binary can be found on the inherited PATH.
 */
function resolvePiBinary(): string {
  let path: string | null = null

  if (process.env.PI_BINARY) {
    path = process.env.PI_BINARY
  } else {
    const bunBin = join(homedir(), ".bun", "bin", "pi")
    if (existsSync(bunBin)) {
      path = bunBin
    } else {
      try {
        path = execSync("which pi", { encoding: "utf8" }).trim() || null
      } catch {}
    }
  }

  if (!path) return "pi"

  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Push-based async iterable adapter. Feeds messages from the pi RPC stdout
 * into an async iterable that the session consume loop can iterate.
 */
function createMessageStream() {
  const queue: SDKMessage[] = []
  let resolver: ((v: IteratorResult<SDKMessage>) => void) | null = null
  let done = false

  const iter: AsyncIterableIterator<SDKMessage> = {
    [Symbol.asyncIterator]() {
      return this
    },
    next(): Promise<IteratorResult<SDKMessage>> {
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
    return(value?: any): Promise<IteratorResult<SDKMessage>> {
      done = true
      return Promise.resolve({ value, done: true })
    },
  }

  return {
    push(msg: SDKMessage) {
      if (done) return
      if (resolver) {
        const r = resolver
        resolver = null
        r({ value: msg, done: false })
      } else {
        queue.push(msg)
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

/**
 * Translate a pi RPC event into loopat's SDKMessage format.
 *
 * pi's RPC protocol (from docs/rpc.md):
 *   - message_start / message_end: message lifecycle (user echo + assistant)
 *   - message_update: streaming deltas via `assistantMessageEvent` field
 *   - tool_execution_start / tool_execution_end: tool lifecycle
 *   - agent_start / agent_end: agent run lifecycle
 */
function translatePiEvent(event: any): SDKMessage | null {
  if (!event || !event.type) return null

  const tag = "[pi→sdk]"

  switch (event.type) {
    // ── Message lifecycle ──
    // pi echoes the user prompt as message_start/message_end with role="user".
    // Only forward assistant messages; user echoes are internal bookkeeping.
    case "message_start": {
      const msg = event.message
      if (!msg || msg.role !== "assistant") return null
      return {
        type: "assistant",
        subtype: "start",
        message: {
          role: "assistant",
          content: msg.content || [],
        },
      } as any
    }

    case "message_end": {
      const msg = event.message
      if (!msg || msg.role !== "assistant") return null
      return {
        type: "assistant",
        message: {
          role: "assistant",
          content: msg.content || [],
        },
      } as any
    }

    // ── Streaming deltas (message_update) ──
    // pi streams via message_update with an assistantMessageEvent sub-object.
    // Delta types: text_start, text_delta, text_end, thinking_start,
    // thinking_delta, thinking_end, toolcall_start, toolcall_delta, toolcall_end.
    case "message_update": {
      const ame = event.assistantMessageEvent
      if (!ame) return null
      switch (ame.type) {
        case "text_delta":
          return {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: ame.delta || "" },
            },
          } as any
        case "thinking_delta":
          return {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "thinking_delta", thinking: ame.delta || "" },
            },
          } as any
        case "text_start":
          return {
            type: "stream_event",
            event: {
              type: "content_block_start",
              content_block: { type: "text", text: "" },
            },
          } as any
        case "thinking_start":
          return {
            type: "stream_event",
            event: {
              type: "content_block_start",
              content_block: { type: "thinking", thinking: "" },
            },
          } as any
        case "toolcall_start":
          return {
            type: "stream_event",
            event: {
              type: "content_block_start",
              content_block: {
                type: "tool_use",
                id: ame.toolCall?.id || ame.partial?.id || randomUUID(),
                name: ame.toolCall?.name || ame.partial?.name || "",
                input: {},
              },
            },
          } as any
        case "toolcall_delta":
          return {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "input_json_delta", partial_json: ame.delta || "" },
            },
          } as any
        default:
          return null
      }
    }

    // ── Tool execution ──
    case "tool_execution_start": {
      // pi emits { type: "tool_execution_start", toolCallId, toolName, args }
      return {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: event.toolCallId || randomUUID(),
            name: event.toolName,
            input: event.args || {},
          }],
        },
      } as any
    }

    case "tool_execution_end": {
      // pi emits { type: "tool_execution_end", toolCallId, toolName, result, isError }
      const resultContent = event.result?.content
      const text = Array.isArray(resultContent)
        ? resultContent.map((b: any) => b.text || "").join("\n")
        : String(resultContent ?? "")
      return {
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: event.toolCallId,
            content: text,
          }],
        },
      } as any
    }

    // ── Agent lifecycle ──
    case "agent_end": {
      return { type: "result" } as any
    }

    case "agent_start": {
      return {
        type: "system",
        subtype: "init",
      } as any
    }

    // ── Unrecognized events ──
    default: {
      if (DEBUG) console.log(`${tag} unhandled event type: ${event.type}`)
      return null
    }
  }
}

export class PiRpcAdapter implements BackendAdapter {
  readonly type: BackendType = "pi-agent"

  private proc: ChildProcess | null = null
  private stream: ReturnType<typeof createMessageStream> | null = null
  private generating = false
  private stderrBuf = ""
  private lineBuf = ""

  async start(opts: BackendStartOptions): Promise<AsyncIterable<SDKMessage>> {
    const piBinary = resolvePiBinary()
    const tag = `[pi:${opts.loopId.slice(0, 8)}]`

    // Build pi CLI args for RPC mode
    const piProvider = opts.backendConfig?.provider || "anthropic"
    const args = [
      "--mode", "rpc",
      "--provider", piProvider,
    ]

    // Session management
    if (opts.continue) {
      args.push("--continue")
    }

    // System prompt append (loopat-specific instructions)
    if (opts.systemPromptAppend) {
      args.push("--append-system-prompt", opts.systemPromptAppend)
    }

    // Model override
    if (opts.model) {
      args.push("--model", opts.model)
    }

    // Build env: merge process.env + opts.env + pi-specific vars.
    // Ensure ~/.bun/bin is on PATH so that `node` (via fnm or bun's shim)
    // can be found when the kernel resolves the #!/usr/bin/env node shebang.
    const homeBin = join(homedir(), ".bun", "bin")
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      PATH: [homeBin, process.env.PATH].filter(Boolean).join(":"),
      ...opts.env,
      PI_CODING_AGENT: "true",
      PI_CODING_AGENT_SESSION_DIR: opts.cwd,
    }

    // Re-resolve opts-env PATH if present (prepend homeBin again so it stays first)
    if (opts.env?.PATH) {
      env.PATH = [homeBin, opts.env.PATH].filter(Boolean).join(":")
    }

    // ── API key / base URL (provider-specific) ──
    // session.ts already sets the correct env var in opts.env based on
    // the mapped provider. backendConfig carries the raw values as backup.
    if (opts.backendConfig?.apiKey && !env.ANTHROPIC_API_KEY && !env.DEEPSEEK_API_KEY && !env.OPENAI_API_KEY) {
      env.ANTHROPIC_API_KEY = opts.backendConfig.apiKey
      if (opts.backendConfig.baseUrl) {
        env.ANTHROPIC_BASE_URL = opts.backendConfig.baseUrl
      }
    }

    console.error(`${tag} spawning: ${piBinary} ${args.join(" ")}`)
    console.error(`${tag} cwd: ${opts.cwd}`)

    this.stream = createMessageStream()

    const proc = spawn(piBinary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: opts.cwd,
    })

    this.proc = proc

    // Emit init message
    this.stream.push({
      type: "system",
      subtype: "init",
    } as any)
    this.generating = false

    // Handle stdout (pi RPC events)
    proc.stdout?.on("data", (chunk: Buffer) => {
      this.lineBuf += chunk.toString("utf8")
      // Process complete JSON lines
      const lines = this.lineBuf.split("\n")
      this.lineBuf = lines.pop() || "" // keep incomplete line
      for (const line of lines) {
        if (!line.trim()) continue
        console.error(`${tag} stdout: ${line.slice(0, 300)}`)
        try {
          const event = JSON.parse(line)
          if (DEBUG) {
            console.error(`${tag} stdout: ${event.type}`)
          }

          // Handle RPC responses (pi sends these for command acknowledgements)
          if (event.type === "response") {
            if (event.command === "prompt" && event.success) {
              this.generating = true
            }
            continue
          }

          // Handle extension UI requests (auto-respond with defaults)
          if (event.type === "extension_ui_request") {
            this.handleExtensionUIRequest(event)
            continue
          }

          // Translate pi event to SDKMessage
          const sdkMsg = translatePiEvent(event)
          if (sdkMsg) {
            console.error(`${tag} → sdk: ${sdkMsg.type}${(sdkMsg as any).subtype ? "/" + (sdkMsg as any).subtype : ""}`)
          }
          if (sdkMsg && this.stream) {
            // Track generating state
            if (event.type === "agent_end" || event.type === "message_end") {
              this.generating = false
            } else if (event.type === "message_start") {
              this.generating = true
            }
            this.stream.push(sdkMsg)
          }
        } catch (e: any) {
          // Non-JSON output from pi (debug prints, etc.) — ignore
          if (DEBUG) {
            console.error(`${tag} non-JSON stdout: ${line.slice(0, 200)}`)
          }
        }
      }
    })

    // Handle stderr
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8")
      this.stderrBuf += text
      console.error(`${tag}:stderr ${text.trim()}`)
    })

    // Handle exit
    proc.on("exit", (code, sig) => {
      this.generating = false
      if (DEBUG) {
        console.error(`${tag} exited code=${code} sig=${sig ?? ""}`)
      }
      if (this.stream) {
        // Emit a result so the session knows the run is done
        this.stream.push({ type: "result" } as any)
        this.stream.end()
      }
    })

    proc.on("error", (e) => {
      console.error(`${tag} spawn error: ${e?.message}`)
      this.generating = false
      if (this.stream) {
        this.stream.push({ type: "error", message: e?.message } as any)
        this.stream.end()
      }
    })

    return this.stream.iter
  }

  sendUserMessage(msg: SDKUserMessage): void {
    if (!this.proc?.stdin) return

    // Extract text from SDKUserMessage
    let text = ""
    if (typeof msg.message?.content === "string") {
      text = msg.message.content
    } else if (Array.isArray(msg.message?.content)) {
      const textBlock = msg.message.content.find((b: any) => b.type === "text")
      text = textBlock?.text || ""
    }

    if (!text) return

    // Send as pi RPC prompt command
    const cmd = {
      type: "prompt",
      message: text,
    }

    console.error(`[pi:${this.proc?.pid ?? "?"}] sending prompt: ${text.slice(0, 100)}`)

    this.proc.stdin.write(JSON.stringify(cmd) + "\n")
    this.generating = true
  }

  async interrupt(): Promise<void> {
    if (!this.proc?.stdin) return
    // pi supports an "abort" command
    this.proc.stdin.write(JSON.stringify({ type: "abort" }) + "\n")
    this.generating = false
  }

  isGenerating(): boolean {
    return this.generating
  }

  async destroy(): Promise<void> {
    this.generating = false
    if (this.proc) {
      // Send shutdown signal
      try {
        this.proc.stdin?.end()
      } catch {}
      // Give it a moment to exit gracefully, then kill
      setTimeout(() => {
        try { this.proc?.kill("SIGTERM") } catch {}
      }, 2000)
      this.proc = null
    }
    if (this.stream) {
      this.stream.end()
      this.stream = null
    }
  }

  /**
   * Handle pi extension UI requests by auto-responding with defaults.
   * In the future, these could be forwarded to the loopat frontend.
   */
  private handleExtensionUIRequest(event: any): void {
    if (!this.proc?.stdin) return
    const id = event.id
    if (!id) return

    let response: any
    switch (event.method) {
      case "confirm":
        response = { type: "extension_ui_response", id, confirmed: true }
        break
      case "select":
        response = { type: "extension_ui_response", id, value: event.options?.[0] || "" }
        break
      case "input":
        response = { type: "extension_ui_response", id, value: "" }
        break
      default:
        response = { type: "extension_ui_response", id, cancelled: true }
        break
    }

    this.proc.stdin.write(JSON.stringify(response) + "\n")
  }
}
