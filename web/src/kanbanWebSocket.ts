export type KanbanWebSocketLike = {
  readyState: number
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
  close: () => void
}

export function cleanupKanbanWebSocket(ws: KanbanWebSocketLike | null, connectingState: number) {
  if (!ws) return
  if (ws.readyState === connectingState) {
    ws.onopen = () => ws.close()
    ws.onmessage = null
    ws.onclose = null
    ws.onerror = null
    return
  }
  ws.onmessage = null
  ws.onclose = null
  ws.onerror = null
  ws.close()
}

export function handleKanbanUnexpectedClose({
  wsRef,
  setConnected,
  connect,
  setTimeoutFn = setTimeout,
  randomFn = Math.random,
}: {
  wsRef: { current: KanbanWebSocketLike | null }
  setConnected: (connected: boolean) => void
  connect: () => void
  setTimeoutFn?: (callback: () => void, delay: number) => unknown
  randomFn?: () => number
}) {
  setConnected(false)
  wsRef.current = null
  setTimeoutFn(connect, 2000 + randomFn() * 3000)
}
