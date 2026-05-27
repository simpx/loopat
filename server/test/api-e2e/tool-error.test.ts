/**
 * L4 api-e2e: cc adapts when a tool fails with a non-zero exit.
 *
 *   T1  Mock emits Bash `false` (always exit 1). CC runs it, gets a
 *       non-zero tool_result (in CC's stream-json this surfaces as
 *       content with "Exit code 1"). Mock's second round branches on
 *       that, emits a fallback assistant text. Turn ends with done,
 *       NOT error.
 *
 * What this exercises beyond multi-turn / multi-tool: the *contents* of
 * the tool_result feedback loop — that we can observe what CC sends back
 * after a failed tool and steer the next model response accordingly.
 * Mirrors the real-world pattern: "test failed → look at the error → try
 * a different fix".
 */
import { test, expect, describe } from "bun:test"
import {
  podmanAvailable,
  mock,
  blocks,
  lastIsToolResult,
  lastToolResultText,
  createLoop,
  sendMessage,
  readUntilTurnEnds,
  dumpEvents,
} from "./helpers"

describe.skipIf(!podmanAvailable)("api-e2e: tool error → adapt", () => {
  test("Bash exit 1 → mock sees error in tool_result → emits fallback text → done", async () => {
    const loopId = await createLoop({ title: "tool-err" })

    mock.register({
      marker: "[[te-fail]]",
      *respond(req) {
        if (!lastIsToolResult(req)) {
          // `false` is the canonical exit-1 command.
          yield blocks.text("trying primary approach")
          yield blocks.bash("false")
          yield blocks.endTool()
        } else {
          const last = lastToolResultText(req)
          // CC's stream-json reports failures with something like
          // "Exit code 1" in the tool_result content. Branch on it.
          if (/Exit code|error/i.test(last)) {
            yield blocks.text("primary failed; falling back to plan B")
            yield blocks.endTurn()
          } else {
            yield blocks.text("unexpected success: " + last.slice(0, 80))
            yield blocks.endTurn()
          }
        }
      },
    })

    const send = await sendMessage(loopId, "please [[te-fail]] now")
    expect(send.status).toBe(200)
    const events = await readUntilTurnEnds(send, 60_000)

    const failed = events.filter((e) => e.event === "error" || e.event === "interrupted")
    if (failed.length) dumpEvents(events)
    expect(failed).toEqual([])
    expect(events.some((e) => e.event === "done")).toBe(true)

    // tool_result event must indicate failure
    const trFails = events.filter((e) => e.event === "tool_result" && e.data?.ok === false)
    if (trFails.length === 0) dumpEvents(events)
    expect(trFails.length).toBeGreaterThanOrEqual(1)

    // Fallback text reached the SSE consumer
    const sawFallback = events.some(
      (e) =>
        e.event === "assistant_delta" &&
        typeof e.data?.text === "string" &&
        e.data.text.includes("falling back to plan B"),
    )
    if (!sawFallback) dumpEvents(events)
    expect(sawFallback).toBe(true)
  }, 90_000)
})
