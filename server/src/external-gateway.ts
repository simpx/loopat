import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createLoop, getLoop, patchLoopMeta, provisionUserPersonal } from "./loops"
import { LOOPAT_HOME } from "./paths"
import { getSession } from "./session"
import { resolveGatewayUser } from "./gateway-tokens"

// ── Request type ──

export type ExternalTurnRequest = {
  turnId?: string
  externalSource?: string
  externalThreadId?: string
  externalUserId?: string
  message?: string
  title?: string
  metadata?: Record<string, unknown>
  traceId?: string
  mock?: boolean
}

// ── Loop mapping (externalSource:externalThreadId → loopId) ──

type LoopMap = Record<string, string>

const LOOP_MAP_PATH = join(LOOPAT_HOME, "external-gateway", "thread-loop-map.json")

/**
 * In-process mutex for loop-map read-modify-write. Prevents concurrent
 * requests from overwriting each other's mappings. loopat is single-process
 * so a simple promise chain suffices — no file-level locking needed.
 */
let loopMapLock: Promise<void> = Promise.resolve()

function withLoopMapLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = loopMapLock.then(fn, fn)
  loopMapLock = next.then(() => {}, () => {})
  return next
}

async function readLoopMap(): Promise<LoopMap> {
  try {
    return JSON.parse(await readFile(LOOP_MAP_PATH, "utf8")) as LoopMap
  } catch {
    return {}
  }
}

async function writeLoopMap(map: LoopMap) {
  await mkdir(dirname(LOOP_MAP_PATH), { recursive: true })
  await writeFile(LOOP_MAP_PATH, JSON.stringify(map, null, 2))
}

// ── SSE helpers ──

export function externalSseHeaders(): HeadersInit {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  }
}

function sseEncode(event: string, data: unknown): string {
  const payload = JSON.stringify(data ?? {})
  return `event: ${event}\ndata: ${payload}\n\n`
}

function textDeltaFromMessage(msg: any): string {
  const ev = msg?.type === "stream_event" ? msg.event : msg
  if (ev?.type !== "content_block_delta") return ""
  const delta = ev.delta || ev.data
  if (delta?.type === "text_delta" && typeof delta.text === "string") return delta.text
  if (delta?.type === "text" && typeof delta.text === "string") return delta.text
  return ""
}

// ── Mapping key ──

function mappingKey(req: ExternalTurnRequest): string {
  const externalSource = (req.externalSource || "unknown").trim().toLowerCase()
  const externalThreadId = (req.externalThreadId || "").trim()
  if (!externalThreadId) throw new Error("externalThreadId required")
  return `${externalSource}:${externalThreadId}`
}

// ── Loop resolution ──

function titleForTurn(req: ExternalTurnRequest): string {
  const source = (req.externalSource || "external").trim()
  const title = (req.title || req.externalThreadId || "conversation").trim()
  return `${source} - ${title}`.slice(0, 120)
}

export function resolveExternalLoop(
  req: ExternalTurnRequest,
  ownerUserId: string,
): Promise<string> {
  return withLoopMapLock(async () => {
    const key = mappingKey(req)
    const map = await readLoopMap()
    const existing = map[key]
    if (existing && await getLoop(existing)) return existing

    await provisionUserPersonal(ownerUserId).catch(() => ({ publicKey: null }))
    const title = titleForTurn(req)
    const meta = await createLoop({ title, createdBy: ownerUserId })
    map[key] = meta.id
    await writeLoopMap(map)
    return meta.id
  })
}

// ── Persist external metadata on loop ──

async function recordExternalMeta(
  loopId: string,
  req: ExternalTurnRequest,
): Promise<void> {
  try {
    await patchLoopMeta(loopId, {
      lastExternalMeta: {
        source: req.externalSource ?? null,
        userId: req.externalUserId ?? null,
        metadata: req.metadata ?? null,
        traceId: req.traceId ?? null,
        at: new Date().toISOString(),
      },
    })
  } catch (err: any) {
    console.warn(`[gateway] failed to persist external meta loopId=${loopId}: ${err?.message ?? err}`)
  }
}

// ── Main entry ──

/**
 * Authenticate the external caller and stream a turn via SSE.
 *
 * Authentication resolves the loopat userId that owns the gateway token. The
 * loop is created under (or looked up for) that user, so the agent runs with
 * that user's provider config and vault.
 */
export async function authenticateAndStreamTurn(
  authHeader: string | null,
  req: ExternalTurnRequest,
): Promise<Response> {
  const gatewayUserId = await resolveGatewayUser(authHeader)
  if (!gatewayUserId) {
    return new Response(
      JSON.stringify({ error: "unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    )
  }

  const turnId = (req.turnId || crypto.randomUUID()).trim()
  const traceId = (req.traceId || "").trim() || undefined

  if (req.mock === true && process.env.LOOPAT_RUNTIME_MOCK === "true") {
    return streamMockTurn(turnId)
  }

  const message = (req.message || "").trim()
  if (!message) {
    return new Response(sseEncode("error", { turnId, errorMessage: "message required" }), {
      status: 400,
      headers: externalSseHeaders(),
    })
  }

  const loopId = await resolveExternalLoop(req, gatewayUserId)

  console.log(
    `[gateway] turn=${turnId} trace=${traceId ?? "-"} loop=${loopId} ` +
    `user=${gatewayUserId} source=${req.externalSource ?? "-"} thread=${req.externalThreadId ?? "-"}`,
  )

  // Persist caller metadata for debugging / UI display (fire-and-forget).
  recordExternalMeta(loopId, req)

  const session = getSession(loopId)
  const queued = session.isBusy()

  let cleanup = () => {}
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      let assistantMessage = ""
      let closed = false
      let heartbeat: ReturnType<typeof setInterval> | null = null
      let unsubscribe = () => {}

      const send = (event: string, data: unknown) => {
        if (closed) return
        controller.enqueue(encoder.encode(sseEncode(event, data)))
      }
      const close = () => {
        if (closed) return
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        unsubscribe()
        controller.close()
      }
      cleanup = () => {
        if (closed) return
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        unsubscribe()
      }

      unsubscribe = session.onMessage((msg) => {
        const delta = textDeltaFromMessage(msg)
        if (delta) {
          assistantMessage += delta
          send("chunk", { turnId, loopId, delta })
          return
        }
        if (msg?.type === "result") {
          send("end", { turnId, loopId, assistantMessage })
          close()
          return
        }
        if (msg?.type === "error") {
          send("error", { turnId, loopId, errorMessage: msg.message || "loopat agent error" })
          close()
        }
      })

      heartbeat = setInterval(() => send("ping", {}), 15_000)
      send("start", { turnId, loopId, traceId, queued })
      try {
        // Session has its own internal queue: if busy, the message is enqueued
        // and processed after the current turn finishes. The SSE stream stays
        // open, sending pings until chunks arrive — no 409 rejection needed.
        await session.sendUserText(message)
      } catch (e: any) {
        send("error", { turnId, loopId, errorMessage: e?.message ?? String(e) })
        close()
      }
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(stream, { headers: externalSseHeaders() })
}

// ── Mock ──

function streamMockTurn(turnId: string): Response {
  const loopId = "mock-loop"
  const chunks = ["mock hello ", "from loopat"]
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(sseEncode(event, data)))
      }
      send("start", { turnId, loopId })
      let full = ""
      for (const delta of chunks) {
        full += delta
        await new Promise((resolve) => setTimeout(resolve, 20))
        send("chunk", { turnId, loopId, delta })
      }
      send("end", { turnId, loopId, assistantMessage: full })
      controller.close()
    },
  })
  return new Response(stream, { headers: externalSseHeaders() })
}
