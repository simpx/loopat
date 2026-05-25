import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createLoop, getLoop, provisionUserPersonal } from "./loops"
import { LOOPAT_HOME } from "./paths"
import { getSession } from "./session"

export type ExternalTurnRequest = {
  turnId?: string
  externalSource?: string
  externalThreadId?: string
  externalUserId?: string
  message?: string
  title?: string
  metadata?: Record<string, unknown>
  traceId?: string
  recentTurns?: Array<{ role?: string; content?: string }>
  mock?: boolean
}

type LoopMap = Record<string, string>

const LOOP_MAP_PATH = join(LOOPAT_HOME, "external-gateway", "thread-loop-map.json")
const GATEWAY_USER = (process.env.LOOPAT_GATEWAY_USER || "external").trim() || "external"

export function isExternalGatewayAuthorized(authHeader: string | null): boolean {
  const token = (process.env.LOOPAT_GATEWAY_TOKEN || "").trim()
  if (!token) return false
  const expected = `Bearer ${token}`
  return authHeader === expected
}

export function externalSseHeaders(): HeadersInit {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  }
}

function mappingKey(req: ExternalTurnRequest): string {
  const externalSource = (req.externalSource || "unknown").trim().toLowerCase()
  const externalThreadId = (req.externalThreadId || "").trim()
  if (!externalThreadId) throw new Error("externalThreadId required")
  return `${externalSource}:${externalThreadId}`
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

export async function resolveExternalLoop(req: ExternalTurnRequest): Promise<string> {
  const key = mappingKey(req)
  const map = await readLoopMap()
  const existing = map[key]
  if (existing && await getLoop(existing)) return existing

  await provisionUserPersonal(GATEWAY_USER).catch(() => ({ publicKey: null }))
  const title = titleForTurn(req)
  const meta = await createLoop({ title, createdBy: GATEWAY_USER })
  map[key] = meta.id
  await writeLoopMap(map)
  return meta.id
}

function titleForTurn(req: ExternalTurnRequest): string {
  const source = (req.externalSource || "external").trim()
  const title = (req.title || req.externalThreadId || "conversation").trim()
  return `${source} - ${title}`.slice(0, 120)
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

export async function streamExternalTurn(req: ExternalTurnRequest): Promise<Response> {
  const turnId = (req.turnId || crypto.randomUUID()).trim()
  if (req.mock === true && process.env.LOOPAT_GATEWAY_MOCK_ENABLED === "true") {
    return streamMockTurn(turnId)
  }
  const message = (req.message || "").trim()
  if (!message) {
    return new Response(sseEncode("error", { turnId, errorMessage: "message required" }), {
      status: 400,
      headers: externalSseHeaders(),
    })
  }

  const loopId = await resolveExternalLoop(req)
  const session = getSession(loopId)
  if (session.isBusy()) {
    return new Response(
      sseEncode("error", { turnId, loopId, errorMessage: "loop is busy; retry after current turn finishes" }),
      { status: 409, headers: externalSseHeaders() },
    )
  }

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
      send("start", { turnId, loopId })
      try {
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
