import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useExternalStoreRuntime, type AppendMessage } from "@assistant-ui/react"
import type { PermissionMode } from "@/components/chat/PlanModeToggle"

type RawMsg = {
  id: string
  role: "user" | "assistant"
  content: any[]
  parent_tool_use_id?: string | null
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

export function convertMessage(raw: RawMsg) {
  const parts: any[] = []
  for (const b of raw.content) {
    if (b?.type === "text") {
      const txt = (b.text ?? "").trim()
      if (txt) parts.push({ type: "text", text: txt })
    } else if (b?.type === "clear-divider") {
      const ts = (b as any).ts
      const by = (b as any).by
      const timeStr = ts ? new Date(ts).toLocaleString() : ""
      const byStr = by ? ` by ${by}` : ""
      const stamp = [byStr, timeStr].filter(Boolean).join(" · ")
      parts.push({
        type: "text",
        text: `---\n*Context cleared${stamp ? ` ${stamp}` : ""}*\n---`,
      })
    } else if (b?.type === "thinking") {
      parts.push({
        type: "reasoning",
        text: b.thinking ?? "",
        signature: b.signature,
      })
    } else if (b?.type === "tool_use") {
      const r = b._result
      const args = b.input ?? {}
      // Don't mark as complete until input JSON has actually arrived —
      // content_block_start fires with input={} before input_json_deltas.
      const hasArgs = Object.keys(args).length > 0
      parts.push({
        type: "tool-call",
        toolCallId: b.id,
        toolName: b.name,
        args,
        result: r ? r.content : undefined,
        isError: r ? r.isError : undefined,
        status: r
          ? r.isError
            ? { type: "incomplete", reason: "error" as const }
            : hasArgs
              ? { type: "complete" as const }
              : { type: "running" as const }
          : { type: "running" as const },
      })
    }
  }
  return {
    id: raw.id,
    role: raw.role,
    content: parts,
  } as const
}

/* ─── Permission prompt ─── */

export interface PermissionPrompt {
  toolUseId: string
  toolName: string
  title: string
  displayName: string
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

export interface ProviderInfo {
  name: string
  model: string
  contextWindow: number
}

export interface ContextUsage {
  totalTokens: number
  maxTokens: number
  percentage: number
  model: string
}

export interface LoopRuntimeExtra {
  toolProgressMap: ReadonlyMap<string, ToolProgress>
  taskMap: ReadonlyMap<string, TaskState>
  questions: ReadonlyMap<string, QuestionDef[]>
  sendAnswers: (toolUseId: string, answers: Record<string, string>) => void
  thinkingOpen: boolean
  setThinkingOpen: (open: boolean) => void
  permissionMode: PermissionMode
  setPermissionMode: (mode: PermissionMode) => void
  permissionPrompt: PermissionPrompt | null
  answerPermission: (toolUseId: string, allow: boolean) => void
  setMaxThinkingTokens: (tokens: number | null) => void
  getContextUsage: () => void
  contextUsage: ContextUsage | null
  thinkingBudget: number | null
  provider: ProviderInfo | null
  selectProvider: (name: string, source?: "personal" | "workspace") => void
  /** Drop SDK context (like CC's /clear); next message starts with 0 history. */
  clearContext: () => void
  /** Count of thinking/redacted_thinking content blocks currently in raw
   *  assistant history. Used by ModelSelector to decide whether a cross-
   *  provider switch needs a strip-thinking confirmation. */
  thinkingBlockCount: number
  /** This loop's id — needed by ModelSelector to call /strip-thinking. */
  loopId: string
  /** True while server is replaying history on connect. Chat scrolls to bottom
   *  instantly during this phase; after it ends, normal scroll behavior resumes. */
  loadingHistory: boolean
  /** Set of tool_use_ids that are Agent or Task tools. */
  agentToolUseIds: ReadonlySet<string>
  /** Agent tool_use_id → child RawMsgs that belong to that agent. */
  childMessagesByAgentId: ReadonlyMap<string, RawMsg[]>
  /** True while SDK is generating. */
  isRunning: boolean
  /** Enqueue a message to be sent after current generation completes. */
  enqueueMessage: (text: string) => void
  /** Messages waiting in the server queue. */
  queue: string[]
  /** Clear the pending message queue. */
  clearQueue: () => void
  /** Remove a single item from the queue by index. */
  removeFromQueue: (index: number) => void
  /** Whether there are messages before a clear boundary (history available). */
  hasHistory: boolean
  /** Whether to show pre-clear history messages. */
  showHistory: boolean
  /** Toggle showing pre-clear history. */
  toggleShowHistory: () => void
  /** Slash commands advertised by CC at session init: built-ins ("init",
   *  "clear"), user-tier skills ("loop", "schedule"), and plugin commands
   *  ("loopat:onboarding"). Empty until the first init message arrives;
   *  may include duplicates if CC ever reports them — caller should dedup. */
  availableSlashCommands: string[]
  /** True when aggregated messages exceed the render window. */
  hasOlderMessages: boolean
  /** Load and render the next batch of older messages. */
  loadMoreMessages: () => void
  /** Token estimate based on the full aggregated conversation (not just visible window). */
  estimatedTokens: number
}

const LoopRuntimeCtx = createContext<LoopRuntimeExtra>({
  toolProgressMap: new Map(),
  taskMap: new Map(),
  questions: new Map(),
  sendAnswers: () => {},
  thinkingOpen: false,
  setThinkingOpen: () => {},
  permissionMode: "bypassPermissions" as PermissionMode,
  setPermissionMode: () => {},
  permissionPrompt: null,
  answerPermission: () => {},
  setMaxThinkingTokens: () => {},
  getContextUsage: () => {},
  contextUsage: null,
  thinkingBudget: null,
  provider: null,
  selectProvider: () => {},
  clearContext: () => {},
  thinkingBlockCount: 0,
  loopId: "",
  loadingHistory: true,
  agentToolUseIds: new Set(),
  childMessagesByAgentId: new Map(),
  isRunning: false,
  enqueueMessage: () => {},
  queue: [],
  clearQueue: () => {},
  removeFromQueue: () => {},
  hasHistory: false,
  showHistory: false,
  toggleShowHistory: () => {},
  availableSlashCommands: [],
  hasOlderMessages: false,
  loadMoreMessages: () => {},
  estimatedTokens: 0,
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

export function useLoopRuntime(loopId: string | null, currentUserId: string) {
  const [raw, setRaw] = useState<RawMsg[]>([])
  const [connected, setConnected] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [running, setRunning] = useState(false)
  const [viewers, setViewers] = useState(0)
  const [mounts, setMounts] = useState<{ name: string; path: string }[]>([])
  const [provider, setProvider] = useState<{ name: string; model: string; contextWindow: number } | null>(null)
  const [availableSlashCommands, setAvailableSlashCommands] = useState<string[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  // Ref (not state) so ws.onmessage closure sees fresh value without
  // re-attaching the handler. Only the gating logic inside onmessage reads it.
  const loadingHistoryRef = useRef(true)
  const [loadingHistory, setLoadingHistory] = useState(true)
  const reconnectTimerRef = useRef<number | null>(null)
  const attemptsRef = useRef(0)
  const aliveRef = useRef(true)
  const replayBufRef = useRef<any[]>([])

  // Tool progress (tool_progress messages) keyed by tool_use_id
  const toolProgressRef = useRef<Map<string, ToolProgress>>(new Map())
  const [toolProgressVersion, setToolProgressVersion] = useState(0)
  // Task state (task_started / task_updated / task_progress / task_notification) keyed by task_id
  const taskRef = useRef<Map<string, TaskState>>(new Map())
  const [taskVersion, setTaskVersion] = useState(0)

  // Questions (AskUserQuestion tool) — plain object for immutable updates
  const [questionsObj, setQuestionsObj] = useState<Record<string, QuestionDef[]>>({})
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("bypassPermissions")
  const permissionModeRef = useRef<PermissionMode>("bypassPermissions")
  permissionModeRef.current = permissionMode
  const [queue, setQueue] = useState<string[]>([])

  const [showHistory, setShowHistory] = useState(false)

  const [permissionPrompt, setPermissionPrompt] = useState<PermissionPrompt | null>(null)

  const answerPermission = useCallback((toolUseId: string, allow: boolean) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: "permission_answer", tool_use_id: toolUseId, allow }))
    setPermissionPrompt(null)
  }, [])

  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null)
  const [thinkingBudget, setThinkingBudget] = useState<number | null>(null)

  const setMaxThinkingTokens = useCallback((tokens: number | null) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: "set_max_thinking_tokens", tokens }))
    setThinkingBudget(tokens)
  }, [])

  const getContextUsage = useCallback(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: "get_context_usage" }))
  }, [])

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

  const selectProvider = useCallback((name: string, source?: "personal" | "workspace") => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: "provider_select", provider: name, source }))
  }, [])

  const clearContext = useCallback(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: "clear" }))
  }, [])

  // Count thinking blocks in raw history. Cheap walk; raw is bounded by
  // session length and rerenders only on raw change.
  const thinkingBlockCount = useMemo(() => {
    let n = 0
    for (const m of raw) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue
      for (const b of m.content) {
        if (b?.type === "thinking" || b?.type === "redacted_thinking") n++
      }
    }
    return n
  }, [raw])

  const hasHistory = useMemo(() => {
    for (const m of raw) {
      if (Array.isArray(m?.content) && m.content[0]?.type === "clear-divider") {
        return true
      }
    }
    return false
  }, [raw])

  const { aggregated, agentToolUseIds, childMessagesByAgentId } = useMemo(() => {
    try {
      let from = 0
      if (!showHistory) {
        for (let i = raw.length - 1; i >= 0; i--) {
          const m: any = raw[i]
          const firstPart = Array.isArray(m?.content) ? m.content[0] : null
          if (firstPart?.type === "clear-divider") {
            from = i + 1
            break
          }
        }
      }
      const allEnriched = aggregateToolResults(from === 0 ? raw : raw.slice(from))

      const agentIds = new Set<string>()
      for (const m of allEnriched) {
        if (!Array.isArray(m.content)) continue
        for (const b of m.content) {
          if (b?.type === "tool_use" && (b.name === "Agent" || b.name === "Task") && b.id) {
            agentIds.add(b.id)
          }
        }
      }

      const main: RawMsg[] = []
      const childrenByAgent = new Map<string, RawMsg[]>()
      for (const m of allEnriched) {
        const pid = m.parent_tool_use_id
        if (pid && agentIds.has(pid)) {
          const existing = childrenByAgent.get(pid)
          if (existing) existing.push(m)
          else childrenByAgent.set(pid, [m])
        } else {
          main.push(m)
        }
      }

      return {
        aggregated: main,
        agentToolUseIds: agentIds as ReadonlySet<string>,
        childMessagesByAgentId: childrenByAgent as ReadonlyMap<string, RawMsg[]>,
      }
    } catch (e) {
      console.error("[fe:aggregateToolResults]", e)
      return { aggregated: [] as RawMsg[], agentToolUseIds: new Set() as ReadonlySet<string>, childMessagesByAgentId: new Map() as ReadonlyMap<string, RawMsg[]> }
    }
  }, [raw, showHistory])

  const RENDER_WINDOW_SIZE = 20
  const RENDER_WINDOW_BATCH = 20

  const [renderCount, setRenderCount] = useState(RENDER_WINDOW_SIZE)

  useEffect(() => {
    setRenderCount(RENDER_WINDOW_SIZE)
  }, [loopId])

  const hasOlderMessages = aggregated.length > renderCount
  const visibleMessages = hasOlderMessages ? aggregated.slice(-renderCount) : aggregated

  const loadMoreMessages = useCallback(() => {
    setRenderCount(prev => prev + RENDER_WINDOW_BATCH)
  }, [])

  const onCancel = useCallback(async () => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: "interrupt" }))
    setRunning(false)
  }, [])

  const onClearQueue = useCallback(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: "queue_clear" }))
  }, [])

  const onRemoveFromQueue = useCallback((index: number) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: "queue_remove", index }))
  }, [])

  const enqueueMessage = useCallback((text: string) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: "user", text, permissionMode: permissionModeRef.current }))
  }, [])

  const toggleShowHistory = useCallback(() => {
    setShowHistory((v) => !v)
  }, [])

  const estimatedTokens = useMemo(() => {
    let chars = 0
    for (const m of aggregated) {
      chars += JSON.stringify(m).length
    }
    return Math.round(chars / 3.5)
  }, [aggregated])

  const extra = useMemo<LoopRuntimeExtra>(
    () => ({ toolProgressMap, taskMap, questions: questionsReadonlyMap, sendAnswers, thinkingOpen, setThinkingOpen, permissionMode, setPermissionMode, permissionPrompt, answerPermission, setMaxThinkingTokens, getContextUsage, contextUsage, thinkingBudget, provider, selectProvider, clearContext, thinkingBlockCount, loopId: loopId ?? "", loadingHistory, agentToolUseIds, childMessagesByAgentId, isRunning: running, enqueueMessage, queue, clearQueue: onClearQueue, removeFromQueue: onRemoveFromQueue, hasHistory, showHistory, toggleShowHistory, availableSlashCommands, hasOlderMessages, loadMoreMessages, estimatedTokens }),
    [toolProgressMap, taskMap, questionsReadonlyMap, sendAnswers, thinkingOpen, permissionMode, permissionPrompt, answerPermission, setMaxThinkingTokens, getContextUsage, contextUsage, thinkingBudget, provider, selectProvider, clearContext, thinkingBlockCount, loopId, loadingHistory, agentToolUseIds, childMessagesByAgentId, running, enqueueMessage, queue, onClearQueue, onRemoveFromQueue, hasHistory, showHistory, toggleShowHistory, availableSlashCommands, hasOlderMessages, loadMoreMessages, estimatedTokens],
  )

  useEffect(() => {
    if (!loopId) return
    aliveRef.current = true

    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/loop/${loopId}`

    const connect = () => {
      // server replays history on each connect — clear local buffer
      setRaw([])
      setRunning(false)
      loadingHistoryRef.current = true
      setLoadingHistory(true)
      // Clear tool progress & task state & questions on reconnect
      toolProgressRef.current = new Map()
      setToolProgressVersion((v) => v + 1)
      taskRef.current = new Map()
      setTaskVersion((v) => v + 1)
      setQuestionsObj({})
      setPermissionPrompt(null)
      setContextUsage(null)
      setThinkingBudget(null)
      setThinkingOpen(false)
      replayBufRef.current = []
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
      const dispatchMsg = (m: any) => {
        if (m?.type === "viewers") {
          setViewers(typeof m.count === "number" ? m.count : 0)
          return
        }
        if (m?.type === "queue_update") {
          setQueue(Array.isArray(m.queue) ? m.queue : [])
          return
        }
        if (m?.type === "provider") {
          setProvider({
            name: String(m.name ?? "?"),
            model: String(m.model ?? "?"),
            contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : 200_000,
          })
          return
        }

        if (m?.type === "permission_mode" && typeof m.mode === "string") {
          const validModes = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]
          if (validModes.includes(m.mode)) {
            setPermissionMode(m.mode as PermissionMode)
          }
          return
        }

        if (m?.type === "context_usage") {
          setContextUsage({
            totalTokens: m.totalTokens ?? 0,
            maxTokens: m.maxTokens ?? 0,
            percentage: m.percentage ?? 0,
            model: m.model ?? "",
          })
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

        // ── permission prompt ──
        if (m?.type === "permission_prompt" && typeof m.tool_use_id === "string") {
          setPermissionPrompt({
            toolUseId: m.tool_use_id,
            toolName: m.tool_name || "?",
            title: m.title || "Permission required",
            displayName: m.displayName || m.tool_name || "?",
          })
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
          // system/init — start running; also cache the slash-command catalog
          // advertised by CC (built-ins + skills + plugin commands like
          // "loopat:onboarding").
          if (subtype === "init") {
            if (!loadingHistoryRef.current) setRunning(true)
            const cmds = Array.isArray((m as any).slash_commands)
              ? ((m as any).slash_commands as unknown[]).filter(
                  (c): c is string => typeof c === "string",
                )
              : []
            if (cmds.length > 0) setAvailableSlashCommands(cmds)
            return
          }
          return
        }

        if (m?.type === "result") {
          if (!loadingHistoryRef.current) setRunning(false)
          return
        }

        if (m?.type === "user" && m.message) {
          // upsert by uuid: dedup against history-replay + StrictMode double-mount
          const uuid: string = m.uuid || freshId("u")
          const parentId: string | null = m.parent_tool_use_id ?? null
          try {
            setRaw((prev) => {
              if (prev.some((x) => x.id === uuid)) return prev
              return [...prev, { id: uuid, role: "user", content: asContentArray(m.message.content), parent_tool_use_id: parentId }]
            })
          } catch {}
        } else if (m?.type === "assistant" && m.message?.content) {
          // upsert by uuid so the streaming partial gets replaced cleanly.
          // Fallback: if the full message uuid doesn't match the stream_event
          // uuid, hunt down any streaming partial whose tool_use ids overlap
          // and replace it — otherwise both appear side-by-side.
          const uuid: string = m.uuid ?? freshId("a")
          const content = m.message.content
          const parentId: string | null = m.parent_tool_use_id ?? null
          try {
            setRaw((prev) => {
              const full: RawMsg = { id: uuid, role: "assistant", content, parent_tool_use_id: parentId }
              const idx = prev.findIndex((x) => x.id === uuid)
              if (idx >= 0) {
                const out = prev.slice()
                out[idx] = full
                return out
              }
              // No uuid match — try to find a streaming partial that shares
              // at least one tool_use id with the full message.
              const fullToolIds = new Set(
                (content as any[]).filter((b: any) => b?.type === "tool_use").map((b: any) => b.id)
              )
              if (fullToolIds.size > 0) {
                const dupIdx = prev.findIndex((x) =>
                  x.role === "assistant" &&
                  x.content.some((b: any) => b?.type === "tool_use" && fullToolIds.has(b.id)),
                )
                if (dupIdx >= 0) {
                  const out = prev.slice()
                  out[dupIdx] = full
                  return out
                }
              }
              return [...prev, full]
            })
          } catch {}
        } else if (m?.type === "stream_event") {
          try { handleStreamEvent(m, setRaw) } catch {}
        } else if (m?.type === "error") {
          setRaw((prev) => [
            ...prev,
            { id: freshId("e"), role: "assistant", content: [{ type: "text", text: `⚠️ ${m.message ?? "error"}` }] },
          ])
          if (!loadingHistoryRef.current) setRunning(false)
        } else if (m?.type === "clear-boundary") {
          // Server signals: SDK context dropped at this point. We push a
          // synthetic assistant message whose only content part is a custom
          // `clear-divider`; AssistantMessage detects that part type and
          // renders a striking full-width banner (bypassing the normal
          // assistant chrome).
          setRaw((prev) => [
            ...prev,
            {
              id: freshId("clear"),
              role: "assistant",
              content: [{ type: "clear-divider", ts: m.ts ?? "", by: m.by ?? "" } as any],
            },
          ])
        }
      }
      ws.onmessage = (e) => {
        let m: any
        try {
          m = JSON.parse(e.data)
        } catch {
          return
        }
        // During history replay: buffer everything, process on history_end.
        // This avoids partial/intermediate state during loading.
        if (loadingHistoryRef.current) {
          if (m?.type === "history_end") {
            for (const bufMsg of replayBufRef.current) {
              dispatchMsg(bufMsg)
            }
            loadingHistoryRef.current = false
            setLoadingHistory(false)
            setRunning(false)
          } else {
            replayBufRef.current.push(m)
          }
          return
        }
        // Live messages: process immediately
        if (m?.type === "history_end") {
          loadingHistoryRef.current = false
          setLoadingHistory(false)
          setRunning(false)
          return
        }
        dispatchMsg(m)
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
  }, [loopId, currentUserId])

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
    ws.send(JSON.stringify({ type: "user", text, permissionMode: permissionModeRef.current }))
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
    messages: visibleMessages,
    convertMessage: safeConvert,
    isRunning: running,
    onNew,
    onCancel,
  })

  return { runtime, connected, reconnecting, running, viewers, mounts, setMounts, provider, extra, queue, onClearQueue }
}
