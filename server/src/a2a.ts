/**
 * A2A (Agent-to-Agent) adapter — in-process, standard A2A (Google's Agent2Agent).
 *
 * Each loopat account is its own A2A agent:
 *   - GET  /a2a/<user>/agent-card.json   → that user's Agent Card
 *   - POST /a2a/<user>                   → JSON-RPC (message/send | message/stream)
 *
 * Auth is per-user: the caller presents that user's loopat API token
 * (`Authorization: Bearer la_…`). We validate the token resolves to <user> and
 * forward it to loopat's own `/api/v1` over loopback — which already does
 * per-token-user auth, loop creation, turn execution, and SSE — so this adapter
 * is a thin protocol translator (A2A ↔ /api/v1 SSE) that can't break web or
 * /api/v1. The A2A `contextId` (conversation) maps to a loopat loop.
 */
import { Hono, type Context } from "hono"
import { streamSSE } from "hono/streaming"
import { randomBytes } from "node:crypto"
import { resolveApiToken } from "./api-tokens"
import { loadA2AConfig, type A2AUserConfig } from "./config"

const A2A_PROTOCOL_VERSION = "0.3.0"
const SELF_BASE = `http://127.0.0.1:${process.env.PORT ?? 10001}`

// contextId (A2A conversation) → loopat loopId. In-memory: a restart starts a
// fresh conversation (acceptable for v1).
const ctxToLoop = new Map<string, string>()

function resolvePublicUrl(c: Context): string {
  const configured = process.env.LOOPAT_A2A_PUBLIC_URL
  if (configured) return configured.replace(/\/+$/, "")
  const proto = c.req.header("x-forwarded-proto") ?? "http"
  const host = c.req.header("host") ?? `127.0.0.1:${process.env.PORT ?? 10001}`
  return `${proto}://${host}`
}

function agentCard(user: string, publicUrl: string, cfg: A2AUserConfig) {
  const name = cfg.card?.name?.trim() || `Loopat Agent (${user})`
  const description = cfg.card?.description?.trim() ||
    "Self-hosted AI workspace (Claude Agent SDK). Runs development tasks in an isolated sandbox: writing code, reading repos, editing files, running commands, and researching."
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name,
    description,
    url: `${publicUrl}/a2a/${encodeURIComponent(user)}`,
    version: "1.0.0",
    preferredTransport: "JSONRPC",
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain"],
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer", description: "A loopat API token belonging to this user." },
    },
    security: [{ bearer: [] }],
    skills: [
      {
        id: "loopat_dev_turn",
        name: "General development task",
        description:
          "Run one development task in a loopat sandbox: write/edit code, read the repo, run commands, research, and return the result. Multi-turn within a conversation (reuse contextId to continue).",
        tags: ["coding", "agent", "dev", "sandbox"],
        examples: ["Add a health-check endpoint to the repo and make the tests pass."],
        inputModes: ["text/plain", "application/json"],
        outputModes: ["text/plain"],
      },
    ],
  }
}

type ParsedMsg = { text: string; contextId?: string; taskId?: string }

function parseMessage(params: any): ParsedMsg {
  const message = params?.message ?? {}
  let text = ""
  const parts = Array.isArray(message.parts) ? message.parts : []
  for (const p of parts) {
    if (p?.kind === "text" && typeof p.text === "string") { text += p.text }
    else if (p?.kind === "data" && p.data) {
      const d = p.data
      text += typeof d.message === "string" ? d.message
        : typeof d.text === "string" ? d.text
        : typeof d === "string" ? d : ""
    }
  }
  return {
    text: text.trim(),
    contextId: typeof message.contextId === "string" && message.contextId ? message.contextId : undefined,
    taskId: typeof message.taskId === "string" && message.taskId ? message.taskId : undefined,
  }
}

async function getOrCreateLoop(parsed: ParsedMsg, callerAuth: string, cfg: A2AUserConfig): Promise<{ loopId: string; contextId: string }> {
  let contextId = parsed.contextId
  if (contextId && ctxToLoop.has(contextId)) return { loopId: ctxToLoop.get(contextId)!, contextId }
  if (!contextId) contextId = `ctx_${randomBytes(8).toString("hex")}`

  const title = parsed.text.slice(0, 60) || "a2a"
  const res = await fetch(`${SELF_BASE}/api/v1/loops`, {
    method: "POST",
    headers: { authorization: callerAuth, "content-type": "application/json" },
    body: JSON.stringify({
      title,
      profiles: cfg.profiles && cfg.profiles.length ? cfg.profiles : undefined,
      vault: cfg.vault || undefined,
      metadata: { a2a_context_id: contextId },
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`loop create failed: ${res.status} ${body}`)
  }
  const loop = await res.json()
  const loopId = loop.id as string
  ctxToLoop.set(contextId, loopId)
  return { loopId, contextId }
}

type LoopatEvent = { event: string; data: any }

async function* loopbackTurn(loopId: string, content: string, taskId: string, callerAuth: string): AsyncGenerator<LoopatEvent> {
  const res = await fetch(`${SELF_BASE}/api/v1/loops/${loopId}/messages`, {
    method: "POST",
    headers: {
      authorization: callerAuth,
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

// ── Standard A2A streaming event builders ─────────────────────────────────
function artifactUpdate(reqId: unknown, taskId: string, contextId: string, artifactId: string, text: string, append: boolean, lastChunk: boolean) {
  return {
    jsonrpc: "2.0", id: reqId,
    result: {
      kind: "artifact-update",
      taskId, contextId, append, lastChunk,
      artifact: { artifactId, name: "response", parts: [{ kind: "text", text }] },
    },
  }
}
function statusUpdate(reqId: unknown, taskId: string, contextId: string, state: "working" | "completed" | "failed", final: boolean, errorText?: string) {
  const status: Record<string, unknown> = { state }
  if (errorText) {
    status.message = {
      kind: "message", role: "agent", messageId: `msg_${randomBytes(6).toString("hex")}`,
      parts: [{ kind: "text", text: errorText }], taskId, contextId,
    }
  }
  return { jsonrpc: "2.0", id: reqId, result: { kind: "status-update", taskId, contextId, status, final } }
}

async function handleStream(c: Context, reqId: unknown, parsed: ParsedMsg, callerAuth: string, cfg: A2AUserConfig) {
  return streamSSE(c, async (stream) => {
    const artifactId = `artifact_${randomBytes(8).toString("hex")}`
    const taskId = parsed.taskId || `task_${randomBytes(8).toString("hex")}`
    try {
      const { loopId, contextId } = await getOrCreateLoop(parsed, callerAuth, cfg)
      await stream.writeSSE({ data: JSON.stringify(statusUpdate(reqId, taskId, contextId, "working", false)) })
      let gotDelta = false
      let fallbackText: string | null = null
      let errMsg: string | undefined
      const finish = async () => {
        if (errMsg) {
          await stream.writeSSE({ data: JSON.stringify(statusUpdate(reqId, taskId, contextId, "failed", true, errMsg)) })
          return
        }
        if (!gotDelta && fallbackText) {
          await stream.writeSSE({ data: JSON.stringify(artifactUpdate(reqId, taskId, contextId, artifactId, fallbackText, false, false)) })
        }
        await stream.writeSSE({ data: JSON.stringify(artifactUpdate(reqId, taskId, contextId, artifactId, "", true, true)) })
        await stream.writeSSE({ data: JSON.stringify(statusUpdate(reqId, taskId, contextId, "completed", true)) })
      }
      for await (const ev of loopbackTurn(loopId, parsed.text, taskId, callerAuth)) {
        if (ev.event === "assistant_delta" && typeof ev.data?.text === "string") {
          await stream.writeSSE({ data: JSON.stringify(artifactUpdate(reqId, taskId, contextId, artifactId, ev.data.text, gotDelta, false)) })
          gotDelta = true
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
      const taskIdSafe = taskId
      await stream.writeSSE({ data: JSON.stringify(statusUpdate(reqId, taskIdSafe, parsed.contextId ?? "", "failed", true, e?.message ?? String(e))) })
    }
  })
}

async function handleSend(c: Context, reqId: unknown, parsed: ParsedMsg, callerAuth: string, cfg: A2AUserConfig) {
  const artifactId = `artifact_${randomBytes(8).toString("hex")}`
  const taskId = parsed.taskId || `task_${randomBytes(8).toString("hex")}`
  try {
    const { loopId, contextId } = await getOrCreateLoop(parsed, callerAuth, cfg)
    let full = ""
    let fallbackText: string | null = null
    let errMsg: string | undefined
    for await (const ev of loopbackTurn(loopId, parsed.text, taskId, callerAuth)) {
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
    // A2A Task object.
    return c.json({
      jsonrpc: "2.0",
      id: reqId,
      result: {
        kind: "task",
        id: taskId,
        contextId,
        status: { state: success ? "completed" : "failed" },
        artifacts: [{ artifactId, name: "response", parts: [{ kind: "text", text: full }] }],
      },
    })
  } catch (e: any) {
    return c.json({ jsonrpc: "2.0", id: reqId, error: { code: -32603, message: e?.message ?? String(e) } })
  }
}

export function buildA2A() {
  const a = new Hono()

  const cardHandler = async (c: Context) => {
    const user = c.req.param("user")
    if (!user) return c.json({ error: "not found" }, 404)
    const cfg = await loadA2AConfig(user)
    return c.json(agentCard(user, resolvePublicUrl(c), cfg))
  }
  a.get("/a2a/:user/agent-card.json", cardHandler)
  a.get("/a2a/:user/.well-known/agent-card.json", cardHandler)
  a.get("/a2a/:user/agent.json", cardHandler) // legacy filename alias

  a.post("/a2a/:user", async (c) => {
    const user = c.req.param("user")
    const rpc = await c.req.json().catch(() => null)
    const reqId = rpc?.id ?? null
    if (!rpc || typeof rpc.method !== "string") {
      return c.json({ jsonrpc: "2.0", id: reqId, error: { code: -32600, message: "invalid request" } }, 400)
    }
    // Per-user auth: the caller must present THIS user's loopat API token.
    const auth = c.req.header("authorization") ?? null
    const tokenUser = await resolveApiToken(auth)
    if (!tokenUser) {
      return c.json({ jsonrpc: "2.0", id: reqId, error: { code: -32000, message: "unauthorized: present a loopat API token" } }, 401)
    }
    if (tokenUser !== user) {
      return c.json({ jsonrpc: "2.0", id: reqId, error: { code: -32000, message: "token does not belong to this agent" } }, 403)
    }
    const cfg = await loadA2AConfig(user)
    const parsed = parseMessage(rpc.params)
    if (!parsed.text) {
      return c.json({ jsonrpc: "2.0", id: reqId, error: { code: -32602, message: "empty message" } }, 400)
    }
    if (rpc.method === "message/stream") return handleStream(c, reqId, parsed, auth!, cfg)
    if (rpc.method === "message/send") return handleSend(c, reqId, parsed, auth!, cfg)
    return c.json({ jsonrpc: "2.0", id: reqId, error: { code: -32601, message: `method not found: ${rpc.method}` } }, 404)
  })

  return a
}
