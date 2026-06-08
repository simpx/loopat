import { describe, expect, test } from "bun:test"
import { cleanupKanbanWebSocket, handleKanbanUnexpectedClose, type KanbanWebSocketLike } from "../src/kanbanWebSocket"

function fakeSocket(readyState: number): KanbanWebSocketLike & { closeCount: number } {
  return {
    readyState,
    closeCount: 0,
    onopen: () => {},
    onmessage: () => {},
    onclose: () => {},
    onerror: () => {},
    close() {
      this.closeCount += 1
    },
  }
}

describe("cleanupKanbanWebSocket", () => {
  test("detaches reconnect handlers and closes CONNECTING sockets only after open", () => {
    const ws = fakeSocket(0)

    cleanupKanbanWebSocket(ws, 0)

    expect(ws.onmessage).toBeNull()
    expect(ws.onclose).toBeNull()
    expect(ws.onerror).toBeNull()
    expect(ws.closeCount).toBe(0)

    ws.onopen?.({} as Event)
    expect(ws.closeCount).toBe(1)
  })

  test("detaches reconnect handlers before closing open sockets", () => {
    const ws = fakeSocket(1)

    cleanupKanbanWebSocket(ws, 0)

    expect(ws.onmessage).toBeNull()
    expect(ws.onclose).toBeNull()
    expect(ws.onerror).toBeNull()
    expect(ws.closeCount).toBe(1)
  })
})

describe("handleKanbanUnexpectedClose", () => {
  test("normal unexpected close clears the ref and schedules reconnect", () => {
    let connected: boolean | null = null
    let reconnectDelay = 0
    const ref = { current: fakeSocket(3) as KanbanWebSocketLike | null }

    handleKanbanUnexpectedClose({
      wsRef: ref,
      setConnected: (next) => { connected = next },
      connect: () => {},
      setTimeoutFn: (_callback, delay) => {
        reconnectDelay = delay
        return 1
      },
      randomFn: () => 0,
    })

    expect(connected).toBe(false)
    expect(ref.current).toBeNull()
    expect(reconnectDelay).toBe(2000)
  })
})
