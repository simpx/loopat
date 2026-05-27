/**
 * L4 api-e2e: v1 API edge behaviors that touch SSE/state but aren't
 * covered by the unit suite (api-v1.test.ts) because they need a real
 * SDK pipeline.
 *
 *   T1  POST /interrupt mid-tool → SSE stream ends with `interrupted`
 *   T2  DELETE archives → next POST /messages returns 400 loop_archived
 *   T3  GET /events viewer running parallel to POST /messages → both
 *       streams observe assistant_delta from the same turn
 *   T4  Idempotency replay: 2nd POST with same Idempotency-Key returns the
 *       buffered events; mock API is NOT invoked a second time for that turn
 */
import { test, expect, describe, afterAll } from "bun:test"
import {
  podmanAvailable,
  mock,
  blocks,
  lastIsToolResult,
  createLoop,
  sendMessage,
  readSSE,
  readUntilTurnEnds,
  interrupt,
  archive,
  eventsStream,
  dumpEvents,
  teardownAll,
} from "./helpers"

afterAll(teardownAll)

describe.skipIf(!podmanAvailable)("api-e2e: v1 edges", () => {
  test("POST /interrupt mid-tool emits an `interrupted` SSE event", async () => {
    const loopId = await createLoop({ title: "edge-interrupt" })

    mock.register({
      marker: "[[edge-interrupt]]",
      *respond(req) {
        if (!lastIsToolResult(req)) {
          // Long-running Bash; the test will interrupt during this.
          yield blocks.bash("sleep 15")
          yield blocks.endTool()
        } else {
          yield blocks.text("recovered (should not be reached)")
          yield blocks.endTurn()
        }
      },
    })

    const send = await sendMessage(loopId, "please [[edge-interrupt]] (slow)")
    expect(send.status).toBe(200)

    // Drive the SSE reader and the interrupt POST concurrently. The reader
    // races against a deadline; we POST /interrupt as soon as we see
    // `tool_call` (proves we interrupted *during* the bash).
    const eventsPromise = readSSE(send, {
      until: (ev) => ev.event === "done" || ev.event === "error" || ev.event === "interrupted",
      timeoutMs: 30_000,
    })

    // Wait for the tool to actually start, then trigger interrupt.
    // Tiny polling loop watching mock.requests as a proxy for "CC connected".
    let sentInterrupt = false
    for (let attempt = 0; attempt < 50; attempt++) {
      if (mock.hits("[[edge-interrupt]]") >= 1) {
        // Give CC ~250ms to fire the Bash + start sleeping.
        await new Promise((r) => setTimeout(r, 300))
        await interrupt(loopId)
        sentInterrupt = true
        break
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(sentInterrupt).toBe(true)

    const events = await eventsPromise
    const seenInterrupted = events.some((e) => e.event === "interrupted")
    if (!seenInterrupted) dumpEvents(events)
    expect(seenInterrupted).toBe(true)
  }, 60_000)

  test("after DELETE, POST /messages returns 400 loop_archived", async () => {
    const loopId = await createLoop({ title: "edge-archive" })
    const del = await archive(loopId)
    expect(del.status).toBe(204)

    const send = await sendMessage(loopId, "won't matter")
    expect(send.status).toBe(400)
    const body = (await send.json()) as { error: { code: string } }
    expect(body.error.code).toBe("loop_archived")
  }, 30_000)

  test("GET /events viewer sees the same assistant_delta as POST /messages", async () => {
    const loopId = await createLoop({ title: "edge-viewer" })

    mock.register({
      marker: "[[edge-viewer]]",
      *respond() {
        yield blocks.text("viewer-watch-this-text")
        yield blocks.endTurn()
      },
    })

    // Open the read-only viewer FIRST — server will hold it open and
    // forward events as the turn fires.
    const viewerResp = await eventsStream(loopId)
    expect(viewerResp.status).toBe(200)

    const viewerEventsPromise = readSSE(viewerResp, {
      until: (ev) => ev.event === "done" || ev.event === "error",
      timeoutMs: 60_000,
    })

    // Drive the turn.
    const send = await sendMessage(loopId, "please [[edge-viewer]] now")
    const sendEvents = await readUntilTurnEnds(send, 60_000)
    const viewerEvents = await viewerEventsPromise

    const seenInSend = sendEvents.some(
      (e) => e.event === "assistant_delta" && JSON.stringify(e.data).includes("viewer-watch-this-text"),
    )
    const seenInViewer = viewerEvents.some(
      (e) => e.event === "assistant_delta" && JSON.stringify(e.data).includes("viewer-watch-this-text"),
    )
    if (!seenInSend) {
      console.error("send events:")
      dumpEvents(sendEvents)
    }
    if (!seenInViewer) {
      console.error("viewer events:")
      dumpEvents(viewerEvents)
    }
    expect(seenInSend).toBe(true)
    expect(seenInViewer).toBe(true)
  }, 90_000)

  test("Idempotency-Key replay: second POST replays events, mock NOT invoked twice", async () => {
    const loopId = await createLoop({ title: "edge-idem" })
    const key = `idem-${Date.now()}`

    mock.register({
      marker: "[[edge-idem]]",
      *respond() {
        yield blocks.text("idem-result-text")
        yield blocks.endTurn()
      },
    })

    // First send completes a turn.
    const first = await sendMessage(loopId, "please [[edge-idem]] once", { idempotencyKey: key })
    const firstEvents = await readUntilTurnEnds(first, 60_000)
    expect(firstEvents.some((e) => e.event === "done")).toBe(true)
    const hitsAfterFirst = mock.hits("[[edge-idem]]")
    expect(hitsAfterFirst).toBeGreaterThan(0)

    // Second send with SAME key + body — server should replay the buffered
    // events without calling the model again.
    const second = await sendMessage(loopId, "please [[edge-idem]] once", { idempotencyKey: key })
    expect(second.status).toBe(200)
    const secondEvents = await readUntilTurnEnds(second, 60_000)
    expect(secondEvents.some((e) => e.event === "done")).toBe(true)
    const sawText = secondEvents.some(
      (e) => e.event === "assistant_delta" && JSON.stringify(e.data).includes("idem-result-text"),
    )
    if (!sawText) dumpEvents(secondEvents)
    expect(sawText).toBe(true)

    // Critically: mock was not called a second time.
    const hitsAfterSecond = mock.hits("[[edge-idem]]")
    expect(hitsAfterSecond).toBe(hitsAfterFirst)
  }, 90_000)
})
