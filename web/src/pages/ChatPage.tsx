/**
 * Chat tab — Slack-like channels + 1:1 DMs with single-level threads.
 *
 * Storage of record is server-side SQLite (chat.db). Threading model:
 * every top-level message IS a thread (length ≥ 1); a reply has
 * `parentId` set to the root's id. Replies cannot themselves be replied
 * to (no nesting). When a loop is spawned, it's spawned FROM A THREAD —
 * root + replies snapshot to /loopat/context/chat/<rootId>.jsonl in the
 * new loop's sandbox, giving the AI a clean semantic unit (vs. a noisy
 * whole-channel dump).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { PanelLeftClose, PanelLeftOpen } from "lucide-react"
import { useIsMobile } from "../lib/useIsMobile"
import {
  listChatConversations,
  listChatMessages,
  getChatThread,
  listChatUsers,
  sendChatMessage,
  markChatRead,
  createChatChannel,
  deleteChatChannel,
  openChatDm,
  spawnLoopFromThread,
  type ChatConversation,
  type ChatMessage,
  type ChatThreadRoot,
  type ChatWorkspaceUser,
} from "../api"
import { useChatWebSocket, type ChatWsEvent } from "../useChatWebSocket"
import { useWorkspace } from "../ctx"

/**
 * Outbox entry for a send that hasn't been confirmed by the DB. We render it
 * inline so the sender always sees feedback — pending while in flight,
 * failed (with retry/discard) on error. Server-assigned `id: number` only
 * exists after success, so we key by client-generated `tempId` until then.
 */
type PendingMsg = {
  tempId: string
  convId: string
  parentId: number | null
  text: string
  ts: number
  status: "pending" | "failed"
  error?: string
}

function newTempId(): string {
  return `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const yesterday = new Date(today.getTime() - 86_400_000).toDateString() === d.toDateString()
  const hhmm = d.toTimeString().slice(0, 5)
  if (sameDay) return hhmm
  if (yesterday) return `yesterday ${hhmm}`
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hhmm}`
}

function convDisplayName(conv: ChatConversation): string {
  if (conv.kind === "channel") return conv.name ?? "(unnamed)"
  return conv.peerUserId ?? "(unknown)"
}

function convSigil(conv: ChatConversation): string {
  return conv.kind === "channel" ? "#" : "@"
}

export function ChatPage() {
  const ws = useWorkspace()
  const me = ws.currentUser?.id ?? ""
  const isAdmin = ws.currentUser?.role === "admin"
  const navigate = useNavigate()
  const { convId } = useParams<{ convId?: string }>()

  const [convs, setConvs] = useState<ChatConversation[]>([])
  const [users, setUsers] = useState<ChatWorkspaceUser[]>([])
  const [messages, setMessages] = useState<ChatThreadRoot[]>([])
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  // Outbox: locally-tracked sends that have NOT been confirmed by the DB.
  // Renders inline below the confirmed feed (or replies) with a status:
  //   - "pending": faded + "sending…", entry stays
  //   - "failed":  red + error + retry/discard buttons
  // On HTTP success the entry is removed and the server-returned message
  // is appended to the confirmed list. WS for own message dedupes by id.
  // Keyed by tempId — the only client-side identifier before DB assigns one.
  const [pendingRoots, setPendingRoots] = useState<PendingMsg[]>([])
  const [pendingReplies, setPendingReplies] = useState<PendingMsg[]>([])
  // Thread panel state. activeThreadRootId = which message's thread is open
  // in the right pane. thread = root + replies (loaded async). spawning is
  // per-thread (button lives in panel header).
  const [activeThreadRootId, setActiveThreadRootId] = useState<number | null>(null)
  const [thread, setThread] = useState<{ root: ChatMessage; replies: ChatMessage[] } | null>(null)
  const [threadDraft, setThreadDraft] = useState("")
  const [threadSending, setThreadSending] = useState(false)
  const [spawning, setSpawning] = useState(false)
  const [showDmPicker, setShowDmPicker] = useState(false)
  const [showNewChannel, setShowNewChannel] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const isMobile = useIsMobile()
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const threadEndRef = useRef<HTMLDivElement | null>(null)
  const activeConvIdRef = useRef<string | undefined>(convId)
  activeConvIdRef.current = convId
  const activeThreadRootIdRef = useRef<number | null>(null)
  activeThreadRootIdRef.current = activeThreadRootId

  // ── render window: bottom-up progressive reveal ──
  const RENDER_WINDOW_SIZE = 5
  const RENDER_WINDOW_BATCH = 20
  const [renderCount, setRenderCount] = useState(RENDER_WINDOW_SIZE)
  const visibleMessages = messages.slice(-renderCount)
  const hasOlderMessages = messages.length > renderCount

  const active = useMemo(() => convs.find((c) => c.id === convId), [convs, convId])
  const channels = useMemo(() => convs.filter((c) => c.kind === "channel").sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")), [convs])
  const dms = useMemo(
    () =>
      convs
        .filter((c) => c.kind === "dm")
        .sort((a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0)),
    [convs],
  )

  // ── data loading ──

  const refreshConvs = useCallback(async () => {
    const list = await listChatConversations()
    setConvs(list)
  }, [])

  const refreshUsers = useCallback(async () => {
    const list = await listChatUsers()
    setUsers(list)
  }, [])

  useEffect(() => {
    refreshConvs()
    refreshUsers()
  }, [refreshConvs, refreshUsers])

  // On URL convId change → fetch messages, mark read, optimistically zero
  // unread. Also close any open thread panel — threads are conv-scoped.
  const convWithDataRef = useRef<string | null>(null)
  useEffect(() => {
    if (!convId) return
    setActiveThreadRootId(null)
    setThread(null)
    setRenderCount(RENDER_WINDOW_SIZE)
    convWithDataRef.current = null
    progressiveReadyRef.current = false
    let cancelled = false
    listChatMessages(convId, { limit: 100 }).then((msgs) => {
      if (cancelled) return
      convWithDataRef.current = convId
      setMessages(msgs)
      // mark-read up to the latest message
      const last = msgs[msgs.length - 1]
      if (last) {
        markChatRead(convId, last.id).catch(() => {})
        setConvs((prev) => prev.map((c) => (c.id === convId ? { ...c, unread: 0 } : c)))
        // Notify the global tab-title hook so the (N) prefix drops
        // immediately, without waiting for a refetch.
        window.dispatchEvent(new CustomEvent("loopat:chat-read", { detail: { convId } }))
      }
    })
    return () => {
      cancelled = true
    }
  }, [convId])

  // Fetch thread on open. The selected root may have arrived as part of a
  // ws-pushed reply count bump on a message we don't have in `messages`
  // yet, so we don't try to read it from local state — always GET.
  useEffect(() => {
    if (activeThreadRootId == null) {
      setThread(null)
      return
    }
    let cancelled = false
    setThread(null)
    getChatThread(activeThreadRootId).then((t) => {
      if (cancelled) return
      setThread(t)
    })
    return () => {
      cancelled = true
    }
  }, [activeThreadRootId])

  // Default redirect to first channel when no convId
  useEffect(() => {
    if (convId) return
    if (convs.length === 0) return
    const first = channels[0] ?? convs[0]
    if (first) navigate(`/chat/${first.id}`, { replace: true })
  }, [convId, convs, channels, navigate])

  // Auto-scroll on new messages (main feed + open thread panel)
  // Initial scroll uses "auto" (no animation); live WS arrivals use "smooth".
  const initialScrollDoneRef = useRef(false)
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: initialScrollDoneRef.current ? "smooth" : "auto" })
    initialScrollDoneRef.current = true
  }, [messages, renderCount])
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [thread?.replies.length])

  // Bottom-up progressive reveal: start with RENDER_WINDOW_SIZE newest
  // messages, then auto-load older batches so the viewport stays at bottom
  // while the scrollbar grows.
  const progressiveReadyRef = useRef(false)
  useEffect(() => {
    setRenderCount(RENDER_WINDOW_SIZE)
    progressiveReadyRef.current = false
  }, [convId])

  useEffect(() => {
    if (!convId || messages.length === 0 || convWithDataRef.current !== convId || progressiveReadyRef.current) return
    progressiveReadyRef.current = true
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      setRenderCount((prev) => prev + RENDER_WINDOW_BATCH)
      requestAnimationFrame(() => {
        if (!cancelled) messagesEndRef.current?.scrollIntoView({ behavior: "auto" })
      })
    }
    tick()
    const interval = setInterval(() => {
      if (cancelled) return
      // Use a ref that's kept in sync so the interval always reads the latest length
      const len = messages.length
      setRenderCount((prev) => {
        if (prev >= len) {
          clearInterval(interval)
          return prev
        }
        return prev + RENDER_WINDOW_BATCH
      })
      requestAnimationFrame(() => {
        if (!cancelled) messagesEndRef.current?.scrollIntoView({ behavior: "auto" })
      })
    }, 200)
    return () => { cancelled = true; clearInterval(interval) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId, messages])

  // ── websocket ──

  const onEvent = useCallback(
    (e: ChatWsEvent) => {
      if (e.type === "message") {
        const m = e.message
        if (m.convId === activeConvIdRef.current) {
          if (m.parentId == null) {
            // New thread root → append to main feed (with 0 replies stats).
            setMessages((prev) => (
              prev.some((x) => x.id === m.id)
                ? prev
                : [...prev, { ...m, replyCount: 0, lastReplyTs: null }]
            ))
          } else {
            // Reply → bump parent's replyCount/lastReplyTs in main feed,
            // and append to thread panel if that thread is open.
            setMessages((prev) => prev.map((x) =>
              x.id === m.parentId
                ? { ...x, replyCount: x.replyCount + 1, lastReplyTs: m.ts }
                : x,
            ))
            if (activeThreadRootIdRef.current === m.parentId) {
              setThread((prev) =>
                prev && !prev.replies.some((r) => r.id === m.id)
                  ? { ...prev, replies: [...prev.replies, m] }
                  : prev,
              )
            }
          }
          markChatRead(m.convId, m.id).catch(() => {})
        } else {
          setConvs((prev) =>
            prev.map((c) =>
              c.id === m.convId
                ? { ...c, unread: c.unread + 1, lastMessageTs: m.ts }
                : c,
            ),
          )
        }
      } else if (e.type === "conv_created") {
        setConvs((prev) => {
          if (prev.some((c) => c.id === e.conv.id)) return prev
          return [...prev, e.conv]
        })
      } else if (e.type === "conv_deleted") {
        setConvs((prev) => prev.filter((c) => c.id !== e.convId))
        if (activeConvIdRef.current === e.convId) {
          navigate("/chat", { replace: true })
        }
      }
    },
    [navigate],
  )

  const { subscribe, unsubscribe } = useChatWebSocket(onEvent)

  // Subscribe to every visible conv so unread counts stay live in the rail.
  // Active conv also gets its messages.
  useEffect(() => {
    for (const c of convs) subscribe(c.id)
    return () => {
      for (const c of convs) unsubscribe(c.id)
    }
  }, [convs, subscribe, unsubscribe])

  // ── actions ──

  /** Push a top-level send through the outbox. On success the pending entry
   *  is replaced by the server-confirmed message; on failure it stays
   *  visible with retry/discard buttons. Shared by handleSend and the
   *  per-pending retry handler. */
  const submitRoot = async (text: string, tempId: string, targetConvId: string) => {
    setPendingRoots((prev) => prev.map((p) =>
      p.tempId === tempId ? { ...p, status: "pending", error: undefined } : p,
    ))
    const r = await sendChatMessage(targetConvId, text)
    if (r.message) {
      const m = r.message
      setPendingRoots((prev) => prev.filter((p) => p.tempId !== tempId))
      setMessages((prev) => (
        prev.some((x) => x.id === m.id)
          ? prev
          : [...prev, { ...m, replyCount: 0, lastReplyTs: null }]
      ))
    } else {
      setPendingRoots((prev) => prev.map((p) =>
        p.tempId === tempId ? { ...p, status: "failed", error: r.error ?? "send failed" } : p,
      ))
    }
  }

  const handleSend = async () => {
    const text = draft.trim()
    if (!text || !convId || sending) return
    setSending(true)
    const tempId = newTempId()
    setPendingRoots((prev) => [
      ...prev,
      { tempId, convId, parentId: null, text, ts: Date.now(), status: "pending" },
    ])
    setDraft("")
    await submitRoot(text, tempId, convId)
    setSending(false)
  }

  const retryRoot = (p: PendingMsg) => {
    if (!p.convId) return
    submitRoot(p.text, p.tempId, p.convId).catch(() => {})
  }

  const discardRoot = (tempId: string) => {
    setPendingRoots((prev) => prev.filter((p) => p.tempId !== tempId))
  }

  /** Same outbox pattern as submitRoot, but the destination is a thread
   *  reply: success appends to thread.replies (WS dedupes), failure leaves
   *  the pending entry visible with retry/discard. */
  const submitReply = async (text: string, tempId: string, targetConvId: string, parentId: number) => {
    setPendingReplies((prev) => prev.map((p) =>
      p.tempId === tempId ? { ...p, status: "pending", error: undefined } : p,
    ))
    const r = await sendChatMessage(targetConvId, text, parentId)
    if (r.message) {
      const m = r.message
      setPendingReplies((prev) => prev.filter((p) => p.tempId !== tempId))
      setThread((prev) =>
        prev && !prev.replies.some((x) => x.id === m.id)
          ? { ...prev, replies: [...prev.replies, m] }
          : prev,
      )
    } else {
      setPendingReplies((prev) => prev.map((p) =>
        p.tempId === tempId ? { ...p, status: "failed", error: r.error ?? "send failed" } : p,
      ))
    }
  }

  const handleThreadSend = async () => {
    const text = threadDraft.trim()
    if (!text || !convId || !thread || threadSending) return
    setThreadSending(true)
    const tempId = newTempId()
    setPendingReplies((prev) => [
      ...prev,
      { tempId, convId, parentId: thread.root.id, text, ts: Date.now(), status: "pending" },
    ])
    setThreadDraft("")
    await submitReply(text, tempId, convId, thread.root.id)
    setThreadSending(false)
  }

  const retryReply = (p: PendingMsg) => {
    if (!p.convId || p.parentId == null) return
    submitReply(p.text, p.tempId, p.convId, p.parentId).catch(() => {})
  }

  const discardReply = (tempId: string) => {
    setPendingReplies((prev) => prev.filter((p) => p.tempId !== tempId))
  }

  const handleSpawnLoopFromThread = async () => {
    if (!thread || spawning) return
    setSpawning(true)
    const r = await spawnLoopFromThread(thread.root.id)
    if (r.loopId) {
      // The server created the loop directly — refresh ws.loops so LoopPage
      // finds it on mount (otherwise it falls back to /loop which redirects
      // back to the first loop, causing a URL ping-pong).
      await ws.refresh()
      setSpawning(false)
      navigate(`/loop/${r.loopId}`)
    } else {
      setSpawning(false)
      if (r.error) console.error("spawn failed:", r.error)
    }
  }

  const handleCreateChannel = async (name: string, topic: string) => {
    const r = await createChatChannel(name, topic || undefined)
    if (r.conv) {
      setShowNewChannel(false)
      navigate(`/chat/${r.conv.id}`)
      // refresh in case ws hasn't delivered yet
      refreshConvs()
    } else if (r.error) {
      alert(r.error)
    }
  }

  const handleDeleteChannel = async (id: string) => {
    if (!isAdmin) return
    if (!confirm("Delete this channel? Messages will be archived but hidden.")) return
    const r = await deleteChatChannel(id)
    if (!r.ok && r.error) alert(r.error)
  }

  const handleOpenDm = async (username: string) => {
    const r = await openChatDm(username)
    if (r.conv) {
      setShowDmPicker(false)
      navigate(`/chat/${r.conv.id}`)
      refreshConvs()
    } else if (r.error) {
      alert(r.error)
    }
  }

  // ── render ──

  const sidebar = (
    <aside className="w-60 shrink-0 border-r border-gray-200 bg-white flex flex-col h-full">
      {isMobile && (
        <div className="h-9 flex items-center px-3 border-b border-gray-200">
          <button
            onClick={() => setSidebarOpen(false)}
            className="text-gray-500 hover:text-gray-900 px-1 rounded hover:bg-gray-100 mr-1"
            title="close sidebar"
          >
            <PanelLeftClose size={14} />
          </button>
          <span className="text-[11px] uppercase tracking-wide text-gray-500 font-medium">Chat</span>
        </div>
      )}
      <div className={isMobile ? "flex-1 min-h-0 overflow-auto py-2" : ""}>
        <div className="px-3 mt-3 mb-1 text-xs text-gray-500 flex items-center justify-between">
          <span>Channels</span>
          <button
            type="button"
            onClick={() => setShowNewChannel(true)}
            className="text-gray-500 hover:text-gray-900 text-base leading-none"
            title="new channel"
          >+</button>
        </div>
        <div className="flex flex-col gap-0.5">
          {channels.map((c) => (
            <ConvRow
              key={c.id}
              conv={c}
              active={c.id === convId}
              onClick={() => { navigate(`/chat/${c.id}`); if (isMobile) setSidebarOpen(false) }}
              onDelete={isAdmin ? () => handleDeleteChannel(c.id) : undefined}
            />
          ))}
          {channels.length === 0 && (
            <div className="mx-2 px-2 py-1 text-[11px] text-gray-400">no channels yet</div>
          )}
        </div>
        <div className="px-3 mt-4 mb-1 text-xs text-gray-500 flex items-center justify-between">
          <span>Direct messages</span>
          <button
            type="button"
            onClick={() => setShowDmPicker(true)}
            className="text-gray-500 hover:text-gray-900 text-base leading-none"
            title="new DM"
          >+</button>
        </div>
        <div className="flex flex-col gap-0.5">
          {dms.map((c) => (
            <ConvRow
              key={c.id}
              conv={c}
              active={c.id === convId}
              onClick={() => { navigate(`/chat/${c.id}`); if (isMobile) setSidebarOpen(false) }}
            />
          ))}
          {dms.length === 0 && (
            <div className="mx-2 px-2 py-1 text-[11px] text-gray-400">no DMs yet</div>
          )}
        </div>
      </div>
      <div className="flex-1" />
    </aside>
  )

  return (
    <div className="flex h-full w-full bg-white">
      {/* Rail */}
      {isMobile ? (
        <>
          {sidebarOpen ? (
            <div className="fixed inset-0 z-30" onClick={() => setSidebarOpen(false)}>
              <div className="absolute inset-0 bg-black/30" />
              <div className="absolute left-0 top-0 bottom-0 w-60 max-w-[80vw] shadow-xl" onClick={(e) => e.stopPropagation()}>
                {sidebar}
              </div>
            </div>
          ) : (
            <aside className="w-9 shrink-0 border-r border-gray-200 bg-white flex flex-col items-center pt-2">
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="w-7 h-7 flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded"
                title="open sidebar"
              >
                <PanelLeftOpen size={16} />
              </button>
            </aside>
          )}
        </>
      ) : (
        sidebar
      )}

      {/* Conversation pane */}
      <main className="flex-1 min-w-0 flex flex-col bg-white">
        {active ? (
          <>
            <header className="px-5 h-12 shrink-0 border-b border-gray-200 flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[15px] font-medium text-gray-900 truncate">
                  {convSigil(active)}{convDisplayName(active)}
                </span>
                {active.topic && (
                  <span className="text-xs text-gray-500 truncate">— {active.topic}</span>
                )}
              </div>
            </header>

            <div className="flex-1 min-h-0 overflow-auto px-5 py-4 flex flex-col gap-3 chat-messages-container">
              {messages.length === 0 && (
                <div className="text-[13px] text-gray-500">no messages yet — say hi</div>
              )}
              {visibleMessages.map((m) => (
                <MessageRow
                  key={m.id}
                  message={m}
                  isMe={m.author === me}
                  active={m.id === activeThreadRootId}
                  onOpenThread={() => setActiveThreadRootId(m.id)}
                />
              ))}
              {pendingRoots
                .filter((p) => p.convId === convId)
                .map((p) => (
                  <PendingRow
                    key={p.tempId}
                    pending={p}
                    author={me}
                    onRetry={() => retryRoot(p)}
                    onDiscard={() => discardRoot(p.tempId)}
                  />
                ))}
              <div ref={messagesEndRef} />
            </div>

            <div className="px-5 pb-4 pt-2 shrink-0">
              <div className="rounded-2xl border border-gray-200 bg-white p-2.5 shadow-sm flex flex-col gap-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // Skip Enter while IME is composing (CJK input methods
                    // use Enter to commit the candidate; firing send here
                    // sends the wrong text and steals the commit keystroke).
                    if (e.nativeEvent.isComposing) return
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault()
                      handleSend()
                    }
                  }}
                  rows={1}
                  placeholder={`Message ${convSigil(active)}${convDisplayName(active)}…`}
                  className="field-sizing-content w-full max-h-40 min-h-10 resize-none bg-transparent px-1.5 py-1 text-sm text-gray-900 outline-none placeholder:text-gray-400"
                />
                <div className="flex items-center justify-between border-t border-gray-100 pt-2 px-0.5">
                  <div className="text-[10px] text-gray-400">Enter to send · Shift+Enter for newline</div>
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={sending || !draft.trim()}
                    className="px-3 py-1 rounded bg-gray-900 text-white text-xs hover:bg-gray-700 disabled:opacity-40"
                  >send</button>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
            select a conversation
          </div>
        )}
      </main>

      {/* Thread panel — Slack-style slide-out from the right. Renders only
          when a thread is open. Width is fixed-ish (96 → 30vw) so the main
          feed shrinks gracefully on smaller screens. */}
      {active && activeThreadRootId != null && (
        <ThreadPanel
          isMobile={isMobile}
          thread={thread}
          me={me}
          spawning={spawning}
          threadDraft={threadDraft}
          threadSending={threadSending}
          pendingReplies={pendingReplies}
          threadEndRef={threadEndRef}
          onClose={() => setActiveThreadRootId(null)}
          onSpawnLoop={handleSpawnLoopFromThread}
          onThreadDraftChange={setThreadDraft}
          onThreadSend={handleThreadSend}
          onRetryReply={retryReply}
          onDiscardReply={discardReply}
        />
      )}

      {showNewChannel && (
        <NewChannelDialog
          onClose={() => setShowNewChannel(false)}
          onCreate={handleCreateChannel}
        />
      )}
      {showDmPicker && (
        <DmPickerDialog
          users={users}
          existing={dms}
          onClose={() => setShowDmPicker(false)}
          onPick={handleOpenDm}
        />
      )}
    </div>
  )
}

function ThreadPanel({ isMobile, thread, me, spawning, threadDraft, threadSending, pendingReplies, threadEndRef, onClose, onSpawnLoop, onThreadDraftChange, onThreadSend, onRetryReply, onDiscardReply }: {
  isMobile: boolean
  thread: { root: ChatMessage; replies: ChatMessage[] } | null
  me: string
  spawning: boolean
  threadDraft: string
  threadSending: boolean
  pendingReplies: PendingMsg[]
  threadEndRef: React.RefObject<HTMLDivElement | null>
  onClose: () => void
  onSpawnLoop: () => void
  onThreadDraftChange: (v: string) => void
  onThreadSend: () => void
  onRetryReply: (p: PendingMsg) => void
  onDiscardReply: (tempId: string) => void
}) {
  const body = (
    <>
      <header className="px-4 h-12 shrink-0 border-b border-gray-200 flex items-center justify-between">
        <div className="text-[13px] font-medium text-gray-900">Thread</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSpawnLoop}
            disabled={spawning || !thread}
            className="px-2 py-1 rounded border border-gray-200 text-[11px] text-gray-700 hover:bg-gray-50 hover:border-gray-300 disabled:opacity-50 flex items-center gap-1"
          >
            <span className="text-gray-500">⑂</span>
            <span>{spawning ? "spawning…" : "spawn loop"}</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-900 text-base leading-none px-1"
          >×</button>
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-auto px-4 py-3 flex flex-col gap-3">
        {thread === null ? (
          <div className="text-[12px] text-gray-400 italic">loading…</div>
        ) : (
          <>
            <MessageRow message={thread.root} isMe={thread.root.author === me} compact />
            {thread.replies.length > 0 && (
              <div className="flex items-center gap-2 text-[11px] text-gray-400">
                <span className="flex-1 h-px bg-gray-200" />
                <span>{thread.replies.length} {thread.replies.length === 1 ? "reply" : "replies"}</span>
                <span className="flex-1 h-px bg-gray-200" />
              </div>
            )}
            {thread.replies.map((r) => (
              <MessageRow key={r.id} message={r} isMe={r.author === me} compact />
            ))}
            {pendingReplies
              .filter((p) => thread && p.parentId === thread.root.id)
              .map((p) => (
                <PendingRow
                  key={p.tempId}
                  pending={p}
                  author={me}
                  compact
                  onRetry={() => onRetryReply(p)}
                  onDiscard={() => onDiscardReply(p.tempId)}
                />
              ))}
            <div ref={threadEndRef} />
          </>
        )}
      </div>
      <div className="px-4 pb-4 pt-2 shrink-0">
        <div className="rounded-2xl border border-gray-200 bg-white p-2.5 shadow-sm flex flex-col gap-2">
          <textarea
            value={threadDraft}
            onChange={(e) => onThreadDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                onThreadSend()
              }
            }}
            rows={1}
            placeholder="Reply…"
            className="field-sizing-content w-full max-h-40 min-h-10 resize-none bg-transparent px-1.5 py-1 text-sm text-gray-900 outline-none placeholder:text-gray-400"
          />
          <div className="flex items-center justify-between border-t border-gray-100 pt-2 px-0.5">
            <div className="text-[10px] text-gray-400">Enter to reply · Shift+Enter for newline</div>
            <button
              type="button"
              onClick={onThreadSend}
              disabled={threadSending || !threadDraft.trim() || !thread}
              className="px-3 py-1 rounded bg-gray-900 text-white text-xs hover:bg-gray-700 disabled:opacity-40"
            >reply</button>
          </div>
        </div>
      </div>
    </>
  )

  if (isMobile) {
    return (
      <div className="fixed inset-0 z-30" onClick={onClose}>
        <div className="absolute inset-0 bg-black/30" />
        <div className="absolute right-0 top-0 bottom-0 w-full max-w-full bg-white border-l border-gray-200 shadow-xl flex flex-col" onClick={(e) => e.stopPropagation()}>
          {body}
        </div>
      </div>
    )
  }

  return (
    <aside className="w-[28rem] max-w-[40vw] min-w-[20rem] shrink-0 border-l border-gray-200 bg-white flex flex-col">
      {body}
    </aside>
  )
}

function ConvRow(props: {
  conv: ChatConversation
  active: boolean
  onClick: () => void
  onDelete?: () => void
}) {
  const c = props.conv
  return (
    <div className="relative group">
      <button
        type="button"
        onClick={props.onClick}
        className={
          props.active
            ? "mx-2 px-2 py-1 w-[calc(100%-1rem)] rounded text-[13px] flex items-center gap-2 bg-gray-100 text-gray-900"
            : "mx-2 px-2 py-1 w-[calc(100%-1rem)] rounded text-[13px] flex items-center gap-2 text-gray-500 hover:bg-gray-50 hover:text-gray-900"
        }
      >
        <span className="text-gray-400">{convSigil(c)}</span>
        <span className="truncate flex-1 text-left">{convDisplayName(c)}</span>
        {c.unread > 0 && (
          <span className="text-[11px] px-1.5 rounded-full bg-gray-200 text-gray-700">{c.unread}</span>
        )}
      </button>
      {props.onDelete && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); props.onDelete!() }}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-red-600 opacity-0 group-hover:opacity-100 text-xs px-1"
          title="delete channel (admin)"
        >×</button>
      )}
    </div>
  )
}

/**
 * Single message row. If `message` is a ChatThreadRoot (has replyCount),
 * renders the "💬 N replies" affordance and a hover "Reply" button. The
 * `compact` variant disables both (used inside ThreadPanel where the
 * thread is already open).
 */
function MessageRow(props: {
  message: ChatMessage | ChatThreadRoot
  isMe: boolean
  active?: boolean
  compact?: boolean
  onOpenThread?: () => void
}) {
  const m = props.message
  const isMe = props.isMe
  const replyCount = "replyCount" in m ? m.replyCount : 0
  const lastReplyTs = "lastReplyTs" in m ? m.lastReplyTs : null
  return (
    <div
      className={
        "group/msg relative -mx-1 px-1 py-0.5 rounded flex gap-3 " +
        (isMe ? "flex-row-reverse " : "") +
        (props.active ? "bg-amber-50/60" : "hover:bg-gray-50")
      }
    >
      <div
        className={
          isMe
            ? "w-7 h-7 rounded shrink-0 flex items-center justify-center text-[11px] font-medium bg-gray-900 text-white"
            : "w-7 h-7 rounded shrink-0 flex items-center justify-center text-[11px] font-medium bg-gray-200 text-gray-900"
        }
        title={m.author}
      >
        {m.author.slice(0, 1).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className={`flex items-center gap-2 ${isMe ? "justify-end" : ""}`}>
          {isMe ? (
            <>
              <span className="text-[11px] text-gray-500">{formatTime(m.ts)}</span>
              <span className="text-[10px] text-gray-500">you</span>
              <span className="text-[13px] font-medium text-gray-900">{m.author}</span>
            </>
          ) : (
            <>
              <span className="text-[13px] font-medium text-gray-900">{m.author}</span>
              <span className="text-[11px] text-gray-500">{formatTime(m.ts)}</span>
            </>
          )}
        </div>
        <div className={`text-[13px] text-gray-900 whitespace-pre-wrap leading-relaxed break-words ${isMe ? "text-right" : ""}`}>
          {m.text}
        </div>
        {/* Two states, same position (predictable scan path):
            - replies exist → persistent "💬 N replies · last X" (always shown)
            - no replies → bare "💬 Reply" shown ONLY on row hover (less noise) */}
        {!props.compact && props.onOpenThread && replyCount > 0 && (
          <button
            type="button"
            onClick={props.onOpenThread}
            className={`mt-1 text-[11px] text-blue-600 hover:underline ${isMe ? "ml-auto block text-right" : ""}`}
          >
            💬 {replyCount} {replyCount === 1 ? "reply" : "replies"}
            {lastReplyTs && <span className="text-gray-400 ml-1.5">· last {formatTime(lastReplyTs)}</span>}
          </button>
        )}
        {!props.compact && props.onOpenThread && replyCount === 0 && (
          <button
            type="button"
            onClick={props.onOpenThread}
            className={
              "mt-1 text-[11px] text-gray-400 hover:text-blue-600 hover:underline opacity-0 group-hover/msg:opacity-100 transition-opacity " +
              (isMe ? "ml-auto block text-right" : "")
            }
          >💬 Reply</button>
        )}
      </div>
    </div>
  )
}

/**
 * Render an outbox entry. Visual matches MessageRow shape (so it sits in
 * the feed naturally), but with a status badge — never let a "sending" or
 * "failed" entry look identical to a confirmed message.
 *
 *   pending: faded body + "sending…" pill, no actions
 *   failed:  red border + error text + Retry / Discard buttons
 */
function PendingRow(props: {
  pending: PendingMsg
  author: string
  compact?: boolean
  onRetry: () => void
  onDiscard: () => void
}) {
  const p = props.pending
  const isFailed = p.status === "failed"
  return (
    <div
      className={
        "flex flex-row-reverse gap-3 -mx-1 px-1 py-0.5 rounded " +
        (isFailed ? "ring-1 ring-red-200 bg-red-50/40" : "")
      }
    >
      <div className="w-7 h-7 rounded shrink-0 flex items-center justify-center text-[11px] font-medium bg-gray-900 text-white" title={props.author}>
        {props.author.slice(0, 1).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 justify-end">
          <span className="text-[11px] text-gray-500">{formatTime(p.ts)}</span>
          <span className="text-[10px] text-gray-500">you</span>
          <span className="text-[13px] font-medium text-gray-900">{props.author}</span>
          {isFailed ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-200">failed</span>
          ) : (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 inline-flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-gray-400 animate-pulse" />
              sending…
            </span>
          )}
        </div>
        <div
          className={
            "text-[13px] whitespace-pre-wrap leading-relaxed break-words text-right " +
            (isFailed ? "text-gray-700" : "text-gray-400")
          }
        >
          {p.text}
        </div>
        {isFailed && (
          <div className="mt-1 flex items-center gap-2 justify-end text-[11px]">
            {p.error && <span className="text-red-600">{p.error}</span>}
            <button
              type="button"
              onClick={props.onRetry}
              className="px-1.5 py-0.5 rounded border border-gray-300 text-gray-700 hover:bg-white"
            >retry</button>
            <button
              type="button"
              onClick={props.onDiscard}
              className="px-1.5 py-0.5 rounded text-gray-500 hover:text-red-600"
            >discard</button>
          </div>
        )}
      </div>
    </div>
  )
}

function NewChannelDialog(props: { onClose: () => void; onCreate: (name: string, topic: string) => void }) {
  const [name, setName] = useState("")
  const [topic, setTopic] = useState("")
  return (
    <div className="fixed inset-0 z-30 bg-black/30 flex items-center justify-center" onClick={props.onClose}>
      <div className="bg-white rounded-md shadow-lg w-96 p-4 flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-medium text-gray-900">New channel</div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="channel-name"
          className="px-2 py-1.5 text-sm rounded border border-gray-200 outline-none focus:border-gray-400"
        />
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="topic (optional)"
          className="px-2 py-1.5 text-sm rounded border border-gray-200 outline-none focus:border-gray-400"
        />
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={props.onClose} className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900">cancel</button>
          <button
            type="button"
            onClick={() => name.trim() && props.onCreate(name.trim(), topic.trim())}
            disabled={!name.trim()}
            className="px-3 py-1.5 text-xs rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40"
          >create</button>
        </div>
      </div>
    </div>
  )
}

function DmPickerDialog(props: {
  users: ChatWorkspaceUser[]
  existing: ChatConversation[]
  onClose: () => void
  onPick: (username: string) => void
}) {
  const [q, setQ] = useState("")
  const filtered = props.users
    .filter((u) => !u.isMe)
    .filter((u) => u.id.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="fixed inset-0 z-30 bg-black/30 flex items-center justify-center" onClick={props.onClose}>
      <div className="bg-white rounded-md shadow-lg w-96 p-4 flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-medium text-gray-900">Direct message</div>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search users…"
          className="px-2 py-1.5 text-sm rounded border border-gray-200 outline-none focus:border-gray-400"
        />
        <div className="max-h-64 overflow-auto flex flex-col gap-0.5">
          {filtered.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => props.onPick(u.id)}
              className="text-left px-2 py-1.5 text-sm rounded hover:bg-gray-100 flex items-center gap-2"
            >
              <span className="w-6 h-6 rounded bg-gray-200 text-gray-900 text-[11px] flex items-center justify-center">
                {u.id.slice(0, 1).toUpperCase()}
              </span>
              <span>{u.id}</span>
              {u.role === "admin" && (
                <span className="text-[10px] text-gray-400 ml-auto">admin</span>
              )}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="text-xs text-gray-400 px-2 py-2">no users match</div>
          )}
        </div>
      </div>
    </div>
  )
}
