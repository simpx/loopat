/**
 * Chat tab — Slack-like channels + 1:1 DMs.
 *
 * Persistent storage of record is server-side SQLite (chat.db). When a
 * loop is spawned from a chat conversation, the last 1024 messages are
 * snapshotted to /loopat/context/chat/<convId>.jsonl inside the new
 * loop's sandbox view so AI inside the loop can read the source thread.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import {
  listChatConversations,
  listChatMessages,
  listChatUsers,
  sendChatMessage,
  markChatRead,
  createChatChannel,
  deleteChatChannel,
  openChatDm,
  spawnLoopFromChat,
  type ChatConversation,
  type ChatMessage,
  type ChatWorkspaceUser,
} from "../api"
import { useChatWebSocket, type ChatWsEvent } from "../useChatWebSocket"
import { useWorkspace } from "../ctx"

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
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [spawning, setSpawning] = useState(false)
  const [showDmPicker, setShowDmPicker] = useState(false)
  const [showNewChannel, setShowNewChannel] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const activeConvIdRef = useRef<string | undefined>(convId)
  activeConvIdRef.current = convId

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

  // On URL convId change → fetch messages, mark read, optimistically zero unread.
  useEffect(() => {
    if (!convId) return
    let cancelled = false
    listChatMessages(convId, { limit: 100 }).then((msgs) => {
      if (cancelled) return
      setMessages(msgs)
      // mark-read up to the latest message
      const last = msgs[msgs.length - 1]
      if (last) {
        markChatRead(convId, last.id).catch(() => {})
        setConvs((prev) => prev.map((c) => (c.id === convId ? { ...c, unread: 0 } : c)))
      }
    })
    return () => {
      cancelled = true
    }
  }, [convId])

  // Default redirect to first channel when no convId
  useEffect(() => {
    if (convId) return
    if (convs.length === 0) return
    const first = channels[0] ?? convs[0]
    if (first) navigate(`/chat/${first.id}`, { replace: true })
  }, [convId, convs, channels, navigate])

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  // ── websocket ──

  const onEvent = useCallback(
    (e: ChatWsEvent) => {
      if (e.type === "message") {
        const m = e.message
        if (m.convId === activeConvIdRef.current) {
          setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]))
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

  const handleSend = async () => {
    const text = draft.trim()
    if (!text || !convId || sending) return
    setSending(true)
    const r = await sendChatMessage(convId, text)
    setSending(false)
    if (r.message) {
      setDraft("")
      // Optimistically append — ws will dedupe if it races.
      setMessages((prev) => (prev.some((x) => x.id === r.message!.id) ? prev : [...prev, r.message!]))
    } else if (r.error) {
      console.error("send failed:", r.error)
    }
  }

  const handleSpawnLoop = async () => {
    if (!convId || spawning) return
    setSpawning(true)
    const r = await spawnLoopFromChat(convId)
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

  return (
    <div className="flex h-full w-full bg-white">
      {/* Rail */}
      <aside className="w-60 shrink-0 border-r border-gray-200 bg-white flex flex-col">
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
              onClick={() => navigate(`/chat/${c.id}`)}
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
              onClick={() => navigate(`/chat/${c.id}`)}
            />
          ))}
          {dms.length === 0 && (
            <div className="mx-2 px-2 py-1 text-[11px] text-gray-400">no DMs yet</div>
          )}
        </div>
        <div className="flex-1" />
      </aside>

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
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSpawnLoop}
                  disabled={spawning}
                  className="px-2.5 py-1 rounded border border-gray-200 text-xs text-gray-700 hover:bg-gray-50 hover:border-gray-300 disabled:opacity-50 flex items-center gap-1.5"
                  title="spawn a loop seeded with this conversation's history (last 1024 messages snapshot to /loopat/context/chat/<convId>.jsonl)"
                >
                  <span className="text-gray-500">⑂</span>
                  <span>{spawning ? "spawning…" : "spawn loop"}</span>
                </button>
              </div>
            </header>

            <div className="flex-1 min-h-0 overflow-auto px-5 py-4 flex flex-col gap-3">
              {messages.length === 0 && (
                <div className="text-[13px] text-gray-500">no messages yet — say hi</div>
              )}
              {messages.map((m) => (
                <MessageRow key={m.id} message={m} isMe={m.author === me} />
              ))}
              <div ref={messagesEndRef} />
            </div>

            <div className="px-5 pb-4 pt-2 shrink-0">
              <div className="rounded-2xl border border-gray-200 bg-white p-2.5 shadow-sm flex flex-col gap-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
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

function MessageRow(props: { message: ChatMessage; isMe: boolean }) {
  const m = props.message
  const isMe = props.isMe
  return (
    <div className={`flex gap-3 ${isMe ? "flex-row-reverse" : ""}`}>
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
