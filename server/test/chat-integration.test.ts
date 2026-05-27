/**
 * L4 chat-integration: drives the full chat pipeline end-to-end via the
 * v1 API surface (POST /api/v1/loops/:id/messages → SSE) with a mock
 * claude binary, so we exercise the real session.ts + podman exec stack
 * WITHOUT burning real API credits.
 *
 * This test exists specifically to catch the class of bugs that slipped
 * past the unit tests during the bwrap→podman migration:
 *
 *   - hash-drift between term/session ensureContainer calls
 *     → caused recreate → PTY/SDK SIGKILL (code 137)
 *   - missing `-i` on `podman exec` for SDK
 *     → claude received EOF on stdin and exited with code 0, no output
 *     → "chat sends but never responds" symptom
 *   - SDK post-result SIGTERM/SIGKILL cleanup propagating as exit 137
 *     → spurious error event after a successful turn
 *
 * Any of those would manifest here as either: no `assistant` event ever
 * arrives, or an `error` event arrives, or the SSE stream never reaches
 * `done`. All three assertions below fail in those cases.
 *
 * Skipped automatically if `podman` is not installed.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdir, rm, writeFile, chmod } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const MOCK_CLAUDE = join(HERE, "fixtures", "mock-claude.sh")

// ── Set env BEFORE any src/ import (paths.ts captures LOOPAT_HOME at load) ──
// Use ??= so we don't clobber an LOOPAT_HOME another test set first; in the
// full-suite case paths.ts is already locked to whichever value won.
process.env.LOOPAT_HOME ??= `/tmp/loopat-chat-int-${process.pid}`
process.env.PORT ??= "0"
process.env.LOOPAT_SERVE_PORT ??= "0"
// Point the SDK at the mock claude script. The path lives under the loopat
// install dir (which is bind-mounted into the container at the same host-abs
// path) so it resolves inside the sandbox.
process.env.LOOPAT_CLAUDE_BIN = MOCK_CLAUDE

const TEST_HOME = process.env.LOOPAT_HOME!
const USER = "alice"
const PASSWORD = "test123"

await rm(TEST_HOME, { recursive: true, force: true })
await mkdir(TEST_HOME, { recursive: true })
// Minimal workspace config: a fake provider so session.ts has something to
// resolve. The mock claude doesn't actually call any API, but session.ts
// still requires a provider with a non-empty apiKey.
await writeFile(join(TEST_HOME, "config.json"), JSON.stringify({
  knowledge: { git: "" },
  notes: { git: "" },
  repos: [],
  default: "mock",
  providers: {
    mock: {
      baseUrl: "https://mock.invalid",
      apiKey: "sk-mock-test",
      models: [{ id: "mock-model", enabled: true }],
    },
  },
}))
// Ensure the mock binary still exists + is executable (chmod survives git
// per .gitignore? — re-chmod just in case CI clones strip the +x bit).
if (!existsSync(MOCK_CLAUDE)) {
  throw new Error(`mock claude script missing at ${MOCK_CLAUDE}`)
}
await chmod(MOCK_CLAUDE, 0o755)

// Now safe to import the app + dependencies.
const { app } = await import("../src/index")
const { createUser, createSession, COOKIE_NAME } = await import("../src/auth")
const { probePodman } = await import("../src/podman")

const podmanAvailable = (await probePodman()).ok

let SESSION = ""

beforeAll(async () => {
  // Idempotent across full-suite runs where LOOPAT_HOME is shared.
  try {
    await createUser({ id: USER, password: PASSWORD, role: "admin", status: "active" })
  } catch (e: any) {
    if (!/username taken/.test(e?.message ?? "")) throw e
  }
  SESSION = createSession(USER)
  // ensureContainer binds personal/<user>/ — needs to exist on disk before
  // podman create.
  const { personalLoopatDir } = await import("../src/paths")
  await mkdir(join(personalLoopatDir(USER), "vaults", "default"), { recursive: true })
  if (!existsSync(join(personalLoopatDir(USER), "config.json"))) {
    await writeFile(join(personalLoopatDir(USER), "config.json"), "{}")
  }
})

afterAll(async () => {
  // Use podman unshare to clean any subuid-owned files inside the LOOPAT_HOME.
  if (podmanAvailable) {
    const { stopAllWorkspaceContainers, removeContainer } = await import("../src/podman")
    await stopAllWorkspaceContainers().catch(() => {})
    // Best-effort: rm via podman unshare so subuid-owned cruft inside any
    // home-upper layer doesn't block cleanup. If unshare isn't usable in this
    // env (e.g. nested userns), fall through to plain rm.
    try {
      const { spawnSync } = await import("node:child_process")
      spawnSync("podman", ["unshare", "rm", "-rf", TEST_HOME], { stdio: "ignore" })
    } catch {}
  }
  await rm(TEST_HOME, { recursive: true, force: true }).catch(() => {})
})

function cookieHeader(sess: string): Record<string, string> {
  return { Cookie: `${COOKIE_NAME}=${sess}` }
}

type SSEEvent = { event: string; data: any }

/** Parse a single SSE response body stream into an array of events. */
async function readSSE(r: Response, maxMs: number, until: (ev: SSEEvent) => boolean): Promise<SSEEvent[]> {
  const events: SSEEvent[] = []
  const reader = r.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined, done: true }>((res) =>
        setTimeout(() => res({ value: undefined, done: true } as any), remaining),
      ),
    ])
    if (done) break
    buf += decoder.decode(value, { stream: true })
    // SSE frames are separated by blank line. Parse each complete frame.
    let idx: number
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      let ev = ""
      let data = ""
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) ev = line.slice(6).trim()
        else if (line.startsWith("data:")) data += line.slice(5).trim()
      }
      if (!ev) continue
      let parsed: any = data
      try { parsed = JSON.parse(data) } catch {}
      const sse = { event: ev, data: parsed }
      events.push(sse)
      if (until(sse)) return events
    }
  }
  return events
}

describe.skipIf(!podmanAvailable)("chat integration — POST /api/v1/loops/:id/messages SSE", () => {
  test("full turn: send 'hi' → init → assistant text → done; no error event", async () => {
    // Create loop via API.
    const createR = await app.request("/api/v1/loops", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION) },
      body: JSON.stringify({ title: "chat int test" }),
    })
    expect(createR.status).toBe(201)
    const loop = await createR.json() as { id: string }
    expect(loop.id).toMatch(/^loop_/)

    // POST /messages — returns SSE stream of events from the SDK pipeline.
    const sendR = await app.request(`/api/v1/loops/${loop.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "text/event-stream",
        ...cookieHeader(SESSION),
      },
      body: JSON.stringify({ content: "hi" }),
    })
    expect(sendR.status).toBe(200)
    expect(sendR.headers.get("content-type")).toContain("text/event-stream")

    // Read until we see `done` or `error`, or 30s timeout.
    const events = await readSSE(sendR, 30_000, (ev) =>
      ev.event === "done" || ev.event === "error" || ev.event === "interrupted",
    )
    // Debug aid when this test fails — print every event we got. Bun's test
    // runner buffers these and surfaces them on failure.
    if (events.filter((e) => e.event === "done").length === 0) {
      console.error("=== events captured (no done) ===")
      for (const e of events) {
        console.error(`  ${e.event}: ${JSON.stringify(e.data).slice(0, 200)}`)
      }
    }

    // What we expect, in any order:
    //   - at least one assistant-text event (raw SDK pass-through OR mapped)
    //   - a `done` event signaling clean completion
    // What we DO NOT want:
    //   - any `error` event (would indicate session failure)
    //   - missing `assistant` (would indicate "no response" — i.e. the
    //     missing-`-i` bug)

    const errorEvents = events.filter((e) => e.event === "error")
    expect(errorEvents).toEqual([])

    const doneEvents = events.filter((e) => e.event === "done")
    expect(doneEvents.length).toBeGreaterThanOrEqual(1)

    // Look for our mock's assistant text in any of the events. The v1 mapping
    // may surface it via different event names (e.g. "assistant_text",
    // "message", or raw passthrough). Just search the JSON.
    const seenMockText = events.some((e) =>
      JSON.stringify(e.data).includes("mock-response-OK"),
    )
    expect(seenMockText).toBe(true)
  }, 45_000)
})
