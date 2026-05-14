/**
 * Read-only public view of a loop. Rendered by LoopPage when the visitor is
 * anonymous on /loop/:id, in which case Shell drops its chrome (no tabs, no
 * login button) and this page renders only the loop title + chat thread.
 *
 * Server-side, GET /api/loops/:id and /ws/loop/:id allow anonymous reads only
 * when meta.public === true. If the loop isn't public and the visitor isn't
 * logged in, the API returns 401 — this page renders an unavailable notice.
 */
import { useEffect, useState } from "react"
import { useParams } from "react-router-dom"
import { AssistantRuntimeProvider } from "@assistant-ui/react"
import ChatInterface from "@/components/chat/ChatInterface"
import { useLoopRuntime, LoopRuntimeProvider } from "../useLoopRuntime"
import { getLoopMeta, type LoopMeta } from "../api"

export function SharePage() {
  const { id } = useParams<{ id: string }>()
  const [meta, setMeta] = useState<LoopMeta | null | "unauthorized">(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    ;(async () => {
      const m = await getLoopMeta(id)
      if (cancelled) return
      setMeta(m ?? "unauthorized")
    })()
    return () => {
      cancelled = true
    }
  }, [id])

  useEffect(() => {
    if (meta && typeof meta === "object") document.title = `${meta.title} · shared`
  }, [meta])

  if (!id) return <Unavailable reason="missing loop id" />
  if (meta === null) {
    return <Loading />
  }
  if (meta === "unauthorized") {
    return <Unavailable reason="this loop is private or does not exist" />
  }

  return <SharedLoop meta={meta} />
}

function SharedLoop({ meta }: { meta: LoopMeta }) {
  const { runtime, connected, reconnecting, extra } = useLoopRuntime(meta.id, "")
  return (
    <div className="h-full w-full flex flex-col bg-white text-gray-900">
      <header className="h-12 shrink-0 border-b border-gray-200 bg-white flex items-center px-3 md:px-5 gap-2">
        <span className="text-lg leading-none">🧶</span>
        <span className="text-[14px] font-medium text-gray-900 truncate">{meta.title}</span>
        <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200">
          view only
        </span>
        <div className="flex-1" />
        <span
          className={
            "text-[11px] " +
            (connected ? "text-emerald-600" : reconnecting ? "text-amber-500" : "text-red-500")
          }
          title={connected ? "connected" : reconnecting ? "reconnecting…" : "disconnected"}
        >
          ●
        </span>
      </header>
      <main className="flex-1 min-h-0">
        <LoopRuntimeProvider extra={extra}>
          <AssistantRuntimeProvider runtime={runtime}>
            <ChatInterface readOnly />
          </AssistantRuntimeProvider>
        </LoopRuntimeProvider>
      </main>
    </div>
  )
}

function Loading() {
  return (
    <div className="h-full w-full flex items-center justify-center text-gray-400 text-sm">
      loading…
    </div>
  )
}

function Unavailable({ reason }: { reason: string }) {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center text-gray-500 gap-2 px-4 text-center">
      <span className="text-lg">🧶</span>
      <div className="text-sm">Loop unavailable</div>
      <div className="text-xs text-gray-400">{reason}</div>
    </div>
  )
}
