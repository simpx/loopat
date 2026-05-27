/**
 * L4 api-e2e: smoke test for the v1 loop API + sandbox + mock anthropic.
 *
 * The goal of this test (and the one most likely to surface env / wiring
 * problems): a fresh loop, one user message, scripted text-only response
 * from the mock model, expect to see a `done` event, no `error`, and
 * the assistant text somewhere in the SSE stream.
 *
 * Skipped if podman is unavailable. Network mode = host (set in podman.ts)
 * so CC inside the container reaches 127.0.0.1:<mock_port> directly.
 */
import { test, expect, describe, afterAll } from "bun:test"
import {
  podmanAvailable,
  mock,
  blocks,
  createLoop,
  sendMessage,
  readUntilTurnEnds,
  dumpEvents,
  teardownAll,
} from "./helpers"

afterAll(teardownAll)

describe.skipIf(!podmanAvailable)("api-e2e: hello", () => {
  test("text-only scenario: send 'hi' → assistant text → done, no error", async () => {
    mock.register({
      marker: "[[hello]]",
      *respond() {
        yield blocks.text("hello back from mock")
        yield blocks.endTurn()
      },
    })

    const loopId = await createLoop({ title: "hello-test" })
    const send = await sendMessage(loopId, "please [[hello]] now")
    expect(send.status).toBe(200)
    expect(send.headers.get("content-type")).toContain("text/event-stream")

    const events = await readUntilTurnEnds(send, 45_000)
    const failed = events.filter((e) => e.event === "error" || e.event === "interrupted")
    const done = events.filter((e) => e.event === "done")

    if (failed.length || !done.length) dumpEvents(events)

    expect(failed).toEqual([])
    expect(done.length).toBeGreaterThanOrEqual(1)

    const seenText = events.some((e) => JSON.stringify(e.data).includes("hello back from mock"))
    if (!seenText) dumpEvents(events)
    expect(seenText).toBe(true)

    expect(mock.hits("[[hello]]")).toBeGreaterThanOrEqual(1)
  }, 60_000)
})
