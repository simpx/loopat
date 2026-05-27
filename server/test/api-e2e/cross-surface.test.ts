/**
 * L4 api-e2e: bidirectional visibility between CC (via Bash tool) and the
 * sandbox probe (via podman exec). This is the test set that validates the
 * "loop = shared sandbox" invariant — what one channel writes the other
 * channel sees, including long-lived background processes.
 *
 *   T1  cc writes a file via Bash → probe reads it (mirror of file-roundtrip
 *       but explicit about the cross-surface property)
 *   T2  probe writes a file → cc reads it via Bash; SSE assistant text
 *       contains the content the probe wrote
 *   T3  cc starts an HTTP server via Bash run_in_background:true → probe
 *       `curl localhost:<port>` returns 200; the bg process really runs
 *       inside CC's tool dispatcher
 *   T4  while T3's bg server is still up, a second POST /messages on the
 *       same loop completes normally — proves loop session is not blocked
 *       by an outstanding background tool task
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
  ensureSandbox,
  sleep,
  dumpEvents,
  teardownAll,
} from "./helpers"

afterAll(teardownAll)

describe.skipIf(!podmanAvailable)("api-e2e: cross-surface", () => {
  test("cc writes a file via Bash; probe reads identical content", async () => {
    const loopId = await createLoop({ title: "xs-write-then-read" })
    mock.register({
      marker: "[[xs-write]]",
      *respond(req) {
        if (!lastIsToolResult(req)) {
          yield blocks.bash("printf cc-wrote-this > xs-w.txt")
          yield blocks.endTool()
        } else {
          yield blocks.text("written")
          yield blocks.endTurn()
        }
      },
    })
    const send = await sendMessage(loopId, "please [[xs-write]] now")
    const events = await readUntilTurnEnds(send)
    expect(events.some((e) => e.event === "error")).toBe(false)
    expect(events.some((e) => e.event === "done")).toBe(true)

    const probe = await inSandbox(loopId, `cat ${workdirInSandbox(loopId)}/xs-w.txt`)
    expect(probe.code).toBe(0)
    expect(probe.stdout).toBe("cc-wrote-this")
  }, 90_000)

  test("probe writes a file; cc reads it via Bash tool, content flows back through SSE", async () => {
    const loopId = await createLoop({ title: "xs-probe-then-cc" })
    await ensureSandbox(loopId)
    // Pre-seed the workdir from the host side.
    const preseed = await inSandbox(
      loopId,
      `mkdir -p ${workdirInSandbox(loopId)} && printf probe-seeded-content > ${workdirInSandbox(loopId)}/probe.txt`,
    )
    expect(preseed.code).toBe(0)

    mock.register({
      marker: "[[xs-read]]",
      *respond(req) {
        if (!lastIsToolResult(req)) {
          yield blocks.bash(`cat ${workdirInSandbox(loopId)}/probe.txt`)
          yield blocks.endTool()
        } else {
          yield blocks.text("File content: " + lastToolResultText(req).trim())
          yield blocks.endTurn()
        }
      },
    })

    const send = await sendMessage(loopId, "[[xs-read]] please")
    const events = await readUntilTurnEnds(send)
    const failed = events.filter((e) => e.event === "error" || e.event === "interrupted")
    if (failed.length) dumpEvents(events)
    expect(failed).toEqual([])

    const seen = events.some(
      (e) =>
        e.event === "assistant_delta" &&
        typeof e.data?.text === "string" &&
        e.data.text.includes("probe-seeded-content"),
    )
    if (!seen) dumpEvents(events)
    expect(seen).toBe(true)
  }, 90_000)

  test("cc starts a backgrounded shell loop; probe observes it ticking", async () => {
    // The sandbox image is minimal (no python/curl/nc), so use a pure-bash
    // heartbeat-file pattern instead of a TCP server. The semantics we care
    // about are identical: run_in_background launches a long-lived child
    // that keeps writing while CC moves on.
    const loopId = await createLoop({ title: "xs-bg-tick" })
    const wd = workdirInSandbox(loopId)
    mock.register({
      marker: "[[xs-tick]]",
      *respond(req) {
        if (!lastIsToolResult(req)) {
          yield blocks.bash(
            `cd ${wd} && (while true; do date +%s%N >> heartbeat.log; sleep 0.1; done)`,
            { run_in_background: true },
          )
          yield blocks.endTool()
        } else {
          yield blocks.text("bg ticker started")
          yield blocks.endTurn()
        }
      },
    })

    const send = await sendMessage(loopId, "please [[xs-tick]] now")
    const events = await readUntilTurnEnds(send, 60_000)
    const failed = events.filter((e) => e.event === "error" || e.event === "interrupted")
    if (failed.length) dumpEvents(events)
    expect(failed).toEqual([])
    expect(events.some((e) => e.event === "done")).toBe(true)

    // Observe ticking: read the line count, wait, read again, assert growth.
    let n1 = 0
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(300)
      const p = await inSandbox(loopId, `wc -l < ${wd}/heartbeat.log 2>/dev/null || echo 0`)
      n1 = parseInt(p.stdout.trim() || "0", 10)
      if (n1 > 0) break
    }
    expect(n1).toBeGreaterThan(0)
    await sleep(500)
    const p2 = await inSandbox(loopId, `wc -l < ${wd}/heartbeat.log`)
    const n2 = parseInt(p2.stdout.trim() || "0", 10)
    expect(n2).toBeGreaterThan(n1)
  }, 90_000)

  test("loop accepts another message while a background tool task is outstanding", async () => {
    const loopId = await createLoop({ title: "xs-bg-then-ping" })
    const wd = workdirInSandbox(loopId)

    mock.register({
      marker: "[[xs-start-bg]]",
      *respond(req) {
        if (!lastIsToolResult(req)) {
          yield blocks.bash(`cd ${wd} && (while true; do echo tick >> bg.log; sleep 0.2; done)`, {
            run_in_background: true,
          })
          yield blocks.endTool()
        } else {
          yield blocks.text("bg up")
          yield blocks.endTurn()
        }
      },
    })

    // Message 1 — start the background ticker.
    let send = await sendMessage(loopId, "[[xs-start-bg]] please")
    let events = await readUntilTurnEnds(send)
    expect(events.some((e) => e.event === "done")).toBe(true)
    expect(events.some((e) => e.event === "error")).toBe(false)

    // Confirm bg is actually ticking before sending the next message.
    let alive = false
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(300)
      const p = await inSandbox(loopId, `wc -l < ${wd}/bg.log 2>/dev/null || echo 0`)
      if (parseInt(p.stdout.trim() || "0", 10) > 0) {
        alive = true
        break
      }
    }
    expect(alive).toBe(true)

    // Now register a "ping" scenario AFTER xs-start-bg. LIFO: ping wins on
    // matching second message even though the conversation history still
    // contains [[xs-start-bg]].
    mock.register({
      marker: "[[xs-ping]]",
      *respond() {
        yield blocks.text("pong")
        yield blocks.endTurn()
      },
    })

    send = await sendMessage(loopId, "[[xs-ping]] are you there?")
    events = await readUntilTurnEnds(send)
    const failed = events.filter((e) => e.event === "error" || e.event === "interrupted")
    if (failed.length) dumpEvents(events)
    expect(failed).toEqual([])
    expect(events.some((e) => e.event === "done")).toBe(true)

    const sawPong = events.some(
      (e) =>
        e.event === "assistant_delta" && typeof e.data?.text === "string" && e.data.text.includes("pong"),
    )
    if (!sawPong) dumpEvents(events)
    expect(sawPong).toBe(true)
  }, 120_000)
})
