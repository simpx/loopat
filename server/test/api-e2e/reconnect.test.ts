/**
 * L4 api-e2e: GET /events opened mid-turn → server emits `snapshot` first.
 *
 * Per api-v1.ts:577 the snapshot fires when `session.isBusy() &&
 * runtime.currentTurnId` at the time of attach. This is the "user
 * refreshed the page while CC was already working" path.
 *
 * Asserts:
 *   - snapshot is emitted (and is the first non-ping event)
 *   - snapshot payload carries the running turn_id
 *   - subsequent live events (e.g. done from the in-flight turn) still
 *     reach the viewer, so it's a true reconnect, not just a sniff
 */
import { test, expect, describe } from "bun:test"
import {
  podmanAvailable,
  mock,
  blocks,
  lastIsToolResult,
  createLoop,
  sendMessage,
  eventsStream,
  sseEvents,
  readUntilTurnEnds,
  dumpEvents,
  sleep,
  type SSEEvent,
} from "./helpers"

describe.skipIf(!podmanAvailable)("api-e2e: reconnect", () => {
  test("GET /events attached mid-turn → first non-ping event is `snapshot`", async () => {
    const loopId = await createLoop({ title: "reconnect-snapshot" })

    mock.register({
      marker: "[[rc-slow]]",
      *respond(req) {
        if (!lastIsToolResult(req)) {
          // Slow enough to give us room to open the viewer mid-turn.
          yield blocks.text("starting now...")
          yield blocks.bash("sleep 3")
          yield blocks.endTool()
        } else {
          yield blocks.text("ok done")
          yield blocks.endTurn()
        }
      },
    })

    // Kick off a long turn but don't wait for it.
    const send = await sendMessage(loopId, "[[rc-slow]] go work")
    expect(send.status).toBe(200)
    const drainSend = readUntilTurnEnds(send, 60_000)

    // Wait until the turn is *really* running: mock has been hit AND the
    // SDK had a moment to set runtime.currentTurnId. Polling on mock.hits
    // is a reasonable proxy; +200ms gives the SDK time to push `started`.
    for (let i = 0; i < 50; i++) {
      await sleep(50)
      if (mock.hits("[[rc-slow]]") >= 1) break
    }
    await sleep(250)

    // Now attach the viewer.
    const viewer = await eventsStream(loopId)
    expect(viewer.status).toBe(200)
    const viewerEvents: SSEEvent[] = []
    const gen = sseEvents(viewer, { timeoutMs: 60_000 })

    // First non-ping event we see should be `snapshot`. Pings can arrive
    // every 15s (heartbeat), but we expect the snapshot to come out
    // immediately on attach — well before any heartbeat.
    let firstReal: SSEEvent | null = null
    for (let i = 0; i < 50; i++) {
      const n = await gen.next()
      if (n.done) break
      viewerEvents.push(n.value)
      if (n.value.event !== "ping") {
        firstReal = n.value
        break
      }
    }

    if (!firstReal || firstReal.event !== "snapshot") dumpEvents(viewerEvents)
    expect(firstReal?.event).toBe("snapshot")
    expect(typeof firstReal!.data.turn_id).toBe("string")
    expect(firstReal!.data.turn_id).toMatch(/^turn_/)

    // Keep reading the viewer until we see the turn finish — proves it's
    // a real reconnect feeding live events, not just a snapshot snip.
    for (let i = 0; i < 200; i++) {
      const n = await gen.next()
      if (n.done) break
      viewerEvents.push(n.value)
      if (n.value.event === "done" || n.value.event === "error" || n.value.event === "interrupted") break
    }
    await gen.return(undefined as any)
    expect(viewerEvents.some((e) => e.event === "done")).toBe(true)

    // POST stream should also be done.
    const sendEvents = await drainSend
    expect(sendEvents.some((e) => e.event === "done")).toBe(true)
  }, 90_000)
})
