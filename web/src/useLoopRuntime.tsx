import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
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
      } else if (cb.type === "thinking") {
        content[idx] = { type: "thinking", thinking: cb.thinking ?? "", signature: cb.signature ?? "" }
      } else if (cb.type === "redacted_thinking") {
        content[idx] = { type: "thinking", thinking: "[Redacted]", signature: "" }
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
      } else if (d?.type === "thinking_delta" && cur.type === "thinking") {
        content[idx] = { ...cur, thinking: (cur.thinking ?? "") + (d.thinking ?? "") }
      } else if (d?.type === "signature_delta" && cur.type === "thinking") {
        content[idx] = { ...cur, signature: (cur.signature ?? "") + (d.signature ?? "") }
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
      // skip assistant entries that render to nothing (e.g. a freshly-allocated
      // partial message with no text yet) — otherwise they show as empty bubbles
      const visible = enriched.some(
        (b: any) =>
          (b?.type === "text" && (b.text ?? "").length > 0) ||
          b?.type === "tool_use" ||
          b?.type === "thinking",
      )
      if (!visible) continue
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
    } else if (b?.type === "thinking") {
      parts.push({
        type: "reasoning",
        text: b.thinking ?? "",
        signature: b.signature,
      })
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

/* ─── Tool progress & task tracking ─── */

export interface ToolProgress {
  tool_use_id: string
  tool_name: string
  elapsed_time_seconds: number
  parent_tool_use_id: string | null
  task_id?: string
}

export interface TaskState {
  task_id: string
  tool_use_id?: string
  status: "pending" | "running" | "completed" | "failed" | "killed" | "stopped"
  description: string
  task_type?: string
  workflow_name?: string
  prompt?: string
  usage?: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  summary?: string
  last_tool_name?: string
  output_file?: string
  end_time?: number
  error?: string
}

export interface QuestionOption {
  label: string
  description: string
}

export interface QuestionDef {
  question: string
  header: string
  options: QuestionOption[]
  multiSelect: boolean
}

export interface LoopRuntimeExtra {
  toolProgressMap: ReadonlyMap<string, ToolProgress>
  taskMap: ReadonlyMap<string, TaskState>
  questions: ReadonlyMap<string, QuestionDef[]>
  sendAnswers: (toolUseId: string, answers: Record<string, string>) => void
  thinkingOpen: boolean
  setThinkingOpen: (open: boolean) => void
}

const LoopRuntimeCtx = createContext<LoopRuntimeExtra>({
  toolProgressMap: new Map(),
  taskMap: new Map(),
  questions: new Map(),
  sendAnswers: () => {},
  thinkingOpen: false,
  setThinkingOpen: () => {},
})

export function useLoopRuntimeExtra(): LoopRuntimeExtra {
  return useContext(LoopRuntimeCtx)
}

export function LoopRuntimeProvider({
  extra,
  children,
}: {
  extra: LoopRuntimeExtra
  children: React.ReactNode
}) {
  return (
    <LoopRuntimeCtx.Provider value={extra}>
      {children}
    </LoopRuntimeCtx.Provider>
  )
}

export function useLoopRuntime(loopId: string | null) {
  const [raw, setRaw] = useState<RawMsg[]>([])
  const [connected, setConnected] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [running, setRunning] = useState(false)
  const [viewers, setViewers] = useState(0)
  const [mounts, setMounts] = useState<{ name: string; path: string }[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const [loadingHistory, setLoadingHistory] = useState(true)
  const reconnectTimerRef = useRef<number | null>(null)
  const attemptsRef = useRef(0)
  const aliveRef = useRef(true)

  // Tool progress (tool_progress messages) keyed by tool_use_id
  const toolProgressRef = useRef<Map<string, ToolProgress>>(new Map())
  const [toolProgressVersion, setToolProgressVersion] = useState(0)
  // Task state (task_started / task_updated / task_progress / task_notification) keyed by task_id
  const taskRef = useRef<Map<string, TaskState>>(new Map())
  const [taskVersion, setTaskVersion] = useState(0)

  // Questions (AskUserQuestion tool) — plain object for immutable updates
  const [questionsObj, setQuestionsObj] = useState<Record<string, QuestionDef[]>>({})
  const [thinkingOpen, setThinkingOpen] = useState(false)

  const sendAnswers = useMemo(() => {
    const fn = (toolUseId: string, answers: Record<string, string>) => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({ type: "answers", tool_use_id: toolUseId, answers }))
      setQuestionsObj((prev) => {
        if (!(toolUseId in prev)) return prev
        const next = { ...prev }
        delete next[toolUseId]
        return next
      })
    }
    return fn
  }, [])

  // Expose as stable read-only Maps that re-render when version bumps
  const toolProgressMap = useMemo(() => {
    void toolProgressVersion // pin for re-computation
    return toolProgressRef.current as ReadonlyMap<string, ToolProgress>
  }, [toolProgressVersion])

  const taskMap = useMemo(() => {
    void taskVersion
    return taskRef.current as ReadonlyMap<string, TaskState>
  }, [taskVersion])

  const questionsReadonlyMap = useMemo<ReadonlyMap<string, QuestionDef[]>>(() => {
    return new Map(Object.entries(questionsObj))
  }, [questionsObj])

  const extra = useMemo<LoopRuntimeExtra>(
    () => ({ toolProgressMap, taskMap, questions: questionsReadonlyMap, sendAnswers, thinkingOpen, setThinkingOpen }),
    [toolProgressMap, taskMap, questionsReadonlyMap, sendAnswers, thinkingOpen],
  )

  useEffect(() => {
    if (!loopId) return
    aliveRef.current = true

    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/loop/${loopId}`

    const connect = () => {
      // server replays history on each connect — clear local buffer
      setRaw([])
      setRunning(false)
      setLoadingHistory(true)
      // Clear tool progress & task state & questions on reconnect
      toolProgressRef.current = new Map()
      setToolProgressVersion((v) => v + 1)
      taskRef.current = new Map()
      setTaskVersion((v) => v + 1)
      setQuestionsObj({})
      setThinkingOpen(false)
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        setReconnecting(false)
        attemptsRef.current = 0
        // Clear any pending retry from a previous connection's onclose
        if (reconnectTimerRef.current !== null) {
          clearTimeout(reconnectTimerRef.current)
          reconnectTimerRef.current = null
        }
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
          // Don't reconnect if a new WS already opened (e.g. StrictMode double-mount)
          if (!aliveRef.current) return
          if (wsRef.current?.readyState === WebSocket.OPEN) return
          connect()
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
          setLoadingHistory(false)
          setRunning(false)
          return
        }
        if (m?.type === "viewers") {
          setViewers(typeof m.count === "number" ? m.count : 0)
          return
        }

        // ── tool_progress ──
        if (m?.type === "tool_progress") {
          const tp: ToolProgress = {
            tool_use_id: m.tool_use_id,
            tool_name: m.tool_name,
            elapsed_time_seconds: m.elapsed_time_seconds,
            parent_tool_use_id: m.parent_tool_use_id ?? null,
            task_id: m.task_id,
          }
          toolProgressRef.current.set(m.tool_use_id, tp)
          setToolProgressVersion((v) => v + 1)
          return
        }

        // ── question (AskUserQuestion) ──
        if (m?.type === "question" && Array.isArray(m.questions)) {
          setQuestionsObj((prev) => ({ ...prev, [m.tool_use_id]: m.questions }))
          return
        }

        // ── task messages ──
        if (m?.type === "system") {
          const subtype = m.subtype
          if (subtype === "task_started") {
            const existing = taskRef.current.get(m.task_id)
            taskRef.current.set(m.task_id, {
              task_id: m.task_id,
              tool_use_id: m.tool_use_id,
              status: "running",
              description: m.description,
              task_type: m.task_type,
              workflow_name: m.workflow_name,
              prompt: m.prompt,
              ...(existing?.usage ? { usage: existing.usage } : {}),
            })
            setTaskVersion((v) => v + 1)
            return
          }
          if (subtype === "task_updated") {
            const prev = taskRef.current.get(m.task_id)
            taskRef.current.set(m.task_id, {
              ...(prev ?? { task_id: m.task_id, status: "pending" as const, description: "" }),
              ...(m.patch?.status ? { status: m.patch.status } : {}),
              ...(m.patch?.description ? { description: m.patch.description } : {}),
              ...(m.patch?.end_time ? { end_time: m.patch.end_time } : {}),
              ...(m.patch?.error ? { error: m.patch.error } : {}),
            } as TaskState)
            setTaskVersion((v) => v + 1)
            return
          }
          if (subtype === "task_progress") {
            const prev = taskRef.current.get(m.task_id)
            taskRef.current.set(m.task_id, {
              ...(prev ?? { task_id: m.task_id, status: "running" as const, description: "" }),
              description: m.description ?? prev?.description ?? "",
              usage: m.usage,
              ...(m.last_tool_name ? { last_tool_name: m.last_tool_name } : {}),
              ...(m.summary ? { summary: m.summary } : {}),
              tool_use_id: m.tool_use_id ?? prev?.tool_use_id,
            } as TaskState)
            setTaskVersion((v) => v + 1)
            return
          }
          if (subtype === "task_notification") {
            const prev = taskRef.current.get(m.task_id)
            taskRef.current.set(m.task_id, {
              ...(prev ?? { task_id: m.task_id, status: "pending" as const, description: "" }),
              status: m.status === "completed" ? "completed"
                : m.status === "failed" ? "failed"
                : "stopped",
              tool_use_id: m.tool_use_id ?? prev?.tool_use_id,
              output_file: m.output_file,
              summary: m.summary,
              usage: m.usage,
            } as TaskState)
            setTaskVersion((v) => v + 1)
            return
          }
          // system/init — start running
          if (subtype === "init") {
            if (!loadingHistory) setRunning(true)
            return
          }
          return
        }

        if (m?.type === "result") {
          if (!loadingHistory) setRunning(false)
          return
        }

        if (m?.type === "user" && m.message) {
          // upsert by uuid: dedup against history-replay + StrictMode double-mount
          const uuid: string = m.uuid || freshId("u")
          try {
            setRaw((prev) => {
              if (prev.some((x) => x.id === uuid)) return prev
              return [...prev, { id: uuid, role: "user", content: asContentArray(m.message.content) }]
            })
          } catch {}
        } else if (m?.type === "assistant" && m.message?.content) {
          // upsert by uuid so the streaming partial gets replaced cleanly
          const uuid: string = m.uuid ?? freshId("a")
          try {
            setRaw((prev) => {
              const idx = prev.findIndex((x) => x.id === uuid)
              const full: RawMsg = { id: uuid, role: "assistant", content: m.message.content }
              if (idx < 0) return [...prev, full]
              const out = prev.slice()
              out[idx] = full
              return out
            })
          } catch {}
        } else if (m?.type === "stream_event") {
          try { handleStreamEvent(m, setRaw) } catch {}
        } else if (m?.type === "error") {
          setRaw((prev) => [
            ...prev,
            { id: freshId("e"), role: "assistant", content: [{ type: "text", text: `⚠️ ${m.message ?? "error"}` }] },
          ])
          if (!loadingHistory) setRunning(false)
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

  const aggregated = useMemo(() => {
    try {
      return aggregateToolResults(raw)
    } catch (e) {
      console.error("[fe:aggregateToolResults]", e)
      return []
    }
  }, [raw])

  const onNew = useCallback(async (message: AppendMessage) => {
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
  }, [])

  const onCancel = useCallback(async () => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: "interrupt" }))
  }, [])

  const safeConvert = useCallback((raw: RawMsg) => {
    try {
      return convertMessage(raw)
    } catch (e) {
      console.error("[fe:convertMessage]", e)
      return { id: raw.id, role: raw.role, content: [{ type: "text", text: "" }] } as any
    }
  }, [])

  const runtime = useExternalStoreRuntime({
    messages: aggregated,
    convertMessage: safeConvert,
    isRunning: running,
    onNew,
    onCancel,
  })

  return { runtime, connected, reconnecting, running, viewers, mounts, setMounts, extra }
}
