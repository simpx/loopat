/**
 * L4 api-e2e: queue when busy.
 *
 *   T1  Send msg 1 with a slow Bash (CC really sleeps inside the sandbox);
 *       immediately send msg 2; msg 2's SSE stream must start with
 *       `event: queued` (position ≥ 1). After msg 1 completes, msg 2 fires
 *       its own `started` and runs to `done` normally.
 *
 * What this verifies on top of api-v1.test.ts unit tests: the queue logic
 * works against a real running turn (not a faked-busy state), and the
 * second SSE stream actually flushes `queued` before the first turn ends.
 */
import { test, expect, describe } from "bun:test"
import {
  podmanAvailable,
  mock,
  blocks,
  lastIsToolResult,
  createLoop,
  sendMessage,
  sseEvents,
  dumpEvents,
  type SSEEvent,
} from "./helpers"

describe.skipIf(!podmanAvailable)("api-e2e: queue", () => {
  test("second POST while busy → SSE starts with `queued`, then runs to done after the first finishes", async () => {
    const loopId = await createLoop({ title: "queue-busy" })

    mock.register({
      marker: "[[q-slow]]",
      *respond(req) {
        if (!lastIsToolResult(req)) {
          // Real sleep inside the container — keeps the turn open ~3s.
          yield blocks.bash("sleep 3")
          yield blocks.endTool()
        } else {
          yield blocks.text("slow done")
          yield blocks.endTurn()
        }
      },
    })
    mock.register({
      marker: "[[q-fast]]",
      *respond() {
        yield blocks.text("fast done")
        yield blocks.endTurn()
      },
    })

    // Send msg 1. The await here only blocks until response headers — the
    // SSE handler hasn't yet called session.sendUserText, so the session
    // is NOT yet busy at this point. We need a *real* mid-flight signal
    // before sending msg 2.
    const send1 = await sendMessage(loopId, "[[q-slow]] please be slow")
    expect(send1.status).toBe(200)

    const gen1 = sseEvents(send1, { timeoutMs: 90_000 })
    const events1: SSEEvent[] = []

    // Wait until msg 1 is *actually* mid-turn — `tool_call` means CC has
    // started executing the Bash tool inside the container, which only
    // happens after session.sendUserText has been called and the SDK
    // produced at least one stream event. By this point session.isBusy()
    // is guaranteed true.
    let inFlight = false
    for (let i = 0; i < 200; i++) {
      const n = await gen1.next()
      if (n.done) break
      events1.push(n.value)
      if (n.value.event === "tool_call") {
        inFlight = true
        break
      }
    }
    if (!inFlight) dumpEvents(events1)
    expect(inFlight).toBe(true)

    // Now send msg 2. Session is busy, so its SSE should open with `queued`.
    const send2 = await sendMessage(loopId, "[[q-fast]] queue me up")
    expect(send2.status).toBe(200)

    const events2: SSEEvent[] = []
    const gen2 = sseEvents(send2, { timeoutMs: 90_000 })
    const first = await gen2.next()
    if (first.done) {
      dumpEvents(events2)
      throw new Error("msg 2 stream ended before any event")
    }
    events2.push(first.value)
    if (first.value.event !== "queued") {
      dumpEvents(events2)
    }
    expect(first.value.event).toBe("queued")
    expect(typeof first.value.data.position).toBe("number")
    expect(first.value.data.position).toBeGreaterThanOrEqual(1)

    // Continue draining until done.
    while (true) {
      const n = await gen2.next()
      if (n.done) break
      events2.push(n.value)
      if (n.value.event === "done" || n.value.event === "error" || n.value.event === "interrupted") break
    }
    await gen2.return(undefined as any)

    expect(events2.some((e) => e.event === "started")).toBe(true)
    expect(events2.some((e) => e.event === "done")).toBe(true)
    expect(events2.some((e) => e.event === "error" || e.event === "interrupted")).toBe(false)
    const sawFast = events2.some(
      (e) => e.event === "assistant_delta" && JSON.stringify(e.data).includes("fast done"),
    )
    if (!sawFast) dumpEvents(events2)
    expect(sawFast).toBe(true)

    // Drain the rest of msg 1's stream — it must complete too.
    while (true) {
      const n = await gen1.next()
      if (n.done) break
      events1.push(n.value)
      if (n.value.event === "done" || n.value.event === "error" || n.value.event === "interrupted") break
    }
    await gen1.return(undefined as any)
    expect(events1.some((e) => e.event === "done")).toBe(true)
  }, 120_000)
})
