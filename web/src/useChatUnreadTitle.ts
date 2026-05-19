import { useEffect, useRef, useState } from "react"
import { listChatConversations } from "./api"

/**
 * Drive the browser tab title from total chat unread.
 *
 *   no unread:   "<workspace> · loopat"
 *   N unread:    "(N) <workspace> · loopat"
 *
 * Owns document.title fully when `enabled` — App should not also set it.
 *
 * Why a second /ws/chat connection (vs. reusing ChatPage's): ChatPage isn't
 * mounted on /loop/* etc., but the title needs to update everywhere. Two
 * subscriptions are cheap; the server fans out by membership, not connection.
 *
 * Mark-read sync: ChatPage dispatches a "loopat:chat-read" window event
 * after calling markChatRead so we can zero the conv immediately without
 * waiting for a refetch / focus.
 */
export function useChatUnreadTitle(workspaceName: string, enabled: boolean, me: string) {
  const [unreadByConv, setUnreadByConv] = useState<Record<string, number>>({})
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    const refetch = async () => {
      const convs = await listChatConversations()
      if (cancelled) return
      const next: Record<string, number> = {}
      for (const c of convs) next[c.id] = c.unread
      setUnreadByConv(next)
    }

    const openWs = (convIds: string[]) => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:"
      const ws = new WebSocket(`${proto}//${location.host}/ws/chat`)
      wsRef.current = ws
      ws.onopen = () => {
        for (const id of convIds) ws.send(JSON.stringify({ type: "subscribe", convId: id }))
      }
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === "message") {
            if (msg.message.author !== me) {
              setUnreadByConv((prev) => ({
                ...prev,
                [msg.message.convId]: (prev[msg.message.convId] ?? 0) + 1,
              }))
            }
          } else if (msg.type === "conv_created") {
            ws.send(JSON.stringify({ type: "subscribe", convId: msg.conv.id }))
          }
        } catch {}
      }
      ws.onclose = () => {
        if (cancelled) return
        // Reconnect after a delay; refetch to recover any drift.
        setTimeout(() => { if (!cancelled) bootstrap() }, 3000)
      }
      ws.onerror = () => { try { ws.close() } catch {} }
    }

    const bootstrap = async () => {
      const convs = await listChatConversations()
      if (cancelled) return
      const next: Record<string, number> = {}
      for (const c of convs) next[c.id] = c.unread
      setUnreadByConv(next)
      openWs(convs.map((c) => c.id))
    }

    bootstrap()

    const onMarkRead = (e: Event) => {
      const detail = (e as CustomEvent).detail as { convId: string } | undefined
      if (!detail?.convId) return
      setUnreadByConv((prev) => (
        prev[detail.convId] === 0 ? prev : { ...prev, [detail.convId]: 0 }
      ))
    }
    const onFocus = () => { refetch().catch(() => {}) }

    window.addEventListener("loopat:chat-read", onMarkRead)
    window.addEventListener("focus", onFocus)

    return () => {
      cancelled = true
      window.removeEventListener("loopat:chat-read", onMarkRead)
      window.removeEventListener("focus", onFocus)
      try { wsRef.current?.close() } catch {}
      wsRef.current = null
    }
  }, [enabled, me])

  useEffect(() => {
    if (!enabled) return
    let total = 0
    for (const k in unreadByConv) total += unreadByConv[k]
    const suffix = `${workspaceName} · loopat`
    document.title = total > 0 ? `(${total}) ${suffix}` : suffix
  }, [unreadByConv, workspaceName, enabled])
}
