/**
 * L4 api-e2e: file roundtrip via Bash tool_use.
 *
 *   - cc creates a file via Bash → sandbox probe reads it back
 *   - across two POST /messages: turn 1 creates file, turn 2 lists files;
 *     turn 2's tool_result demonstrably contains the file from turn 1
 *
 * These are the cases that prove CC's real tool dispatch is wired through:
 * the mock just *says* "use Bash with this command"; the actual side-effect
 * comes from CC executing that Bash inside the podman container.
 */
import { test, expect, describe, afterAll } from "bun:test"
import {
  podmanAvailable,
  mock,
  blocks,
  lastIsToolResult,
  lastToolResultText,
  createLoop,
  sendMessage,
  readUntilTurnEnds,
  inSandbox,
  workdirInSandbox,
  dumpEvents,
  teardownAll,
} from "./helpers"

afterAll(teardownAll)

describe.skipIf(!podmanAvailable)("api-e2e: file roundtrip", () => {
  test("cc creates a file via Bash; sandbox probe sees it", async () => {
    const loopId = await createLoop({ title: "file-create" })

    mock.register({
      marker: "[[create-foo]]",
      *respond(req) {
        if (!lastIsToolResult(req)) {
          yield blocks.text("Creating foo.txt.")
          // cwd is workdir already (V_LOOP_WORKDIR), relative path is fine
          yield blocks.bash("printf 'hello-from-cc' > foo.txt")
          yield blocks.endTool()
        } else {
          yield blocks.text("Created.")
          yield blocks.endTurn()
        }
      },
    })

    const send = await sendMessage(loopId, "please [[create-foo]] in the workdir")
    expect(send.status).toBe(200)
    const events = await readUntilTurnEnds(send, 60_000)
    const failed = events.filter((e) => e.event === "error" || e.event === "interrupted")
    if (failed.length) dumpEvents(events)
    expect(failed).toEqual([])
    expect(events.some((e) => e.event === "done")).toBe(true)

    // Sandbox probe — bypass everything, look directly at what's in the
    // container's workdir. This is what makes the test "really e2e":
    // CC's Bash tool ran inside the container, the file is real.
    const probe = await inSandbox(loopId, `cat ${workdirInSandbox(loopId)}/foo.txt`)
    expect(probe.code).toBe(0)
    expect(probe.stdout).toBe("hello-from-cc")
  }, 90_000)

  test("multi-message: create file in msg 1, list files in msg 2; second response includes the file", async () => {
    const loopId = await createLoop({ title: "file-roundtrip" })

    // First scenario — create a uniquely-named file. Marker is unique to
    // this test so it doesn't cross-fire with other tests.
    mock.register({
      marker: "[[mt-create]]",
      *respond(req) {
        if (!lastIsToolResult(req)) {
          yield blocks.bash("touch mt-marker.txt && echo done > mt-marker.txt")
          yield blocks.endTool()
        } else {
          yield blocks.text("File created.")
          yield blocks.endTurn()
        }
      },
    })

    let send = await sendMessage(loopId, "please [[mt-create]]")
    expect(send.status).toBe(200)
    let events = await readUntilTurnEnds(send, 60_000)
    expect(events.some((e) => e.event === "done")).toBe(true)
    expect(events.some((e) => e.event === "error")).toBe(false)

    // Now register the list scenario. LIFO means this scenario will match
    // first when [[mt-list]] is in the conversation.
    mock.register({
      marker: "[[mt-list]]",
      *respond(req) {
        if (!lastIsToolResult(req)) {
          yield blocks.bash("ls " + workdirInSandbox(loopId))
          yield blocks.endTool()
        } else {
          // Echo the tool result text back so the SSE consumer can assert
          // on the file name appearing in assistant_delta output.
          const listing = lastToolResultText(req)
          yield blocks.text("Files: " + listing.trim())
          yield blocks.endTurn()
        }
      },
    })

    send = await sendMessage(loopId, "please [[mt-list]] now")
    expect(send.status).toBe(200)
    events = await readUntilTurnEnds(send, 60_000)
    const failed = events.filter((e) => e.event === "error" || e.event === "interrupted")
    if (failed.length) dumpEvents(events)
    expect(failed).toEqual([])
    expect(events.some((e) => e.event === "done")).toBe(true)

    // The assistant_delta stream must contain the file name from msg 1.
    const seen = events.some(
      (e) => e.event === "assistant_delta" && typeof e.data?.text === "string" && e.data.text.includes("mt-marker.txt"),
    )
    if (!seen) dumpEvents(events)
    expect(seen).toBe(true)
  }, 120_000)
})
