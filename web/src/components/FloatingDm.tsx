/**
 * Floating DM widget — bottom-right bubble that opens a small DM-only panel.
 * Channels still go through the full /chat route; this is the
 * lightweight always-on-top affordance for 1:1s while you're working in
 * a loop / focus / kanban / context tab.
 *
 * Owns its own WS subscriptions (cheap; server fans out by membership).
 * Mark-read uses the same `loopat:chat-read` window event ChatPage uses,
 * so the unread badge stays in sync if a DM is read from either surface.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { MessageCircle, X, ArrowLeft, Plus, ExternalLink } from "lucide-react"
import { useNavigate } from "react-router-dom"
import {
  listChatConversations,
  listChatMessages,
  listChatUsers,
  sendChatMessage,
  markChatRead,
  openChatDm,
  type ChatConversation,
  type ChatMessage,
  type ChatThreadRoot,
  type ChatWorkspaceUser,
} from "../api"
import { useChatWebSocket, type ChatWsEvent } from "../useChatWebSocket"

const LS_OPEN = "loopat:floating-dm-open"
const LS_CONV = "loopat:floating-dm-conv"

function formatTime(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const hhmm = d.toTimeString().slice(0, 5)
  if (sameDay) return hhmm
  const yesterday = new Date(today.getTime() - 86_400_000).toDateString() === d.toDateString()
  if (yesterday) return `yesterday ${hhmm}`
  return `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`
}

export function FloatingDm({ me }: { me: string }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(() => localStorage.getItem(LS_OPEN) === "1")
  const [activeConvId, setActiveConvId] = useState<string | null>(() => localStorage.getItem(LS_CONV))
  const [showPicker, setShowPicker] = useState(false)

  const [convs, setConvs] = useState<ChatConversation[]>([])
  const [users, setUsers] = useState<ChatWorkspaceUser[]>([])
  const [messages, setMessages] = useState<ChatThreadRoot[]>([])
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)

  const dms = useMemo(
    () =>
      convs
        .filter((c) => c.kind === "dm")
        .sort((a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0)),
    [convs],
  )
  const totalUnread = useMemo(() => dms.reduce((s, c) => s + c.unread, 0), [dms])
  const active = useMemo(() => dms.find((c) => c.id === activeConvId) ?? null, [dms, activeConvId])

  // persist
  useEffect(() => { localStorage.setItem(LS_OPEN, open ? "1" : "0") }, [open])
  useEffect(() => {
    if (activeConvId) localStorage.setItem(LS_CONV, activeConvId)
    else localStorage.removeItem(LS_CONV)
  }, [activeConvId])

  const refreshConvs = useCallback(async () => {
    const list = await listChatConversations()
    setConvs(list)
  }, [])

  useEffect(() => {
    refreshConvs()
    listChatUsers().then(setUsers)
  }, [refreshConvs])

  // Load messages whenever the active DM changes (also runs on initial open
  // if we restored a convId from localStorage).
  useEffect(() => {
    if (!activeConvId) {
      setMessages([])
      return
    }
    let cancelled = false
    listChatMessages(activeConvId, { limit: 100 }).then((msgs) => {
      if (cancelled) return
      setMessages(msgs)
      const last = msgs[msgs.length - 1]
      if (last) {
        markChatRead(activeConvId, last.id).catch(() => {})
        setConvs((prev) => prev.map((c) => (c.id === activeConvId ? { ...c, unread: 0 } : c)))
        window.dispatchEvent(new CustomEvent("loopat:chat-read", { detail: { convId: activeConvId } }))
      }
    })
    return () => { cancelled = true }
  }, [activeConvId])

  useEffect(() => {
    if (open && active) messagesEndRef.current?.scrollIntoView({ behavior: "auto" })
  }, [messages, open, active])

  // ── ws ──
  const activeRef = useRef<string | null>(activeConvId)
  activeRef.current = activeConvId

  const onEvent = useCallback((e: ChatWsEvent) => {
    if (e.type === "message") {
      const m = e.message
      const isActive = m.convId === activeRef.current
      if (isActive && m.parentId == null) {
        setMessages((prev) => (
          prev.some((x) => x.id === m.id)
            ? prev
            : [...prev, { ...m, replyCount: 0, lastReplyTs: null }]
        ))
        markChatRead(m.convId, m.id).catch(() => {})
        window.dispatchEvent(new CustomEvent("loopat:chat-read", { detail: { convId: m.convId } }))
      } else if (isActive && m.parentId != null) {
        // reply on a message we have — bump reply count so the "💬 N replies"
        // affordance updates (we don't render the thread inline).
        setMessages((prev) => prev.map((x) =>
          x.id === m.parentId
            ? { ...x, replyCount: x.replyCount + 1, lastReplyTs: m.ts }
            : x,
        ))
      } else if (m.author !== me) {
        // not the active conv && not self — bump unread + lastMessageTs for sort order.
        setConvs((prev) => prev.map((c) =>
          c.id === m.convId
            ? { ...c, unread: c.unread + 1, lastMessageTs: m.ts }
            : c,
        ))
      }
    } else if (e.type === "conv_created") {
      setConvs((prev) => (prev.some((c) => c.id === e.conv.id) ? prev : [...prev, e.conv]))
    } else if (e.type === "conv_deleted") {
      setConvs((prev) => prev.filter((c) => c.id !== e.convId))
      if (activeRef.current === e.convId) setActiveConvId(null)
    }
  }, [me])

  const { subscribe, unsubscribe } = useChatWebSocket(onEvent)
  useEffect(() => {
    for (const c of dms) subscribe(c.id)
    return () => { for (const c of dms) unsubscribe(c.id) }
  }, [dms, subscribe, unsubscribe])

  // Cross-surface sync: when ChatPage marks a conv read, mirror it here.
  useEffect(() => {
    const onRead = (e: Event) => {
      const detail = (e as CustomEvent).detail as { convId?: string } | undefined
      if (!detail?.convId) return
      setConvs((prev) => prev.map((c) => (c.id === detail.convId ? { ...c, unread: 0 } : c)))
    }
    window.addEventListener("loopat:chat-read", onRead)
    return () => window.removeEventListener("loopat:chat-read", onRead)
  }, [])

  const handleSend = async () => {
    if (!active || !draft.trim() || sending) return
    const text = draft.trim()
    setDraft("")
    setSending(true)
    const r = await sendChatMessage(active.id, text)
    setSending(false)
    if (r.message) {
      const m = r.message
      setMessages((prev) => (
        prev.some((x) => x.id === m.id)
          ? prev
          : [...prev, { ...m, replyCount: 0, lastReplyTs: null }]
      ))
    } else {
      // restore draft on failure so the user can retry / edit
      setDraft(text)
    }
  }

  const handleOpenDm = async (userId: string) => {
    const r = await openChatDm(userId)
    if (r.conv) {
      setShowPicker(false)
      setActiveConvId(r.conv.id)
      refreshConvs()
    } else if (r.error) {
      alert(r.error)
    }
  }

  const openFullChat = () => {
    if (active) navigate(`/chat/${active.id}`)
    else navigate("/chat")
    setOpen(false)
  }

  if (!me) return null

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={
            "fixed bottom-20 right-5 z-30 w-12 h-12 rounded-full flex items-center justify-center shadow-lg transition-colors " +
            (totalUnread > 0
              ? "bg-gray-700 text-white animate-pulse"
              : "bg-gray-700 text-white hover:bg-gray-500")
          }
          title="direct messages"
        >
          <MessageCircle size={20} />
          {totalUnread > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-medium flex items-center justify-center">
              {totalUnread > 99 ? "99+" : totalUnread}
            </span>
          )}
        </button>
      )}

      {open && (
        <div className="fixed bottom-20 right-5 z-30 w-[22rem] max-w-[calc(100vw-2.5rem)] h-[32rem] max-h-[calc(100dvh-2.5rem)] bg-white rounded-lg shadow-2xl border border-gray-200 flex flex-col overflow-hidden">
          <header className="h-10 shrink-0 border-b border-gray-200 px-2 flex items-center gap-1">
            {active ? (
              <button
                type="button"
                onClick={() => setActiveConvId(null)}
                className="w-7 h-7 flex items-center justify-center rounded text-gray-500 hover:text-gray-900 hover:bg-gray-100"
                title="back to DMs"
              >
                <ArrowLeft size={14} />
              </button>
            ) : (
              <span className="px-2 text-[13px] font-medium text-gray-900">Direct messages</span>
            )}
            {active && (
              <div className="flex-1 min-w-0 flex items-center gap-1.5">
                <span className="text-gray-400 text-[13px]">@</span>
                <span className="text-[13px] font-medium text-gray-900 truncate">
                  {active.peerUserId ?? "(unknown)"}
                </span>
              </div>
            )}
            {!active && <div className="flex-1" />}
            {!active && (
              <button
                type="button"
                onClick={() => setShowPicker(true)}
                className="w-7 h-7 flex items-center justify-center rounded text-gray-500 hover:text-gray-900 hover:bg-gray-100"
                title="new DM"
              >
                <Plus size={14} />
              </button>
            )}
            {active && (
              <button
                type="button"
                onClick={openFullChat}
                className="w-7 h-7 flex items-center justify-center rounded text-gray-500 hover:text-gray-900 hover:bg-gray-100"
                title="open in chat tab"
              >
                <ExternalLink size={13} />
              </button>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="w-7 h-7 flex items-center justify-center rounded text-gray-500 hover:text-gray-900 hover:bg-gray-100"
              title="close"
            >
              <X size={14} />
            </button>
          </header>

          {active ? (
            <>
              <div className="flex-1 min-h-0 overflow-auto px-3 py-2 flex flex-col gap-2">
                {messages.length === 0 && (
                  <div className="text-[12px] text-gray-400 italic py-4 text-center">
                    no messages yet — say hi
                  </div>
                )}
                {messages.map((m) => (
                  <MiniMessage key={m.id} message={m} isMe={m.author === me} />
                ))}
                <div ref={messagesEndRef} />
              </div>
              <div className="px-2 pb-2 pt-1 shrink-0">
                <div className="rounded-xl border border-gray-200 bg-white p-1.5 flex items-end gap-1">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing) return
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault()
                        handleSend()
                      }
                    }}
                    rows={1}
                    placeholder={`message @${active.peerUserId ?? ""}…`}
                    className="field-sizing-content flex-1 max-h-32 min-h-7 resize-none bg-transparent px-1.5 py-1 text-sm text-gray-900 outline-none placeholder:text-gray-400"
                  />
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={sending || !draft.trim()}
                    className="px-2.5 h-7 rounded bg-gray-900 text-white text-xs hover:bg-gray-700 disabled:opacity-40 shrink-0"
                  >
                    send
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 min-h-0 overflow-auto">
              {dms.length === 0 ? (
                <div className="px-4 py-6 text-center text-[12px] text-gray-400">
                  no DMs yet
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => setShowPicker(true)}
                      className="px-2 py-1 rounded border border-gray-200 text-[12px] text-gray-700 hover:bg-gray-50 inline-flex items-center gap-1"
                    >
                      <Plus size={12} />
                      <span>new DM</span>
                    </button>
                  </div>
                </div>
              ) : (
                <ul className="py-1">
                  {dms.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => setActiveConvId(c.id)}
                        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-gray-50"
                      >
                        <span className="w-7 h-7 rounded bg-gray-200 text-gray-900 text-[11px] font-medium flex items-center justify-center shrink-0">
                          {(c.peerUserId ?? "?").slice(0, 1).toUpperCase()}
                        </span>
                        <span className="flex-1 min-w-0 text-[13px] text-gray-900 truncate">
                          @{c.peerUserId ?? "(unknown)"}
                        </span>
                        {c.unread > 0 && (
                          <span className="text-[10px] font-medium px-1.5 rounded-full bg-red-500 text-white">
                            {c.unread}
                          </span>
                        )}
                        {c.lastMessageTs && c.unread === 0 && (
                          <span className="text-[10px] text-gray-400">{formatTime(c.lastMessageTs)}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {showPicker && (
        <DmPicker
          users={users}
          onClose={() => setShowPicker(false)}
          onPick={handleOpenDm}
        />
      )}
    </>
  )
}

function MiniMessage({ message, isMe }: { message: ChatMessage; isMe: boolean }) {
  return (
    <div className={"flex gap-1.5 " + (isMe ? "flex-row-reverse" : "")}>
      <div
        className={
          isMe
            ? "w-6 h-6 rounded shrink-0 flex items-center justify-center text-[10px] font-medium bg-gray-900 text-white"
            : "w-6 h-6 rounded shrink-0 flex items-center justify-center text-[10px] font-medium bg-gray-200 text-gray-900"
        }
        title={message.author}
      >
        {message.author.slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0 max-w-[80%]">
        <div className={"text-[10px] text-gray-400 " + (isMe ? "text-right" : "")}>
          {formatTime(message.ts)}
        </div>
        <div
          className={
            "text-[12.5px] whitespace-pre-wrap break-words leading-relaxed px-2 py-1 rounded-lg " +
            (isMe ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-900")
          }
        >
          {message.text}
        </div>
      </div>
    </div>
  )
}

function DmPicker({
  users,
  onClose,
  onPick,
}: {
  users: ChatWorkspaceUser[]
  onClose: () => void
  onPick: (userId: string) => void
}) {
  const [q, setQ] = useState("")
  const filtered = users
    .filter((u) => !u.isMe)
    .filter((u) => u.id.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="fixed inset-0 z-40 bg-black/30 flex items-center justify-center" onClick={onClose}>
      <div className="bg-white rounded-md shadow-lg w-80 p-3 flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-medium text-gray-900">New DM</div>
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
              onClick={() => onPick(u.id)}
              className="text-left px-2 py-1.5 text-sm rounded hover:bg-gray-100 flex items-center gap-2"
            >
              <span className="w-6 h-6 rounded bg-gray-200 text-gray-900 text-[11px] flex items-center justify-center">
                {u.id.slice(0, 1).toUpperCase()}
              </span>
              <span>{u.id}</span>
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
