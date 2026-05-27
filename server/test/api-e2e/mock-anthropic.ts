/**
 * Mock Anthropic Messages API for api-e2e tests.
 *
 * The mock plays the *model's* role only: scripted SSE responses dispatched
 * by a per-test marker in the first user message. The real claude binary
 * runs in the loop's podman sandbox and connects here via
 * ANTHROPIC_BASE_URL = http://127.0.0.1:<port>. CC executes its tools for
 * real; we only generate the assistant content blocks that tell it what to do.
 *
 * Why stateless dispatch (no per-conversation cursor): each request from CC
 * carries the full `messages` array, so we recompute the turn index every
 * call. That means a request retried by the SDK gets the same response —
 * the mock never gets "out of sync".
 */
import { randomUUID } from "node:crypto"

// ── public scenario shape ────────────────────────────────────────────────

export type MockBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown; id?: string }
  | { type: "end"; stop_reason: "end_turn" | "tool_use" }

export type Scenario = {
  /**
   * Substring matched against the first user message's text. The first
   * registered scenario whose marker is a substring of that text wins;
   * the empty string `""` matches anything (fallback).
   */
  marker: string
  /**
   * `turn` = number of model rounds already produced for this conversation.
   * turn 0 = the first user message just arrived; turn 1 = CC has sent a
   * tool_result back; etc. See `turnIndex()` below.
   */
  respond: (req: AnthropicRequest, turn: number) => Iterable<MockBlock>
}

export type AnthropicRequest = {
  model?: string
  messages: AnthropicMessage[]
  tools?: { name: string; input_schema?: unknown }[]
  system?: unknown
  // ...everything else ignored
}

export type AnthropicMessage = {
  role: "user" | "assistant"
  content: string | AnthropicContentBlock[]
}

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | unknown[]; is_error?: boolean }
  | { type: string; [k: string]: unknown }

// ── server ───────────────────────────────────────────────────────────────

export type MockServer = {
  port: number
  url: string
  register(s: Scenario): void
  clear(): void
  /** Inspect what scenarios were hit; useful for asserting "mock was called". */
  hits(marker: string): number
  /** Stop the HTTP listener. */
  close(): Promise<void>
  /** Log captured per request — useful when a test misbehaves. */
  requests: { ts: number; marker: string | null; turn: number; tools: string[] }[]
}

const FALLBACK: Scenario = {
  marker: "",
  *respond() {
    yield { type: "text", text: "ack" }
    yield { type: "end", stop_reason: "end_turn" }
  },
}

export async function startMockServer(opts: { port?: number } = {}): Promise<MockServer> {
  const scenarios: Scenario[] = []
  const hitCounts = new Map<string, number>()
  const requests: MockServer["requests"] = []

  const server = Bun.serve({
    port: opts.port ?? 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/v1/messages" && req.method === "POST") {
        return handleMessages(req, scenarios, hitCounts, requests)
      }
      // `/v1/messages/count_tokens` — return 404; SDK fallback is fine.
      return new Response(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not mocked" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })
    },
  })

  return {
    port: server.port,
    url: `http://127.0.0.1:${server.port}`,
    register(s) {
      scenarios.unshift(s) // LIFO — most-recent registration wins on overlap
    },
    clear() {
      scenarios.length = 0
      hitCounts.clear()
      requests.length = 0
    },
    hits(marker) {
      return hitCounts.get(marker) ?? 0
    },
    requests,
    async close() {
      server.stop(true)
    },
  }
}

// ── request handling ─────────────────────────────────────────────────────

async function handleMessages(
  req: Request,
  scenarios: Scenario[],
  hitCounts: Map<string, number>,
  requests: MockServer["requests"],
): Promise<Response> {
  let body: AnthropicRequest
  try {
    body = (await req.json()) as AnthropicRequest
  } catch (e) {
    return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad json" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })
  }

  const firstUser = allUserText(body.messages)
  const turn = turnIndex(body.messages)
  const scenario = scenarios.find((s) => firstUser.includes(s.marker)) ?? FALLBACK
  const markerKey = scenario.marker || "<fallback>"
  if (process.env.LOOPAT_MOCK_DEBUG) {
    console.error(`[mock] turn=${turn} first_user="${firstUser.slice(0, 120)}" → marker=${markerKey} (scenarios=${scenarios.length})`)
    console.error(`[mock] messages shape: ${body.messages.map((m) => `${m.role}:${typeof m.content === "string" ? m.content.slice(0, 60) : `[${(m.content as any[]).map((b) => b.type).join(",")}]`}`).join(" | ")}`)
    if (process.env.LOOPAT_MOCK_DEBUG === "full") {
      console.error(`[mock] full body: ${JSON.stringify(body).slice(0, 4000)}`)
    }
  }
  hitCounts.set(markerKey, (hitCounts.get(markerKey) ?? 0) + 1)
  requests.push({
    ts: Date.now(),
    marker: markerKey,
    turn,
    tools: (body.tools ?? []).map((t) => t.name),
  })

  const blocks = Array.from(scenario.respond(body, turn))

  const stream = buildSSEStream(blocks)
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "anthropic-request-id": "req_" + randomUUID().slice(0, 12),
    },
  })
}

/**
 * Concatenate every text-typed content block from every user-role message.
 * Used for marker matching. We pick "all user text" rather than "first user
 * message first text" because CC wraps the real user input alongside
 * `<system-reminder>` blocks — the marker can land in any of them.
 * `tool_result` content is also included via JSON.stringify so scenarios can
 * key on tool output if they want.
 */
function allUserText(messages: AnthropicMessage[]): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.role !== "user") continue
    if (typeof m.content === "string") {
      parts.push(m.content)
      continue
    }
    for (const b of m.content) {
      if (b.type === "text" && typeof (b as any).text === "string") parts.push((b as any).text)
      else if (b.type === "tool_result") parts.push(JSON.stringify((b as any).content))
    }
  }
  return parts.join("\n")
}

/** `turn = floor(messages.length / 2)`. After CC sends back a tool_result,
 * the messages array has grown by 2 (assistant w/ tool_use + user w/ tool_result),
 * so the next request to us increments the turn by 1. */
function turnIndex(messages: AnthropicMessage[]): number {
  return Math.floor(messages.length / 2)
}

/**
 * True if the *last* message is a user message carrying a `tool_result`
 * block — meaning CC just finished running a tool we asked for. Scenarios
 * use this to branch "first turn: emit tool_use" vs "tool finished: emit
 * final text".
 *
 * Robust against multi-message conversations where messages.length keeps
 * growing across separate POST /messages calls (each call adds 2+ entries).
 */
export function lastIsToolResult(req: AnthropicRequest): boolean {
  const last = req.messages.at(-1)
  if (!last || last.role !== "user" || typeof last.content === "string") return false
  return (last.content as AnthropicContentBlock[]).some((b) => b.type === "tool_result")
}

/** Concatenate all tool_result contents in the last user message (for
 * scenarios that want to look at what the tool output was). */
export function lastToolResultText(req: AnthropicRequest): string {
  const last = req.messages.at(-1)
  if (!last || last.role !== "user" || typeof last.content === "string") return ""
  const parts: string[] = []
  for (const b of last.content as AnthropicContentBlock[]) {
    if (b.type !== "tool_result") continue
    const c = (b as any).content
    if (typeof c === "string") parts.push(c)
    else if (Array.isArray(c)) {
      for (const item of c) {
        if (item?.type === "text" && typeof item.text === "string") parts.push(item.text)
      }
    }
  }
  return parts.join("\n")
}

// ── Anthropic SSE framing ────────────────────────────────────────────────

function buildSSEStream(blocks: MockBlock[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const messageId = "msg_" + randomUUID().slice(0, 12)
  // Anthropic stream events: message_start → (content_block_start, deltas, content_block_stop)*
  // → message_delta (with stop_reason) → message_stop
  return new ReadableStream({
    async pull(controller) {
      const write = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }

      // message_start
      write("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: "claude-mock",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      })

      let idx = 0
      let stopReason: "end_turn" | "tool_use" = "end_turn"

      for (const block of blocks) {
        if (block.type === "text") {
          write("content_block_start", {
            type: "content_block_start",
            index: idx,
            content_block: { type: "text", text: "" },
          })
          // Stream the text in one delta — chunk sizing doesn't matter to CC.
          write("content_block_delta", {
            type: "content_block_delta",
            index: idx,
            delta: { type: "text_delta", text: block.text },
          })
          write("content_block_stop", { type: "content_block_stop", index: idx })
          idx++
        } else if (block.type === "tool_use") {
          const id = block.id ?? "toolu_" + randomUUID().slice(0, 12)
          write("content_block_start", {
            type: "content_block_start",
            index: idx,
            content_block: { type: "tool_use", id, name: block.name, input: {} },
          })
          write("content_block_delta", {
            type: "content_block_delta",
            index: idx,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
          })
          write("content_block_stop", { type: "content_block_stop", index: idx })
          idx++
        } else if (block.type === "end") {
          stopReason = block.stop_reason
          break // any blocks after `end` are dropped
        }
      }

      // message_delta + message_stop close the turn.
      write("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 1 },
      })
      write("message_stop", { type: "message_stop" })

      controller.close()
    },
  })
}

// ── block helpers (re-exported through helpers.ts for convenience) ───────

export const blocks = {
  text(t: string): MockBlock {
    return { type: "text", text: t }
  },
  bash(command: string, opts: { run_in_background?: boolean; description?: string; timeout?: number } = {}): MockBlock {
    const input: Record<string, unknown> = { command }
    if (opts.run_in_background) input.run_in_background = true
    if (opts.description) input.description = opts.description
    if (opts.timeout) input.timeout = opts.timeout
    return { type: "tool_use", name: "Bash", input }
  },
  write(file_path: string, content: string): MockBlock {
    return { type: "tool_use", name: "Write", input: { file_path, content } }
  },
  read(file_path: string): MockBlock {
    return { type: "tool_use", name: "Read", input: { file_path } }
  },
  endTurn(): MockBlock {
    return { type: "end", stop_reason: "end_turn" }
  },
  endTool(): MockBlock {
    return { type: "end", stop_reason: "tool_use" }
  },
}
