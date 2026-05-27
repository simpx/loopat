/**
 * L4 api-e2e: choice-flow — the user-pause-the-loop interactions.
 *
 *   T1  Permission allow:  user msg with permission_mode="default" forces
 *       prompts; mock asks for Bash; SSE `requires_choice kind=permission`;
 *       answer { allow:true }; loop continues; SSE `choice_resolved` + done
 *   T2  Permission deny:   same setup but answer { allow:false }; SDK
 *       turns the deny into a `tool_result is_error:true`; mock branches
 *       on that and emits a fallback text; turn ends with done (NOT
 *       interrupted) per session.ts:1243
 *   T3  AskUserQuestion:   mock emits the AskUserQuestion tool_use with a
 *       multi-option question; SSE `requires_choice kind=question`;
 *       answer { answers: { q1: "B" } }; mock's next round sees the
 *       answer in lastToolResultText and emits a confirmation text
 *
 * Per-turn `permission_mode` override is implicitly covered by T1/T2:
 * loop's default mode is bypassPermissions, so the requires_choice only
 * fires because the POST body said permission_mode="default" for that turn.
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
  sseEvents,
  answerChoice,
  dumpEvents,
  type SSEEvent,
} from "./helpers"

/**
 * Pull from the generator until `predicate(ev)` matches, or the stream
 * ends. Uses manual `next()` — NOT `for await ... break` — because in an
 * async generator, breaking out triggers `.return()` which cancels the
 * underlying SSE reader. We need to be able to come back and read more
 * from the same stream after the test does a POST.
 */
async function readUntil(
  gen: AsyncGenerator<SSEEvent>,
  predicate: (ev: SSEEvent) => boolean,
  bag: SSEEvent[],
): Promise<SSEEvent | null> {
  while (true) {
    const next = await gen.next()
    if (next.done) return null
    bag.push(next.value)
    if (predicate(next.value)) return next.value
  }
}

describe.skipIf(!podmanAvailable)("api-e2e: choice flow", () => {
  test("permission allow → choice_resolved → tool runs → done", async () => {
    const loopId = await createLoop({ title: "perm-allow" })
    mock.register({
      marker: "[[perm-allow]]",
      *respond(req) {
        if (!lastIsToolResult(req)) {
          // Bash isn't in SAFE_TOOLS, so default permission_mode prompts.
          yield blocks.bash("printf perm-allowed > perm-allow.txt")
          yield blocks.endTool()
        } else {
          yield blocks.text("did it")
          yield blocks.endTurn()
        }
      },
    })

    const send = await sendMessage(loopId, "please [[perm-allow]] write", {
      permission_mode: "default",
    })
    expect(send.status).toBe(200)

    const events: SSEEvent[] = []
    const gen = sseEvents(send, { timeoutMs: 60_000 })

    const reqChoice = await readUntil(gen, (ev) => ev.event === "requires_choice", events)
    if (!reqChoice) dumpEvents(events)
    expect(reqChoice).not.toBeNull()
    expect(reqChoice!.data.kind).toBe("permission")
    expect(reqChoice!.data.choice_id).toMatch(/^choice_/)

    const ans = await answerChoice(loopId, reqChoice!.data.choice_id, { allow: true })
    expect(ans.status).toBe(202)

    const endEv = await readUntil(
      gen,
      (ev) => ev.event === "done" || ev.event === "error",
      events,
    )
    await gen.return(undefined as any)
    if (!endEv || endEv.event !== "done") dumpEvents(events)
    expect(endEv?.event).toBe("done")
    expect(events.some((e) => e.event === "choice_resolved")).toBe(true)
  }, 90_000)

  test("permission deny → tool_result is_error → mock falls back → done (no interrupted)", async () => {
    const loopId = await createLoop({ title: "perm-deny" })
    mock.register({
      marker: "[[perm-deny]]",
      *respond(req) {
        if (!lastIsToolResult(req)) {
          yield blocks.bash("touch should-not-exist.txt")
          yield blocks.endTool()
        } else {
          // Branch on what came back from the SDK after deny.
          const last = lastToolResultText(req)
          if (/User denied permission/.test(last)) {
            yield blocks.text("user-denied-fallback")
            yield blocks.endTurn()
          } else {
            yield blocks.text("unexpected: " + last.slice(0, 80))
            yield blocks.endTurn()
          }
        }
      },
    })

    const send = await sendMessage(loopId, "please [[perm-deny]] write", {
      permission_mode: "default",
    })
    expect(send.status).toBe(200)

    const events: SSEEvent[] = []
    const gen = sseEvents(send, { timeoutMs: 60_000 })

    const reqChoice = await readUntil(gen, (ev) => ev.event === "requires_choice", events)
    expect(reqChoice).not.toBeNull()
    expect(reqChoice!.data.kind).toBe("permission")

    const ans = await answerChoice(loopId, reqChoice!.data.choice_id, { allow: false })
    expect(ans.status).toBe(202)

    const endEv = await readUntil(
      gen,
      (ev) => ev.event === "done" || ev.event === "error" || ev.event === "interrupted",
      events,
    )
    await gen.return(undefined as any)
    if (!endEv || endEv.event !== "done") dumpEvents(events)
    // Spec semantics confirmed via session.ts:1243: deny is a tool error,
    // turn does NOT become `interrupted`.
    expect(endEv?.event).toBe("done")

    // mock must have seen the deny in tool_result, branched to fallback
    const seenFallback = events.some(
      (e) => e.event === "assistant_delta" && JSON.stringify(e.data).includes("user-denied-fallback"),
    )
    if (!seenFallback) dumpEvents(events)
    expect(seenFallback).toBe(true)
  }, 90_000)

  test("AskUserQuestion → answer → mock confirms choice in next assistant text", async () => {
    const loopId = await createLoop({ title: "question-flow" })
    mock.register({
      marker: "[[q-flow]]",
      *respond(req) {
        if (!lastIsToolResult(req)) {
          // AskUserQuestion is caught by session.ts:520 BEFORE the
          // SAFE_TOOLS / permission_mode branches, so it always prompts.
          yield blocks.toolUse("AskUserQuestion", {
            questions: [
              {
                question: "Which option?",
                header: "Pick",
                multiSelect: false,
                options: [
                  { label: "Alpha", description: "first" },
                  { label: "Bravo", description: "second" },
                ],
              },
            ],
          })
          yield blocks.endTool()
        } else {
          const last = lastToolResultText(req)
          // The tool_result carries the answers map session.ts wrote back
          // into updatedInput; we just look for the picked label.
          if (last.includes("Bravo")) {
            yield blocks.text("user picked Bravo")
          } else if (last.includes("Alpha")) {
            yield blocks.text("user picked Alpha")
          } else {
            yield blocks.text("unexpected answer: " + last.slice(0, 80))
          }
          yield blocks.endTurn()
        }
      },
    })

    const send = await sendMessage(loopId, "please [[q-flow]] ask me")
    expect(send.status).toBe(200)

    const events: SSEEvent[] = []
    const gen = sseEvents(send, { timeoutMs: 60_000 })

    const reqChoice = await readUntil(gen, (ev) => ev.event === "requires_choice", events)
    expect(reqChoice).not.toBeNull()
    expect(reqChoice!.data.kind).toBe("question")
    const questions = reqChoice!.data.payload.questions
    expect(Array.isArray(questions)).toBe(true)
    expect(questions.length).toBeGreaterThan(0)

    // Answer it. The API spec is `{ answers: { <question_id>: <value> } }`.
    // AskUserQuestion doesn't always carry a stable q-id; use whatever the
    // payload provided, fall back to index-keyed.
    const qId = questions[0].id ?? questions[0].question ?? "q0"
    const ans = await answerChoice(loopId, reqChoice!.data.choice_id, {
      answers: { [qId]: "Bravo" },
    })
    expect(ans.status).toBe(202)

    const endEv = await readUntil(
      gen,
      (ev) => ev.event === "done" || ev.event === "error",
      events,
    )
    await gen.return(undefined as any)
    if (!endEv || endEv.event !== "done") dumpEvents(events)
    expect(endEv?.event).toBe("done")

    const sawBravo = events.some(
      (e) => e.event === "assistant_delta" && JSON.stringify(e.data).includes("user picked Bravo"),
    )
    if (!sawBravo) dumpEvents(events)
    expect(sawBravo).toBe(true)
  }, 90_000)
})
