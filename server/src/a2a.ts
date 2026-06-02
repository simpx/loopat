/**
 * A2A (Agent-to-Agent) adapter — in-process.
 *
 * Exposes loopat as an A2A sub-agent over standard A2A (Google's Agent2Agent):
 *   - GET  /.well-known/agent.json   → Agent Card
 *   - POST /a2a                      → JSON-RPC (message/send | message/stream)
 *
 * Design: this adapter does NOT touch loopat's session internals. It drives a
 * turn by calling loopat's own public `/api/v1` over loopback with a
 * service-account token, then translates the `/api/v1` SSE vocabulary into A2A
 * artifact events. Keeping it on the public API means a bug here can't break
 * web or `/api/v1` — see docs/api-v1.md for the upstream contract.
 */
import { Hono, type Context } from "hono"
import { streamSSE } from "hono/streaming"
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { LOOPAT_HOME } from "./paths"

type A2AConfig = { token: string; publicUrl?: string }

function loadConfig(): A2AConfig | null {
  const envToken = process.env.LOOPAT_A2A_TOKEN
  const envUrl = process.env.LOOPAT_A2A_PUBLIC_URL
  if (envToken) return { token: envToken, publicUrl: envUrl }
  const path = join(LOOPAT_HOME, "a2a.json")
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"))
      if (parsed && typeof parsed.token === "string" && parsed.token) {
        return { token: parsed.token, publicUrl: parsed.publicUrl || envUrl }
      }
    } catch { /* fall through */ }
  }
  return null
}

const SELF_BASE = `http://127.0.0.1:${process.env.PORT ?? 10001}`

const ctxToLoop = new Map<string, string>()

function agentCard(publicUrl: string) {
  return {
    name: "Loopat Agent",
    description:
      "Loopat is a self-hosted AI workspace (built on the Claude Agent SDK). This agent runs development tasks in an isolated sandbox: writing code, reading repos, editing files, running commands, and researching. Best for jobs that need an agent to actually do things, not just answer.",
    url: `${publicUrl}/a2a`,
    version: "1.0.0",
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["text/event-stream"],
    skills: [
      {
        id: "loopat_skill_dev_turn",
        name: "General development task",
        description:
          "Run one development task in a loopat sandbox: write/edit code, read the repo, run commands, research, and return the result. Multi-turn (context continues within a session).",
        tags: ["coding", "agent", "dev", "sandbox"],
        examples: [
          "User: add a health-check endpoint to the repo and make the tests pass\nReply: added /health and the unit tests pass…",
        ],
        inputModes: ["application/json"],
        outputModes: ["text/event-stream"],
        inputJsonSchema: {
          type: "object",
          properties: { message: { type: "string", description: "the user's natural-language instruction" } },
          required: ["message"],
        },
      },
    ],
  }
}

function resolvePublicUrl(c: Context, cfg: A2AConfig | null): string {
  if (cfg?.publicUrl) return cfg.publicUrl.replace(/\/+$/, "")
  const proto = c.req.header("x-forwarded-proto") ?? "http"
  const host = c.req.header("host") ?? `127.0.0.1:${process.env.PORT ?? 10001}`
  return `${proto}://${host}`
}

function artifactEvent(opts: {
  reqId: unknown
  artifactId: string
  taskId: string
  message: string
  index: number
  lastChunk: boolean
  success: boolean
  errorMsg?: string
}) {
  const metadata: Record<string, unknown> = {
    success: opts.success,
    forward: true,
    type: "DEFAULT",
    taskId: opts.taskId,
    index: opts.index,
    append: true,
    lastChunk: opts.lastChunk,
  }
  if (opts.errorMsg) metadata.errorMsg = opts.errorMsg
  return {
    jsonrpc: "2.0",
    id: opts.reqId,
    result: {
      artifact: {
        artifactId: opts.artifactId,
        name: "summary",
        metadata,
        parts: [{ kind: "data", data: { message: opts.message } }],
      },
    },
  }
}

function statusEvent(reqId: unknown, state: "completed" | "failed") {
  return { jsonrpc: "2.0", id: reqId, result: { status: { state } } }
}

type ParsedMsg = {
  text: string
  taskId: string
  contextId: string | undefined
  _meta?: any
}

function parseMessage(params: any): ParsedMsg {
  const message = params?.message ?? {}
  const meta = message.metadata ?? params?.metadata ?? {}
  let text = ""
  const parts = Array.isArray(message.parts) ? message.parts : []
  const first = parts[0]
  if (first) {
    if (first.kind === "data" && first.data) {
      text = typeof first.data.message === "string" ? first.data.message
        : typeof first.data.text === "string" ? first.data.text
        : typeof first.data === "string" ? first.data : JSON.stringify(first.data)
    } else if (first.kind === "text" && typeof first.text === "string") {
      text = first.text
    }
  }
  const taskId = (typeof meta.taskId === "string" && meta.taskId)
    ? meta.taskId
    : `task_${randomBytes(8).toString("hex")}`
  return { text, taskId, contextId: message.contextId ?? params?.contextId, _meta: meta }
}

async function getOrCreateLoop(parsed: ParsedMsg, cfg: A2AConfig): Promise<string> {
  const ctx = parsed.contextId
  if (ctx && ctxToLoop.has(ctx)) return ctxToLoop.get(ctx)!

  const title = parsed.text.slice(0, 60) || "a2a"
  const res = await fetch(`${SELF_BASE}/api/v1/loops`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      title,
      metadata: { a2a_context_id: ctx ?? "" },
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`loop create failed: ${res.status} ${body}`)
  }
  const loop = await res.json()
  const loopId = loop.id as string
  if (ctx) ctxToLoop.set(ctx, loopId)
  return loopId
}

type LoopatEvent = { event: string; data: any }

async function* loopbackTurn(loopId: string, content: string, taskId: string, cfg: A2AConfig): AsyncGenerator<LoopatEvent> {
  const res = await fetch(`${SELF_BASE}/api/v1/loops/${loopId}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.token}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      "idempotency-key": taskId,
    },
    body: JSON.stringify({ content, permission_mode: "bypassPermissions" }),
  })
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "")
    yield { event: "error", data: { code: "send_failed", message: `${res.status} ${body}` } }
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let curEvent = "message"
  let curData = ""
  const flush = (): LoopatEvent | null => {
    if (!curData) { curEvent = "message"; return null }
    let parsed: any = curData
    try { parsed = JSON.parse(curData) } catch { /* keep string */ }
    const ev = { event: curEvent, data: parsed }
    curEvent = "message"; curData = ""
    return ev
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const line of lines) {
      if (line === "") { const ev = flush(); if (ev) yield ev; continue }
      if (line.startsWith("event:")) curEvent = line.slice(6).trim()
      else if (line.startsWith("data:")) curData += line.slice(5).trim()
    }
  }
  const ev = flush(); if (ev) yield ev
}

function extractAssistantText(d: any): string | null {
  if (!d || d.type !== "assistant") return null
  const content = d.message?.content
  if (!Array.isArray(content)) return null
  const txt = content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("")
  return txt || null
}

function resultError(d: any): string | null {
  if (!d || d.type !== "result") return null
  if (d.is_error === true) return typeof d.result === "string" && d.result ? d.result : "agent error"
  return null
}

async function handleStream(c: Context, reqId: unknown, parsed: ParsedMsg, cfg: A2AConfig) {
  return streamSSE(c, async (stream) => {
    const artifactId = `artifact_${randomBytes(8).toString("hex")}`
    const index = 1
    try {
      const loopId = await getOrCreateLoop(parsed, cfg)
      let gotDelta = false
      let fallbackText: string | null = null
      let errMsg: string | undefined
      const finish = async () => {
        if (errMsg) {
          await stream.writeSSE({ data: JSON.stringify(artifactEvent({
            reqId, artifactId, taskId: parsed.taskId, message: errMsg,
            index, lastChunk: true, success: false, errorMsg: errMsg,
          })) })
          await stream.writeSSE({ data: JSON.stringify(statusEvent(reqId, "failed")) })
          return
        }
        // No streamed deltas but a final assistant block exists → surface it.
        if (!gotDelta && fallbackText) {
          await stream.writeSSE({ data: JSON.stringify(artifactEvent({
            reqId, artifactId, taskId: parsed.taskId, message: fallbackText,
            index, lastChunk: false, success: true,
          })) })
        }
        await stream.writeSSE({ data: JSON.stringify(artifactEvent({
          reqId, artifactId, taskId: parsed.taskId, message: "",
          index, lastChunk: true, success: true,
        })) })
        await stream.writeSSE({ data: JSON.stringify(statusEvent(reqId, "completed")) })
      }
      for await (const ev of loopbackTurn(loopId, parsed.text, parsed.taskId, cfg)) {
        if (ev.event === "assistant_delta" && typeof ev.data?.text === "string") {
          gotDelta = true
          await stream.writeSSE({ data: JSON.stringify(artifactEvent({
            reqId, artifactId, taskId: parsed.taskId, message: ev.data.text,
            index, lastChunk: false, success: true,
          })) })
        } else if (ev.event === "sdk_message") {
          const t = extractAssistantText(ev.data); if (t) fallbackText = t
          const e = resultError(ev.data); if (e) errMsg = e
        } else if (ev.event === "done") {
          await finish(); return
        } else if (ev.event === "error" || ev.event === "interrupted") {
          errMsg = ev.data?.message ?? ev.event
          await finish(); return
        }
      }
      await finish()
    } catch (e: any) {
      await stream.writeSSE({
        data: JSON.stringify(artifactEvent({
          reqId, artifactId, taskId: parsed.taskId, message: "",
          index, lastChunk: true, success: false, errorMsg: e?.message ?? String(e),
        })),
      })
      await stream.writeSSE({ data: JSON.stringify(statusEvent(reqId, "failed")) })
    }
  })
}

async function handleSend(c: Context, reqId: unknown, parsed: ParsedMsg, cfg: A2AConfig) {
  const artifactId = `artifact_${randomBytes(8).toString("hex")}`
  try {
    const loopId = await getOrCreateLoop(parsed, cfg)
    let full = ""
    let fallbackText: string | null = null
    let errMsg: string | undefined
    for await (const ev of loopbackTurn(loopId, parsed.text, parsed.taskId, cfg)) {
      if (ev.event === "assistant_delta" && typeof ev.data?.text === "string") full += ev.data.text
      else if (ev.event === "sdk_message") {
        const t = extractAssistantText(ev.data); if (t) fallbackText = t
        const e = resultError(ev.data); if (e) errMsg = e
      }
      else if (ev.event === "error" || ev.event === "interrupted") errMsg = ev.data?.message ?? ev.event
      else if (ev.event === "done") break
    }
    if (!full && fallbackText) full = fallbackText
    if (errMsg && !full) full = errMsg
    const success = !errMsg
    const metadata: Record<string, unknown> = {
      success, forward: true, type: "DEFAULT", taskId: parsed.taskId,
    }
    if (errMsg) metadata.errorMsg = errMsg
    return c.json({
      jsonrpc: "2.0",
      id: reqId,
      result: {
        id: parsed.taskId,
        status: { state: success ? "completed" : "failed" },
        artifacts: [{
          artifactId,
          name: "summary",
          metadata,
          parts: [{ kind: "data", data: { message: full } }],
        }],
      },
    })
  } catch (e: any) {
    return c.json({ jsonrpc: "2.0", id: reqId, error: { code: -32603, message: e?.message ?? String(e) } })
  }
}

export function buildA2A() {
  const a = new Hono()

  const cardHandler = (c: Context) => {
    const cfg = loadConfig()
    return c.json(agentCard(resolvePublicUrl(c, cfg)))
  }
  a.get("/.well-known/agent.json", cardHandler)
  a.get("/.well-known/agent-card.json", cardHandler)
  a.get("/a2a/.well-known/agent.json", cardHandler)

  a.post("/a2a", async (c) => {
    const cfg = loadConfig()
    const rpc = await c.req.json().catch(() => null)
    const reqId = rpc?.id ?? null
    if (!rpc || typeof rpc.method !== "string") {
      return c.json({ jsonrpc: "2.0", id: reqId, error: { code: -32600, message: "invalid request" } }, 400)
    }
    if (!cfg) {
      return c.json({ jsonrpc: "2.0", id: reqId, error: { code: -32000, message: "a2a not configured (missing service token)" } }, 503)
    }
    const parsed = parseMessage(rpc.params)
    if (!parsed.text) {
      return c.json({ jsonrpc: "2.0", id: reqId, error: { code: -32602, message: "empty message" } }, 400)
    }
    if (rpc.method === "message/stream") return handleStream(c, reqId, parsed, cfg)
    if (rpc.method === "message/send") return handleSend(c, reqId, parsed, cfg)
    return c.json({ jsonrpc: "2.0", id: reqId, error: { code: -32601, message: `method not found: ${rpc.method}` } }, 404)
  })

  return a
}
