import { useEffect, useRef, useCallback, useState } from "react"
import { cleanupKanbanWebSocket, handleKanbanUnexpectedClose } from "./kanbanWebSocket"

export function useKanbanWebSocket(onUpdate: () => void) {
  const wsRef = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate

  const connect = useCallback(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:"
    const ws = new WebSocket(`${proto}//${location.host}/ws/kanban`)
    wsRef.current = ws

    ws.onopen = () => setConnected(true)

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === "kanban_update") {
          onUpdateRef.current()
        }
      } catch {}
    }

    ws.onclose = () => {
      handleKanbanUnexpectedClose({ wsRef, setConnected, connect })
    }

    ws.onerror = () => {
      ws.close()
    }
  }, [])

  useEffect(() => {
    connect()
    return () => {
      const ws = wsRef.current
      wsRef.current = null
      cleanupKanbanWebSocket(ws, WebSocket.CONNECTING)
    }
  }, [connect])

  return connected
}
