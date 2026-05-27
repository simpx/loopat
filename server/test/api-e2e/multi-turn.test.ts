/**
 * L4 api-e2e: three messages, three model "rewrites" of the same file —
 * v1 = bare function, v2 = +type hints, v3 = +docstring. The final
 * on-disk file must show evidence of all three iterations. Validates
 * that:
 *   - loop session state persists across POST /messages
 *   - CC's Write tool faithfully reflects each scripted content
 *   - LIFO scenario registration handles the "growing conversation" case
 *     (later markers shadow earlier ones)
 */
import { test, expect, describe, afterAll } from "bun:test"
import {
  podmanAvailable,
  mock,
  blocks,
  lastIsToolResult,
  createLoop,
  sendMessage,
  readUntilTurnEnds,
  inSandbox,
  workdirInSandbox,
  dumpEvents,
  teardownAll,
} from "./helpers"

afterAll(teardownAll)

describe.skipIf(!podmanAvailable)("api-e2e: multi-turn", () => {
  test("three messages iteratively rewrite add.py: bare → +hints → +docstring", async () => {
    const loopId = await createLoop({ title: "mt-iter" })
    const wd = workdirInSandbox(loopId)
    const target = `${wd}/add.py`

    const v1 = "def add(a, b):\n    return a + b\n"
    const v2 = "def add(a: int, b: int) -> int:\n    return a + b\n"
    const v3 =
      'def add(a: int, b: int) -> int:\n    """Return the sum of two ints."""\n    return a + b\n'

    // Each scenario writes its version then yields a final text. The
    // tool_use is the SDK-driven Write tool, which CC dispatches to the
    // real `Write` handler — file appears for real in the workdir.
    const writer = (content: string, summary: string) =>
      function* (req: any) {
        if (!lastIsToolResult(req)) {
          yield blocks.write(target, content)
          yield blocks.endTool()
        } else {
          yield blocks.text(summary)
          yield blocks.endTurn()
        }
      }

    mock.register({ marker: "[[mt-v1]]", respond: writer(v1, "v1 written") })
    let send = await sendMessage(loopId, "please [[mt-v1]] write the function")
    let events = await readUntilTurnEnds(send, 60_000)
    if (events.some((e) => e.event === "error")) dumpEvents(events)
    expect(events.some((e) => e.event === "error")).toBe(false)
    expect(events.some((e) => e.event === "done")).toBe(true)

    let probe = await inSandbox(loopId, `cat ${target}`)
    expect(probe.stdout).toBe(v1)

    mock.register({ marker: "[[mt-v2]]", respond: writer(v2, "v2 written") })
    send = await sendMessage(loopId, "please [[mt-v2]] add type hints")
    events = await readUntilTurnEnds(send, 60_000)
    if (events.some((e) => e.event === "error")) dumpEvents(events)
    expect(events.some((e) => e.event === "error")).toBe(false)
    expect(events.some((e) => e.event === "done")).toBe(true)

    probe = await inSandbox(loopId, `cat ${target}`)
    expect(probe.stdout).toBe(v2)
    expect(probe.stdout).toContain("a: int")

    mock.register({ marker: "[[mt-v3]]", respond: writer(v3, "v3 written") })
    send = await sendMessage(loopId, "please [[mt-v3]] add a docstring")
    events = await readUntilTurnEnds(send, 60_000)
    if (events.some((e) => e.event === "error")) dumpEvents(events)
    expect(events.some((e) => e.event === "error")).toBe(false)
    expect(events.some((e) => e.event === "done")).toBe(true)

    probe = await inSandbox(loopId, `cat ${target}`)
    expect(probe.stdout).toBe(v3)
    expect(probe.stdout).toContain('"""')
    expect(probe.stdout).toContain("a: int")
  }, 240_000)
})
