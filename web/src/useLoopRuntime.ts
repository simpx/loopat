import React, { useEffect, useMemo, useRef, useState } from "react"
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

/**
 * Apply a SDKPartialAssistantMessage (`type: "stream_event"`) — text deltas
 * and tool_use input json deltas — to the live assistant message keyed by
 * uuid. Final SDKAssistantMessage with the same uuid replaces the partial
 * later, so this is best-effort live preview.
 */
function handleStreamEvent(m: any, setRaw: React.Dispatch<React.SetStateAction<RawMsg[]>>) {
  const uuid: string | undefined = m?.uuid
  const ev = m?.event
  if (!uuid || !ev) return

  const upsert = (mutate: (msg: RawMsg) => RawMsg) => {
    setRaw((prev) => {
      const idx = prev.findIndex((x) => x.id === uuid)
      if (idx < 0) {
        return [...prev, mutate({ id: uuid, role: "assistant", content: [] })]
      }
      const out = prev.slice()
      out[idx] = mutate(prev[idx])
      return out
    })
  }

  if (ev.type === "content_block_start") {
    const idx: number = ev.index ?? 0
    const cb = ev.content_block ?? {}
    upsert((msg) => {
      const content = msg.content.slice()
      while (content.length <= idx) content.push({ type: "text", text: "" })
      if (cb.type === "text") {
        content[idx] = { type: "text", text: cb.text ?? "" }
      } else if (cb.type === "tool_use") {
        content[idx] = {
          type: "tool_use",
          id: cb.id,
          name: cb.name,
          input: cb.input ?? {},
          _partial_json: "",
        }
      }
      return { ...msg, content }
    })
  } else if (ev.type === "content_block_delta") {
    const idx: number = ev.index ?? 0
    const d = ev.delta
    upsert((msg) => {
      const content = msg.content.slice()
      const cur = content[idx]
      if (!cur) return msg
      if (d?.type === "text_delta" && cur.type === "text") {
        content[idx] = { ...cur, text: (cur.text ?? "") + (d.text ?? "") }
      } else if (d?.type === "input_json_delta" && cur.type === "tool_use") {
        const json = (cur._partial_json ?? "") + (d.partial_json ?? "")
        let parsed = cur.input
        try {
          parsed = JSON.parse(json)
        } catch {}
        content[idx] = { ...cur, _partial_json: json, input: parsed }
      }
      return { ...msg, content }
    })
  }
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
        // surfaces a spinner in tool-fallback while result is missing
        status: r
          ? r.isError
            ? { type: "incomplete", reason: "error" as const }
            : { type: "complete" as const }
          : { type: "running" as const },
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
  const [reconnecting, setReconnecting] = useState(false)
  const [running, setRunning] = useState(false)
  const [viewers, setViewers] = useState(0)
  const [mounts, setMounts] = useState<{ name: string; path: string }[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const replayingRef = useRef(true)
  const reconnectTimerRef = useRef<number | null>(null)
  const attemptsRef = useRef(0)
  const aliveRef = useRef(true)

  useEffect(() => {
    if (!loopId) return
    aliveRef.current = true

    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/loop/${loopId}`

    const connect = () => {
      // server replays history on each connect — clear local buffer
      setRaw([])
      setRunning(false)
      replayingRef.current = true
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        setReconnecting(false)
        attemptsRef.current = 0
      }
      ws.onclose = () => {
        setConnected(false)
        setRunning(false)
        if (!aliveRef.current) return
        const n = ++attemptsRef.current
        // exp backoff capped at 30s: 500ms, 1s, 2s, 4s, 8s, 16s, 30s, 30s, ...
        const delay = Math.min(30_000, 500 * 2 ** Math.min(n - 1, 6))
        setReconnecting(true)
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null
          if (aliveRef.current) connect()
        }, delay)
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
          // upsert by uuid so the streaming partial gets replaced cleanly
          const uuid: string = m.uuid ?? freshId("a")
          setRaw((prev) => {
            const idx = prev.findIndex((x) => x.id === uuid)
            const full: RawMsg = { id: uuid, role: "assistant", content: m.message.content }
            if (idx < 0) return [...prev, full]
            const out = prev.slice()
            out[idx] = full
            return out
          })
        } else if (m?.type === "stream_event") {
          handleStreamEvent(m, setRaw)
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
    }

    connect()

    return () => {
      aliveRef.current = false
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      const ws = wsRef.current
      wsRef.current = null
      if (ws) ws.close()
      setReconnecting(false)
      attemptsRef.current = 0
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

  return { runtime, connected, reconnecting, running, viewers, mounts, setMounts }
}
