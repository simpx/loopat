import { useEffect, useState, useRef } from "react"

type StatusMap = Record<string, { status: string; updated: string; viewed?: boolean }>

export function useLoopStatus(loopIds: string[]) {
  const [statusMap, setStatusMap] = useState<StatusMap>({})
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (loopIds.length === 0) return
    const protocol = location.protocol === "https:" ? "wss:" : "ws:"
    const ws = new WebSocket(`${protocol}//${location.host}/ws/loop-status`)
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "subscribe", ids: loopIds }))
    }

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === "init" || msg.type === "update") {
          setStatusMap(prev => ({ ...prev, ...msg.data }))
        }
      } catch {}
    }

    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [loopIds.join(",")])

  return statusMap
}
