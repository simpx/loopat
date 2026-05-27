/**
 * L4 api-e2e: a single user message that triggers N sequential tool_use /
 * tool_result rounds inside one turn. Simulates the typical cc workflow:
 * "read this file, grep for X, edit one place, run tests" — all in one
 * `POST /messages` invocation.
 *
 * Validates that:
 *   - mock's per-`turnIndex` dispatch holds across many rounds in one turn
 *   - SSE emits one `tool_call` + `tool_result` pair per round
 *   - the final state on disk reflects all rounds (file written + line
 *     count matches what each step did)
 */
import { test, expect, describe } from "bun:test"
import {
  podmanAvailable,
  mock,
  blocks,
  createLoop,
  sendMessage,
  readUntilTurnEnds,
  inSandbox,
  workdirInSandbox,
  dumpEvents,
} from "./helpers"

describe.skipIf(!podmanAvailable)("api-e2e: multi-tool single turn", () => {
  test("4-round single turn: write → append → tail → cat; final file content reflects all rounds", async () => {
    const loopId = await createLoop({ title: "multi-tool" })
    const wd = workdirInSandbox(loopId)
    const file = `${wd}/mt.log`

    mock.register({
      marker: "[[mt-multi]]",
      *respond(req, turn) {
        // Each round: model emits one tool_use; CC runs it; we move to
        // the next `turn`. The fourth call is the wrap-up text.
        switch (turn) {
          case 0:
            yield blocks.text("step 1 — create file")
            yield blocks.bash(`printf 'line1\\n' > ${file}`)
            yield blocks.endTool()
            return
          case 1:
            yield blocks.text("step 2 — append")
            yield blocks.bash(`printf 'line2\\n' >> ${file}`)
            yield blocks.endTool()
            return
          case 2:
            yield blocks.text("step 3 — append again")
            yield blocks.bash(`printf 'line3\\n' >> ${file}`)
            yield blocks.endTool()
            return
          case 3:
            yield blocks.text("all 3 lines written")
            yield blocks.endTurn()
            return
          default:
            yield blocks.text("unexpected extra turn")
            yield blocks.endTurn()
        }
      },
    })

    const send = await sendMessage(loopId, "[[mt-multi]] do all the steps")
    expect(send.status).toBe(200)
    const events = await readUntilTurnEnds(send, 90_000)
    const failed = events.filter((e) => e.event === "error" || e.event === "interrupted")
    if (failed.length) dumpEvents(events)
    expect(failed).toEqual([])
    expect(events.some((e) => e.event === "done")).toBe(true)

    // SSE accounting — 3 tool_call + 3 tool_result, all in one turn (one
    // `started`, one `done`).
    const toolCalls = events.filter((e) => e.event === "tool_call")
    const toolResults = events.filter((e) => e.event === "tool_result")
    if (toolCalls.length !== 3 || toolResults.length !== 3) dumpEvents(events)
    expect(toolCalls.length).toBe(3)
    expect(toolResults.length).toBe(3)
    const started = events.filter((e) => e.event === "started")
    const done = events.filter((e) => e.event === "done")
    expect(started.length).toBe(1)
    expect(done.length).toBe(1)

    // Sandbox-side ground truth: 3 lines, in order.
    const probe = await inSandbox(loopId, `cat ${file}`)
    expect(probe.code).toBe(0)
    expect(probe.stdout).toBe("line1\nline2\nline3\n")
  }, 120_000)
})
