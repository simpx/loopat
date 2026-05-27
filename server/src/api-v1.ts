/**
 * Loop API v1 — see docs/api-v1.md.
 *
 * Public surface: just "chat with a loop". CRUD on loops + send message (SSE)
 * + watch events (SSE) + answer choices + interrupt.
 *
 * All other web features (loop-list status, kanban, terminal, token usage
 * meter, DM/channels) continue to use their existing WS or internal REST.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono"
import { streamSSE } from "hono/streaming"
import { Scalar } from "@scalar/hono-api-reference"
import { randomBytes } from "node:crypto"
import { getRequestUserId } from "./auth"
import { resolveApiToken, createApiToken, listApiTokens, revokeApiToken } from "./api-tokens"
import { v1OpenApiSpec } from "./api-v1-openapi"
import {
  createLoop as internalCreateLoop,
  getLoop,
  listLoops,
  loopExists,
  patchLoopMeta,
  type LoopMeta,
} from "./loops"
import { getSession, type LoopSessionMessageListener } from "./session"

// ── ID prefixing ─────────────────────────────────────────────────────────

const LOOP_PREFIX = "loop_"
const TURN_PREFIX = "turn_"
const CHOICE_PREFIX = "choice_"

function loopIdToApi(rawId: string): string {
  return rawId.startsWith(LOOP_PREFIX) ? rawId : `${LOOP_PREFIX}${rawId}`
}
function loopIdFromApi(apiId: string): string {
  return apiId.startsWith(LOOP_PREFIX) ? apiId.slice(LOOP_PREFIX.length) : apiId
}
function genTurnId(): string {
  return `${TURN_PREFIX}${randomBytes(10).toString("hex")}`
}
function choiceIdToApi(toolUseId: string): string {
  return toolUseId.startsWith(CHOICE_PREFIX) ? toolUseId : `${CHOICE_PREFIX}${toolUseId}`
}
function choiceIdFromApi(apiId: string): string {
  return apiId.startsWith(CHOICE_PREFIX) ? apiId.slice(CHOICE_PREFIX.length) : apiId
}

// ── Auth: cookie OR Bearer ───────────────────────────────────────────────

async function resolveCaller(c: Context): Promise<string | null> {
  // Try cookie session first (web same-origin), then Bearer token.
  const sessionUser = getRequestUserId(c)
  if (sessionUser) return sessionUser
  const auth = c.req.header("authorization") ?? null
  return await resolveApiToken(auth)
}

const requireApiAuth: MiddlewareHandler = async (c, next) => {
  const userId = await resolveCaller(c)
  if (!userId) {
    return c.json({
      error: { type: "authentication_error", code: "missing_credentials", message: "missing or invalid credentials" },
    }, 401)
  }
  c.set("userId", userId)
  await next()
}

// ── Error helper ─────────────────────────────────────────────────────────

function apiError(c: Context, status: number, type: string, code: string, message: string) {
  return c.json({ error: { type, code, message } }, status as any)
}

// ── Loop resource shape ──────────────────────────────────────────────────

function metaToApi(meta: LoopMeta, opts: { withRuntime: boolean } = { withRuntime: false }) {
  const base: Record<string, unknown> = {
    id: loopIdToApi(meta.id),
    title: meta.title,
    created_at: meta.createdAt,
    created_by: meta.createdBy,
    archived: !!meta.archived,
    archived_at: meta.archivedAt ?? null,
    metadata: (meta as any).metadata ?? {},
    profiles: meta.config?.profiles ?? [],
    vault: meta.config?.vault ?? "default",
    repo: meta.repo ?? null,
  }
  if (opts.withRuntime) {
    const session = getSession(meta.id)
    const busy = session.isBusy()
    base.busy = busy
    base.queue_depth = session.getQueueLength()
    const currentChoice = pendingChoiceFor(meta.id)
    base.current_turn = busy
      ? {
          turn_id: currentTurnIdFor(meta.id) ?? null,
          started_at: currentTurnStartedAtFor(meta.id) ?? null,
          pending_choice_id: currentChoice ?? null,
        }
      : null
  }
  return base
}

// ── Per-loop runtime trackers (in-memory) ────────────────────────────────
//
// MVP: track the current turn id + start time and the latest pending choice
// for each loop in memory. Used only to surface `current_turn` / snapshot
// state via the API; not authoritative — if the server restarts, the loop
// continues but these trackers reset.

type LoopRuntime = {
  currentTurnId?: string
  currentTurnStartedAt?: string
  currentAssistantText: string
  pendingChoiceId?: string
}
const loopRuntime = new Map<string, LoopRuntime>()
function rt(loopId: string): LoopRuntime {
  let r = loopRuntime.get(loopId)
  if (!r) {
    r = { currentAssistantText: "" }
    loopRuntime.set(loopId, r)
  }
  return r
}
function currentTurnIdFor(id: string): string | undefined { return loopRuntime.get(id)?.currentTurnId }
function currentTurnStartedAtFor(id: string): string | undefined { return loopRuntime.get(id)?.currentTurnStartedAt }
function pendingChoiceFor(id: string): string | undefined { return loopRuntime.get(id)?.pendingChoiceId }

// ── SDK message → v1 SSE event mapping ───────────────────────────────────

type V1Event = { event: string; data: Record<string, unknown> }

/**
 * Pass-through event that emits the raw SDK / session-broadcast message
 * verbatim. Loopat's own web UI consumes this to drive its rich chat view
 * without forcing the team to rewrite its SDK-shaped dispatch pipeline.
 *
 * Bot frameworks should NOT depend on the shape — it's the underlying
 * Anthropic SDK message format, which can change. The stable bot-facing
 * events (assistant_delta, tool_call, etc.) are what's contractual.
 */
function sdkPassthrough(msg: any): V1Event | null {
  if (!msg || typeof msg !== "object") return null
  if (typeof msg.type !== "string") return null
  // Skip our own synthetic control events — they don't represent a real
  // session-broadcast message worth replaying.
  if (msg.type === "choice_resolved" || msg.type === "interrupted") return null
  return { event: "sdk_message", data: msg as Record<string, unknown> }
}

function mapSdkMessageToV1(msg: any, runtime: LoopRuntime): V1Event[] {
  const out: V1Event[] = []
  const type = msg?.type

  // Fine-grained streaming deltas via stream_event.
  if (type === "stream_event") {
    const ev = msg.event
    if (ev?.type === "content_block_delta") {
      const delta = ev.delta
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        runtime.currentAssistantText += delta.text
        out.push({ event: "assistant_delta", data: { text: delta.text } })
      } else if (delta?.type === "thinking_delta" && typeof delta.text === "string") {
        out.push({ event: "thinking_delta", data: { text: delta.text } })
      }
    }
    return out
  }

  // tool_call from assistant content blocks; tool_result from synthetic user content blocks.
  if (type === "assistant" && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block?.type === "tool_use" && typeof block.id === "string") {
        out.push({
          event: "tool_call",
          data: {
            tool_use_id: block.id,
            tool: block.name ?? "unknown",
            input_summary: summarizeToolInput(block.input),
          },
        })
      }
    }
    return out
  }
  if (type === "user" && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        out.push({
          event: "tool_result",
          data: { tool_use_id: block.tool_use_id, ok: !block.is_error },
        })
      }
    }
    return out
  }

  // Choices.
  if (type === "permission_prompt" && typeof msg.tool_use_id === "string") {
    const choiceId = choiceIdToApi(msg.tool_use_id)
    runtime.pendingChoiceId = choiceId
    out.push({
      event: "requires_choice",
      data: {
        choice_id: choiceId,
        kind: "permission",
        payload: {
          tool: msg.tool_name,
          title: msg.title,
          display_name: msg.displayName,
        },
      },
    })
    return out
  }
  if (type === "question" && typeof msg.tool_use_id === "string") {
    const choiceId = choiceIdToApi(msg.tool_use_id)
    runtime.pendingChoiceId = choiceId
    out.push({
      event: "requires_choice",
      data: {
        choice_id: choiceId,
        kind: "question",
        payload: { questions: msg.questions },
      },
    })
    return out
  }

  if (type === "result") {
    const turnId = runtime.currentTurnId ?? genTurnId()
    out.push({ event: "done", data: { turn_id: turnId } })
    runtime.currentTurnId = undefined
    runtime.currentTurnStartedAt = undefined
    runtime.currentAssistantText = ""
    return out
  }

  if (type === "error") {
    out.push({ event: "error", data: { code: "agent_error", message: msg.message ?? "agent error" } })
    return out
  }

  // Synthetic control events (emitted by api-v1 itself via session.notifyListeners).
  if (type === "choice_resolved") {
    return [{ event: "choice_resolved", data: { choice_id: msg.choice_id, source: msg.source ?? "api" } }]
  }
  if (type === "interrupted") {
    return [{ event: "interrupted", data: { turn_id: msg.turn_id ?? runtime.currentTurnId ?? "" } }]
  }

  // Everything else (queue_update / provider / goal / viewers / context_usage / etc)
  // is web-UI noise — drop.
  return out
}

function summarizeToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  // Best-effort one-line summary for observability. Don't dump full input.
  try {
    const obj = input as Record<string, unknown>
    if (typeof obj.command === "string") return obj.command
    if (typeof obj.file_path === "string") return obj.file_path
    if (typeof obj.path === "string") return obj.path
    if (typeof obj.query === "string") return obj.query
    if (typeof obj.url === "string") return obj.url
    return undefined
  } catch {
    return undefined
  }
}

// ── Idempotency store ────────────────────────────────────────────────────
//
// In-memory MVP. Single-process loopat means this is fine; restart drops
// records, which is acceptable for a 24h replay window.

type IdempotencyRecord = {
  userId: string
  requestHash: string
  events: V1Event[]
  done: boolean
  createdAt: number
}
const idempotencyStore = new Map<string, IdempotencyRecord>()
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

function idempotencyKey(userId: string, key: string): string {
  return `${userId}|${key}`
}

function sweepIdempotency(): void {
  const now = Date.now()
  for (const [k, v] of idempotencyStore) {
    if (now - v.createdAt > IDEMPOTENCY_TTL_MS) idempotencyStore.delete(k)
  }
}

function hashRequest(content: string): string {
  // Cheap content-based hash; collisions on the same userId+key are vanishingly
  // unlikely for the dedup use case (caller usually retries with the same body).
  let h = 0
  for (let i = 0; i < content.length; i++) h = (h * 31 + content.charCodeAt(i)) | 0
  return h.toString(16)
}

// ── App ──────────────────────────────────────────────────────────────────

type Variables = { userId: string }

export function buildApiV1(): Hono<{ Variables: Variables }> {
  const v1 = new Hono<{ Variables: Variables }>()

  // ── Docs ─────────────────────────────────────────────────────────────
  // Machine-readable spec + interactive reference. No auth needed.
  v1.get("/openapi.json", (c) => c.json(v1OpenApiSpec as any))
  v1.get(
    "/docs",
    Scalar({
      url: "/api/v1/openapi.json",
      pageTitle: "Loopat Loop API v1",
      theme: "default",
    }),
  )

  // ── Token management (cookie-only — bot frameworks cannot self-issue) ─

  v1.post("/me/tokens", async (c) => {
    const userId = getRequestUserId(c)
    if (!userId) return apiError(c, 401, "authentication_error", "missing_credentials", "session required")
    const body = await c.req.json().catch(() => ({}))
    const label = typeof body.label === "string" ? body.label : ""
    const t = await createApiToken(userId, label)
    return c.json({ tokenId: t.tokenId, token: t.token, label: t.label, createdAt: t.createdAt }, 201)
  })

  v1.get("/me/tokens", async (c) => {
    const userId = getRequestUserId(c)
    if (!userId) return apiError(c, 401, "authentication_error", "missing_credentials", "session required")
    const tokens = await listApiTokens(userId)
    return c.json({ tokens })
  })

  v1.delete("/me/tokens/:tokenId", async (c) => {
    const userId = getRequestUserId(c)
    if (!userId) return apiError(c, 401, "authentication_error", "missing_credentials", "session required")
    const ok = await revokeApiToken(userId, c.req.param("tokenId") ?? "")
    if (!ok) return apiError(c, 404, "not_found_error", "token_not_found", "no such token")
    return c.body(null, 204)
  })

  // ── Loop CRUD ───────────────────────────────────────────────────────

  v1.post("/loops", requireApiAuth, async (c) => {
    const userId = c.get("userId") as string
    const body = await c.req.json().catch(() => ({}))
    const title = typeof body.title === "string" ? body.title.trim() : ""
    if (title.length > 200) return apiError(c, 400, "invalid_request_error", "title_too_long", "title exceeds 200 chars")

    const profiles = Array.isArray(body.profiles)
      ? body.profiles.filter((p: unknown): p is string => typeof p === "string")
      : undefined
    const vault = typeof body.vault === "string" ? body.vault : undefined
    const repo = typeof body.repo === "string" && body.repo ? body.repo : undefined
    const metadata = (body.metadata && typeof body.metadata === "object") ? body.metadata as Record<string, unknown> : undefined
    if (metadata && JSON.stringify(metadata).length > 16 * 1024) {
      return apiError(c, 400, "invalid_request_error", "metadata_too_large", "metadata exceeds 16 KB")
    }

    const meta = await internalCreateLoop({
      title: title || "untitled",
      createdBy: userId,
      profiles,
      vault,
      repo,
    })
    if (metadata) {
      const patched = await patchLoopMeta(meta.id, { metadata })
      if (patched) return c.json(metaToApi(patched), 201)
    }
    return c.json(metaToApi(meta), 201)
  })

  v1.get("/loops", requireApiAuth, async (c) => {
    const userId = c.get("userId") as string
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "20", 10) || 20, 1), 100)
    const after = c.req.query("after")
    const before = c.req.query("before")
    const includeArchived = c.req.query("archived") === "true"

    const all = (await listLoops()).filter((m) => m.createdBy === userId && (includeArchived || !m.archived))

    let filtered = all
    if (after) {
      const rawAfter = loopIdFromApi(after)
      const idx = all.findIndex((m) => m.id === rawAfter)
      filtered = idx >= 0 ? all.slice(idx + 1) : []
    } else if (before) {
      const rawBefore = loopIdFromApi(before)
      const idx = all.findIndex((m) => m.id === rawBefore)
      filtered = idx >= 0 ? all.slice(0, idx) : []
    }

    const page = filtered.slice(0, limit)
    const hasMore = filtered.length > limit
    return c.json({
      data: page.map((m) => metaToApi(m)),
      first_id: page[0] ? loopIdToApi(page[0].id) : null,
      last_id: page[page.length - 1] ? loopIdToApi(page[page.length - 1].id) : null,
      has_more: hasMore,
    })
  })

  v1.get("/loops/:id", requireApiAuth, async (c) => {
    const userId = c.get("userId") as string
    const id = loopIdFromApi(c.req.param("id") ?? "")
    const meta = await getLoop(id)
    if (!meta) return apiError(c, 404, "not_found_error", "loop_not_found", "loop not found")
    if (meta.createdBy !== userId) return apiError(c, 403, "permission_error", "not_loop_owner", "not your loop")
    return c.json(metaToApi(meta, { withRuntime: true }))
  })

  v1.delete("/loops/:id", requireApiAuth, async (c) => {
    const userId = c.get("userId") as string
    const id = loopIdFromApi(c.req.param("id") ?? "")
    const meta = await getLoop(id)
    if (!meta) return apiError(c, 404, "not_found_error", "loop_not_found", "loop not found")
    if (meta.createdBy !== userId) return apiError(c, 403, "permission_error", "not_loop_owner", "not your loop")
    if (!meta.archived) {
      await patchLoopMeta(id, { archived: true, archivedAt: new Date().toISOString() } as any)
    }
    return c.body(null, 204)
  })

  // ── Send message (SSE) ──────────────────────────────────────────────

  v1.post("/loops/:id/messages", requireApiAuth, async (c) => {
    const userId = c.get("userId") as string
    const id = loopIdFromApi(c.req.param("id") ?? "")
    if (!(await loopExists(id))) {
      return apiError(c, 404, "not_found_error", "loop_not_found", "loop not found")
    }
    const meta = await getLoop(id)
    if (!meta) return apiError(c, 404, "not_found_error", "loop_not_found", "loop not found")
    if (meta.createdBy !== userId) return apiError(c, 403, "permission_error", "not_loop_owner", "not your loop")
    if (meta.archived) return apiError(c, 400, "invalid_request_error", "loop_archived", "loop is archived")

    const body = await c.req.json().catch(() => ({}))
    const content = typeof body.content === "string" ? body.content : ""
    if (!content) return apiError(c, 400, "invalid_request_error", "missing_content", "content required")
    if (content.length > 1024 * 1024) return apiError(c, 400, "invalid_request_error", "content_too_large", "content exceeds 1 MB")
    const VALID_MODES = new Set(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"])
    const permissionMode = typeof body.permission_mode === "string" && VALID_MODES.has(body.permission_mode)
      ? body.permission_mode as "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto"
      : undefined

    // Idempotency check.
    sweepIdempotency()
    const idemKeyHeader = c.req.header("idempotency-key")
    const reqHash = hashRequest(content)
    let idemRecord: IdempotencyRecord | undefined
    if (idemKeyHeader) {
      if (idemKeyHeader.length > 256) {
        return apiError(c, 400, "invalid_request_error", "idempotency_key_too_long", "Idempotency-Key exceeds 256 chars")
      }
      const fullKey = idempotencyKey(userId, idemKeyHeader)
      idemRecord = idempotencyStore.get(fullKey)
      if (idemRecord && idemRecord.requestHash !== reqHash) {
        return apiError(c, 409, "conflict_error", "idempotency_key_reused",
          "Idempotency-Key was previously used with a different request body")
      }
      if (!idemRecord) {
        idemRecord = { userId, requestHash: reqHash, events: [], done: false, createdAt: Date.now() }
        idempotencyStore.set(fullKey, idemRecord)
      }
    }

    return streamSSE(c, async (stream) => {
      const session = getSession(id)
      const runtime = rt(id)
      const wasBusy = session.isBusy()

      // Emit (and replay-record) one event.
      const emit = async (ev: V1Event) => {
        idemRecord?.events.push(ev)
        await stream.writeSSE({ event: ev.event, data: JSON.stringify(ev.data) })
      }

      const isReplay = !!idemRecord && idemRecord.events.length > 0

      if (isReplay) {
        for (const ev of idemRecord!.events) {
          await stream.writeSSE({ event: ev.event, data: JSON.stringify(ev.data) })
        }
        if (idemRecord!.done) return
        // Still in progress — attach to live stream below; do NOT re-send content.
      } else {
        if (wasBusy) {
          await emit({ event: "queued", data: { position: session.getQueueLength() + 1 } })
        }
        const turnId = genTurnId()
        runtime.currentTurnId = turnId
        runtime.currentTurnStartedAt = new Date().toISOString()
        runtime.currentAssistantText = ""
        await emit({ event: "started", data: { turn_id: turnId, cold_start: false } })
      }

      let closeFn: () => void = () => {}
      const closedPromise = new Promise<void>((resolve) => { closeFn = resolve })
      let closed = false
      const finishStream = () => {
        if (closed) return
        closed = true
        if (idemRecord) idemRecord.done = true
        closeFn()
      }

      const unsubscribe = session.onMessage((msg) => {
        if (closed) return
        // Gather every emit() promise for this message — when a terminal
        // event (done/interrupted/error) arrives, we MUST wait for all
        // SSE writes from the SAME batch to flush before calling
        // finishStream(). Otherwise streamSSE's finally{stream.close()}
        // races the pending writeSSE, and the client never sees `done`.
        const pending: Promise<void>[] = []
        const raw = sdkPassthrough(msg)
        if (raw) pending.push(emit(raw).catch(() => {}))
        let terminal = false
        for (const ev of mapSdkMessageToV1(msg, runtime)) {
          pending.push(emit(ev).catch(() => {}))
          if (ev.event === "done" || ev.event === "interrupted" || ev.event === "error") {
            terminal = true
          }
        }
        if (terminal) {
          Promise.all(pending).finally(() => finishStream())
        }
      })

      const heartbeat = setInterval(() => {
        if (!closed) stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {})
      }, 15_000)

      if (!isReplay) {
        session.sendUserText(content, permissionMode).catch(async (e: any) => {
          await emit({ event: "error", data: { code: "send_failed", message: e?.message ?? String(e) } })
          finishStream()
        })
      }

      stream.onAbort(() => { finishStream() })

      await closedPromise
      unsubscribe()
      clearInterval(heartbeat)
    })
  })

  // ── Watch events (read-only SSE) ────────────────────────────────────

  v1.get("/loops/:id/events", requireApiAuth, async (c) => {
    const userId = c.get("userId") as string
    const id = loopIdFromApi(c.req.param("id") ?? "")
    const meta = await getLoop(id)
    if (!meta) return apiError(c, 404, "not_found_error", "loop_not_found", "loop not found")
    if (meta.createdBy !== userId) return apiError(c, 403, "permission_error", "not_loop_owner", "not your loop")

    return streamSSE(c, async (stream) => {
      const session = getSession(id)
      const runtime = rt(id)

      // Snapshot if a turn is currently running.
      if (session.isBusy() && runtime.currentTurnId) {
        await stream.writeSSE({
          event: "snapshot",
          data: JSON.stringify({
            turn_id: runtime.currentTurnId,
            assistant_text_so_far: runtime.currentAssistantText,
            pending_choice_id: runtime.pendingChoiceId ?? null,
          }),
        })
      }

      let closed = false
      const unsubscribe = session.onMessage((msg) => {
        if (closed) return
        const raw = sdkPassthrough(msg)
        if (raw) stream.writeSSE({ event: raw.event, data: JSON.stringify(raw.data) }).catch(() => {})
        for (const ev of mapSdkMessageToV1(msg, runtime)) {
          stream.writeSSE({ event: ev.event, data: JSON.stringify(ev.data) }).catch(() => {})
        }
      })

      const heartbeat = setInterval(() => {
        if (!closed) stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {})
      }, 15_000)

      stream.onAbort(() => {
        closed = true
        unsubscribe()
        clearInterval(heartbeat)
      })

      // Block until client disconnects.
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (closed) {
            clearInterval(check)
            clearInterval(heartbeat)
            resolve()
          }
        }, 1000)
      })
    })
  })

  // ── Answer choice (permission / question) ───────────────────────────

  v1.post("/loops/:id/choices/:choiceId", requireApiAuth, async (c) => {
    const userId = c.get("userId") as string
    const id = loopIdFromApi(c.req.param("id") ?? "")
    const choiceId = c.req.param("choiceId") ?? ""
    const toolUseId = choiceIdFromApi(choiceId)

    const meta = await getLoop(id)
    if (!meta) return apiError(c, 404, "not_found_error", "loop_not_found", "loop not found")
    if (meta.createdBy !== userId) return apiError(c, 403, "permission_error", "not_loop_owner", "not your loop")

    const body = await c.req.json().catch(() => ({}))
    const session = getSession(id)
    const runtime = rt(id)

    // Permission path
    if (typeof body.allow === "boolean") {
      const pending = session.hasPendingPermission(toolUseId)
      if (!pending) return apiError(c, 404, "not_found_error", "choice_not_found", "choice not pending")
      await session.answerPermission(toolUseId, body.allow)
      runtime.pendingChoiceId = undefined
      session.notifyListeners({ type: "choice_resolved", choice_id: choiceIdToApi(toolUseId), source: "api" })
      return c.body(null, 202)
    }

    // Question path
    if (body.answers && typeof body.answers === "object") {
      const pending = session.hasPendingQuestion(toolUseId)
      if (!pending) return apiError(c, 404, "not_found_error", "choice_not_found", "choice not pending")
      await session.answerQuestions(toolUseId, body.answers as Record<string, string>)
      runtime.pendingChoiceId = undefined
      session.notifyListeners({ type: "choice_resolved", choice_id: choiceIdToApi(toolUseId), source: "api" })
      return c.body(null, 202)
    }

    return apiError(c, 400, "invalid_request_error", "invalid_choice_payload",
      "expected { allow: bool } for permission or { answers: {...} } for question")
  })

  // ── Interrupt ───────────────────────────────────────────────────────

  v1.post("/loops/:id/interrupt", requireApiAuth, async (c) => {
    const userId = c.get("userId") as string
    const id = loopIdFromApi(c.req.param("id") ?? "")
    const meta = await getLoop(id)
    if (!meta) return apiError(c, 404, "not_found_error", "loop_not_found", "loop not found")
    if (meta.createdBy !== userId) return apiError(c, 403, "permission_error", "not_loop_owner", "not your loop")
    const session = getSession(id)
    const runtime = rt(id)
    const turnId = runtime.currentTurnId
    await session.interrupt()
    if (turnId) {
      session.notifyListeners({ type: "interrupted", turn_id: turnId })
    }
    return c.body(null, 202)
  })

  return v1
}
