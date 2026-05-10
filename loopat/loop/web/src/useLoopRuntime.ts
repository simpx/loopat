import { useEffect, useMemo, useRef, useState } from "react"
import { useExternalStoreRuntime, type AppendMessage } from "@assistant-ui/react"

type RawMsg = {
  id: string
  role: "user" | "assistant"
  content: any[]
}

function asContentArray(c: any): any[] {
  if (typeof c === "string") return [{ type: "text", text: c }]
  if (Array.isArray(c)) return c
  return []
}

let counter = 0
function freshId(prefix: string) {
  counter++
  return `${prefix}-${Date.now()}-${counter}`
}

function aggregateToolResults(raw: RawMsg[]): RawMsg[] {
  const resultMap = new Map<string, { content: string; isError: boolean }>()
  for (const m of raw) {
    if (m.role === "user") {
      for (const block of m.content) {
        if (block?.type === "tool_result") {
          const c = block.content
          const txt =
            typeof c === "string"
              ? c
              : Array.isArray(c)
              ? c.map((x: any) => x?.text ?? JSON.stringify(x)).join("")
              : JSON.stringify(c)
          resultMap.set(block.tool_use_id, { content: txt, isError: !!block.is_error })
        }
      }
    }
  }
  const out: RawMsg[] = []
  for (const m of raw) {
    if (m.role === "user") {
      const textBlocks = m.content.filter((b: any) => b?.type === "text" && (b.text ?? "").trim())
      if (textBlocks.length === 0) continue
      out.push({ ...m, content: textBlocks })
    } else {
      const enriched = m.content.map((b: any) => {
        if (b?.type === "tool_use") {
          const r = resultMap.get(b.id)
          return { ...b, _result: r }
        }
        return b
      })
      out.push({ ...m, content: enriched })
    }
  }
  return out
}

function convertMessage(raw: RawMsg) {
  const parts: any[] = []
  for (const b of raw.content) {
    if (b?.type === "text") {
      parts.push({ type: "text", text: b.text ?? "" })
    } else if (b?.type === "tool_use") {
      const r = b._result
      parts.push({
        type: "tool-call",
        toolCallId: b.id,
        toolName: b.name,
        args: b.input ?? {},
        result: r ? r.content : undefined,
        isError: r ? r.isError : undefined,
      })
    }
  }
  return {
    id: raw.id,
    role: raw.role,
    content: parts.length > 0 ? parts : [{ type: "text", text: "" }],
  } as const
}

export function useLoopRuntime(loopId: string | null) {
  const [raw, setRaw] = useState<RawMsg[]>([])
  const [connected, setConnected] = useState(false)
  const [running, setRunning] = useState(false)
  const [viewers, setViewers] = useState(0)
  const [mounts, setMounts] = useState<{ name: string; path: string }[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const replayingRef = useRef(true)

  useEffect(() => {
    if (!loopId) return
    setRaw([])
    setRunning(false)
    replayingRef.current = true
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/loop/${loopId}`
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => setConnected(true)
    ws.onclose = () => {
      setConnected(false)
      setRunning(false)
    }
    ws.onerror = () => setConnected(false)
    ws.onmessage = (e) => {
      let m: any
      try {
        m = JSON.parse(e.data)
      } catch {
        return
      }
      if (m?.type === "history_end") {
        replayingRef.current = false
        setRunning(false)
        return
      }
      if (m?.type === "viewers") {
        setViewers(typeof m.count === "number" ? m.count : 0)
        return
      }
      if (m?.type === "user" && m.message) {
        setRaw((prev) => [...prev, { id: freshId("u"), role: "user", content: asContentArray(m.message.content) }])
      } else if (m?.type === "assistant" && m.message?.content) {
        setRaw((prev) => [...prev, { id: freshId("a"), role: "assistant", content: m.message.content }])
      } else if (m?.type === "system" && m.subtype === "init") {
        if (!replayingRef.current) setRunning(true)
      } else if (m?.type === "result") {
        if (!replayingRef.current) setRunning(false)
      } else if (m?.type === "error") {
        setRaw((prev) => [
          ...prev,
          { id: freshId("e"), role: "assistant", content: [{ type: "text", text: `⚠️ ${m.message ?? "error"}` }] },
        ])
        if (!replayingRef.current) setRunning(false)
      }
    }

    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [loopId])

  const aggregated = useMemo(() => aggregateToolResults(raw), [raw])

  const onNew = async (message: AppendMessage) => {
    let text = ""
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "text") text += part.text
      }
    }
    text = text.trim()
    if (!text) return
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    setRunning(true)
    ws.send(JSON.stringify({ type: "user", text }))
  }

  const onCancel = async () => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: "interrupt" }))
  }

  const runtime = useExternalStoreRuntime({
    messages: aggregated,
    convertMessage,
    isRunning: running,
    onNew,
    onCancel,
  })

  return { runtime, connected, running, viewers, mounts, setMounts }
}
