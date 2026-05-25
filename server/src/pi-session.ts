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

import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { BackendAdapter, BackendStartOptions, BackendType } from "./backend"
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

const DEBUG = !!process.env.LOOPAT_DEBUG || !!process.env.LOOPAT_DEBUG_PI

/**
 * Resolve the `pi` binary path. Checks:
 * 1. PI_BINARY env var (explicit override)
 * 2. `pi` on PATH (global install via npm/bun)
 */
function resolvePiBinary(): string {
  return process.env.PI_BINARY || "pi"
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
 * Translate a pi RPC event (AgentSessionEvent) into loopat's SDKMessage format.
 *
 * pi's event types we care about:
 * - message_start → SDKMessage type=assistant start
 * - message_delta → SDKMessage type=assistant content_block_delta
 * - message_end → SDKMessage type=assistant with final content
 * - tool_execution_start → SDKMessage type=tool_use
 * - tool_execution_end → SDKMessage type=tool_result
 * - agent_end → SDKMessage type=result
 */
function translatePiEvent(event: any): SDKMessage | null {
  if (!event || !event.type) return null

  const tag = "[pi→sdk]"

  switch (event.type) {
    // ── Assistant message lifecycle ──
    case "message_start": {
      // pi emits { type: "message_start", message: { role: "assistant", content: [...] } }
      const msg = event.message
      if (!msg) return null
      return {
        type: "assistant",
        subtype: "start",
        message: {
          role: "assistant",
          content: msg.content || [],
        },
      } as any
    }

    case "message_delta": {
      // pi emits { type: "message_delta", delta: { type: "text", text: "..." } }
      // or { type: "message_delta", delta: { type: "tool_use", ... } }
      return {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: event.delta || { type: "text_delta", text: "" },
        },
      } as any
    }

    case "message_end": {
      // pi emits { type: "message_end", message: { role: "assistant", content: [...] } }
      const msg = event.message
      if (!msg) return null
      return {
        type: "assistant",
        message: {
          role: "assistant",
          content: msg.content || [],
        },
      } as any
    }

    // ── Tool calls ──
    case "tool_execution_start": {
      // pi emits { type: "tool_execution_start", toolCall: { name, args, id } }
      const tc = event.toolCall
      if (!tc) return null
      return {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: tc.id || randomUUID(),
            name: tc.name,
            input: tc.args || {},
          }],
        },
      } as any
    }

    case "tool_execution_end": {
      // pi emits { type: "tool_execution_end", toolCall: { id, name }, result: { ... } }
      const tc = event.toolCall
      if (!tc) return null
      return {
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: tc.id,
            content: event.result?.output || event.result?.error || "",
          }],
        },
      } as any
    }

    // ── Streaming text deltas ──
    case "text_delta": {
      return {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: event.text || "" },
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

    // ── Thinking / reasoning ──
    case "thinking_start": {
      return {
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: { type: "thinking", thinking: "" },
        },
      } as any
    }

    case "thinking_delta": {
      return {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: event.text || "" },
        },
      } as any
    }

    // ── Other events: pass through as stream_event ──
    default: {
      // For unrecognized events, emit as a stream_event so the UI can
      // handle them if needed, but don't error out.
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
    const args = [
      "--mode", "rpc",
      "--cwd", opts.cwd,
    ]

    // Model override
    if (opts.model) {
      args.push("--model", opts.model)
    }

    // pi uses its own config dir; we can set it to be per-loop
    // via PI_CODING_AGENT_DIR env or --config-dir flag
    if (opts.backendConfig?.configDir) {
      args.push("--config-dir", opts.backendConfig.configDir)
    }

    // Build env: merge process.env + opts.env + pi-specific vars
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...opts.env,
      PI_CODING_AGENT: "true",
    }

    // If backendConfig specifies API keys, inject them
    if (opts.backendConfig?.apiKey) {
      env.PI_API_KEY = opts.backendConfig.apiKey
    }
    if (opts.backendConfig?.anthropicApiKey) {
      env.ANTHROPIC_API_KEY = opts.backendConfig.anthropicApiKey
    }
    if (opts.backendConfig?.openaiApiKey) {
      env.OPENAI_API_KEY = opts.backendConfig.openaiApiKey
    }

    if (DEBUG) {
      console.error(`${tag} spawning: ${piBinary} ${args.join(" ")}`)
    }

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
      for (const line of text.split("\n")) {
        if (line.trim()) console.error(`${tag}:stderr ${line}`)
      }
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

    if (DEBUG) {
      console.error(`[pi] sending prompt: ${text.slice(0, 100)}`)
    }

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
