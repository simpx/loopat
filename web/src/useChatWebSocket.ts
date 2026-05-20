import { useEffect, useRef, useCallback, useState } from "react"
import type { ChatConversation, ChatMessage } from "./api"
import { getVersion, getBuildInfo } from "./api"

export type ChatWsEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "conv_created"; conv: ChatConversation }
  | { type: "conv_deleted"; convId: string }

/**
 * /ws/chat connection. Client subscribes to specific conversations; server
 * fans out messages only to subscribers (and respects DM-party permissions).
 *
 * Caller passes a stable `onEvent` callback; this hook keeps the latest
 * callback in a ref so reconnection doesn't churn.
 */
export function useChatWebSocket(onEvent: (e: ChatWsEvent) => void) {
  const wsRef = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  // Re-subscribe on reconnect — store the current subscription set in a ref
  // so connect() can replay it without depending on React state.
  const subsRef = useRef<Set<string>>(new Set())

  const sendIfOpen = useCallback((obj: object) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj))
    }
  }, [])

  const subscribe = useCallback((convId: string) => {
    if (subsRef.current.has(convId)) return
    subsRef.current.add(convId)
    sendIfOpen({ type: "subscribe", convId })
  }, [sendIfOpen])

  const unsubscribe = useCallback((convId: string) => {
    if (!subsRef.current.has(convId)) return
    subsRef.current.delete(convId)
    sendIfOpen({ type: "unsubscribe", convId })
  }, [sendIfOpen])

  const connect = useCallback(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:"
    const ws = new WebSocket(`${proto}//${location.host}/ws/chat`)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      // Re-subscribe to anything that was previously subscribed
      for (const cid of subsRef.current) {
        try { ws.send(JSON.stringify({ type: "subscribe", convId: cid })) } catch {}
      }
      // Check if server version differs from the frontend build
      getVersion().then((v) => {
        const build = getBuildInfo()
        if (v.commit !== "unknown" && build.commit !== "unknown" && v.commit !== build.commit) {
          window.dispatchEvent(new CustomEvent("loopat:version-mismatch", { detail: { commit: v.commit } }))
        }
      }).catch(() => {})
    }

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === "chat_connected") return
        if (msg.type === "message" || msg.type === "conv_created" || msg.type === "conv_deleted") {
          onEventRef.current(msg as ChatWsEvent)
        }
      } catch {}
    }

    ws.onclose = () => {
      setConnected(false)
      wsRef.current = null
      setTimeout(connect, 2000 + Math.random() * 3000)
    }

    ws.onerror = () => {
      // onerror fires when the connection fails or close() is called on a
      // CONNECTING socket (e.g. StrictMode unmount). Let onclose handle it.
    }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      const ws = wsRef.current
      if (ws) {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.onopen = () => ws.close()
          ws.onmessage = null
          ws.onclose = null
          ws.onerror = null
        } else {
          ws.onclose = null
          ws.onerror = null
          ws.close()
        }
      }
      wsRef.current = null
    }
  }, [connect])

  return { connected, subscribe, unsubscribe }
}
