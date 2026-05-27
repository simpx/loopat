/**
 * api-e2e test helpers — shared fixture state.
 *
 * Import order matters: this module sets process.env (LOOPAT_HOME, ports,
 * provider config) at top-level BEFORE the first import of `../../src/index`,
 * because paths.ts captures LOOPAT_HOME at module load. All test files
 * import from here, and bun:test runs them in one process (verified), so
 * the env setup + mock-anthropic server + test user are shared across files.
 *
 * Per-test isolation is at the loop level: each test calls createLoop()
 * to get a fresh loopId → fresh container → fresh workdir.
 */
import { mkdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { join } from "node:path"
import {
  startMockServer,
  type Scenario,
  type MockServer,
  type AnthropicRequest,
  blocks as mockBlocks,
  lastIsToolResult as mockLastIsToolResult,
  lastToolResultText as mockLastToolResultText,
} from "./mock-anthropic"

const execFileP = promisify(execFile)

// ── env setup (runs once on first import) ────────────────────────────────
//
// Bun's default `bun test` glob picks up every file under `test/`, so when
// the api-e2e suite runs alongside other test files (chat-integration,
// api-v1, ...), we inherit whatever env vars they set. Specifically:
//   - LOOPAT_HOME: already pinned by paths.ts on first load — we cannot
//     change it, so we adopt the existing value and write our config.json
//     on top.
//   - LOOPAT_CLAUDE_BIN: chat-integration.test.ts sets this to a bash mock.
//     For api-e2e we need the *real* claude binary (which actually talks to
//     our mock anthropic API), so unset it before src/ imports.

delete process.env.LOOPAT_CLAUDE_BIN
process.env.LOOPAT_HOME ??= `/tmp/loopat-api-e2e-${process.pid}`
process.env.PORT ??= "0"
process.env.LOOPAT_SERVE_PORT ??= "0"
// Idle stop fast-ish so a hung background process from a failing test gets
// reaped, but not so fast it shuts down between two messages of one test.
// The process-exit hook stops all workspace containers as a backstop.
process.env.LOOPAT_CONTAINER_IDLE_MS ??= "60000"

const TEST_HOME = process.env.LOOPAT_HOME!
export const USER = "alice"
export const PASSWORD = "test123"

// Start mock anthropic server (random free port).
export const mockServer: MockServer = await startMockServer()

// Wipe + rebuild LOOPAT_HOME. (Idempotent across test files: re-imports
// short-circuit at the top-level guard.)
await rm(TEST_HOME, { recursive: true, force: true }).catch(() => {})
await mkdir(TEST_HOME, { recursive: true })
await writeFile(
  join(TEST_HOME, "config.json"),
  JSON.stringify({
    knowledge: { git: "" },
    notes: { git: "" },
    repos: [],
    default: "mock",
    providers: {
      mock: {
        baseUrl: mockServer.url,
        apiKey: "sk-mock-test",
        models: [{ id: "claude-mock", enabled: true }],
      },
    },
  }),
)

// Now safe to import the app.
const { app } = await import("../../src/index")
const { createUser, createSession, COOKIE_NAME } = await import("../../src/auth")
const { probePodman, containerName, ensureContainer, stopAllWorkspaceContainers } = await import("../../src/podman")
const { getLoop } = await import("../../src/loops")

// Earlier test files (chat-integration, multi-vault, etc.) may have left
// stopped-but-not-removed containers behind. Each container holds a
// session keyring entry, and `kernel.keys.maxkeys` is ~200 on stock
// Linux — once we cross that threshold, every new `podman create` fails
// with "unable to join session keyring: disk quota exceeded". Wipe the
// slate at first api-e2e import; we own this workspace from here on.
if ((await probePodman()).ok) {
  try {
    const { spawnSync } = await import("node:child_process")
    const list = spawnSync(
      "podman",
      ["ps", "--all", "--quiet", "--filter", "label=loopat.workspace"],
      { encoding: "utf8" },
    )
    const ids = (list.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean)
    if (ids.length > 0) {
      spawnSync("podman", ["rm", "--force", ...ids], { stdio: "ignore" })
    }
  } catch {}
}
const { personalLoopatDir } = await import("../../src/paths")

// Set up per-user dirs the SDK driver expects on first ensureContainer.
await mkdir(join(personalLoopatDir(USER), "vaults", "default"), { recursive: true })
if (!existsSync(join(personalLoopatDir(USER), "config.json"))) {
  await writeFile(join(personalLoopatDir(USER), "config.json"), "{}")
}

// Register test user (idempotent across reruns inside same LOOPAT_HOME).
try {
  await createUser({ id: USER, password: PASSWORD, role: "admin", status: "active" })
} catch (e: any) {
  if (!/username taken/.test(e?.message ?? "")) throw e
}
export const SESSION = createSession(USER)
const COOKIE_HDR = { Cookie: `${COOKIE_NAME}=${SESSION}` }

// Probe podman once at load — tests skipIf this is false.
export const podmanAvailable = (await probePodman()).ok

// Re-export scenario block helpers for terse test authoring.
export const blocks = mockBlocks
export const mock = mockServer
export const lastIsToolResult = mockLastIsToolResult
export const lastToolResultText = mockLastToolResultText
export type { Scenario, AnthropicRequest } from "./mock-anthropic"

// ── auth'd request helper ────────────────────────────────────────────────

export function authedRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...(init.headers ?? {}), ...COOKIE_HDR }
  return app.request(path, { ...init, headers })
}

// ── v1 API fixtures ──────────────────────────────────────────────────────

export async function createLoop(opts: { title?: string } = {}): Promise<string> {
  const r = await authedRequest("/api/v1/loops", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: opts.title ?? "api-e2e" }),
  })
  if (r.status !== 201) {
    throw new Error(`createLoop expected 201, got ${r.status}: ${await r.text()}`)
  }
  const { id } = (await r.json()) as { id: string }
  return id
}

export type SSEEvent = { event: string; data: any }

export async function sendMessage(
  loopId: string,
  content: string,
  opts: { idempotencyKey?: string; permission_mode?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
  }
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey
  const body: Record<string, unknown> = { content }
  if (opts.permission_mode) body.permission_mode = opts.permission_mode
  return authedRequest(`/api/v1/loops/${loopId}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

export async function interrupt(loopId: string): Promise<Response> {
  return authedRequest(`/api/v1/loops/${loopId}/interrupt`, { method: "POST" })
}

export async function archive(loopId: string): Promise<Response> {
  return authedRequest(`/api/v1/loops/${loopId}`, { method: "DELETE" })
}

export function eventsStream(loopId: string): Promise<Response> {
  return authedRequest(`/api/v1/loops/${loopId}/events`, {
    headers: { accept: "text/event-stream" },
  })
}

/**
 * Async generator over SSE events from a Response.body stream. Caller
 * controls when to stop (a `break` in `for await` releases the underlying
 * reader). Multi-phase tests (read → POST a choice answer → read more)
 * use this directly; single-shot tests use `readSSE` / `readUntilTurnEnds`.
 */
export async function* sseEvents(
  r: Response,
  opts: { timeoutMs?: number } = {},
): AsyncGenerator<SSEEvent> {
  const reader = r.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000)
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      const next = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((res) =>
          setTimeout(() => res({ value: undefined, done: true } as any), remaining),
        ),
      ])
      if (next.done) return
      buf += decoder.decode(next.value, { stream: true })
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
        try {
          parsed = JSON.parse(data)
        } catch {}
        yield { event: ev, data: parsed }
      }
    }
  } finally {
    try {
      reader.cancel()
    } catch {}
  }
}

/**
 * Eagerly drain SSE until `until(ev) === true` or timeout, then close.
 * For tests that need to react mid-stream, use `sseEvents` directly.
 */
export async function readSSE(
  r: Response,
  opts: { until: (ev: SSEEvent) => boolean; timeoutMs?: number },
): Promise<SSEEvent[]> {
  const events: SSEEvent[] = []
  const gen = sseEvents(r, { timeoutMs: opts.timeoutMs ?? 30_000 })
  for await (const ev of gen) {
    events.push(ev)
    if (opts.until(ev)) break
  }
  return events
}

/** Convenience: read until done/error/interrupted. */
export function readUntilTurnEnds(r: Response, timeoutMs = 60_000): Promise<SSEEvent[]> {
  return readSSE(r, {
    until: (ev) => ev.event === "done" || ev.event === "error" || ev.event === "interrupted",
    timeoutMs,
  })
}

/** POST /api/v1/loops/:id/choices/:choiceId — answer a permission or
 * question choice. `body` is either `{ allow: boolean }` (permission)
 * or `{ answers: Record<string, string> }` (question). */
export async function answerChoice(
  loopId: string,
  choiceId: string,
  body: { allow: boolean } | { answers: Record<string, string> },
): Promise<Response> {
  return authedRequest(`/api/v1/loops/${loopId}/choices/${choiceId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/** Print a captured event list to stderr — invoke when an assertion fails. */
export function dumpEvents(events: SSEEvent[]): void {
  console.error("=== SSE events ===")
  for (const e of events) {
    const s = JSON.stringify(e.data)
    console.error(`  ${e.event}: ${s.length > 200 ? s.slice(0, 200) + "…" : s}`)
  }
}

/** Strip the `loop_` prefix so callers can pass the API-flavored id and
 * get back what the sandbox / on-disk world uses. */
export function rawLoopId(apiId: string): string {
  return apiId.startsWith("loop_") ? apiId.slice("loop_".length) : apiId
}

/** Force the per-loop podman container to be created + running, without
 * sending a chat message. Use when a test needs to pre-seed the workdir
 * before CC ever talks to it. */
export async function ensureSandbox(apiLoopId: string): Promise<void> {
  const id = rawLoopId(apiLoopId)
  const meta = await getLoop(id)
  if (!meta) throw new Error(`loop ${apiLoopId} not found`)
  await ensureContainer({
    loopId: id,
    createdBy: meta.createdBy,
    vaultName: meta.config?.vault,
    knowledgeRw: meta.config?.knowledge_rw,
    mountAllLoops: meta.config?.mount_all_loops,
  })
}

/** Absolute path of a loop's workdir inside the sandbox container. Useful
 * for scenarios building `Bash` commands and for inSandbox probes. */
export function workdirInSandbox(apiId: string): string {
  return `/loopat/loop/${rawLoopId(apiId)}/workdir`
}

// ── sandbox probe (bypasses ws/auth — pure podman exec) ──────────────────

export async function inSandbox(
  apiLoopId: string,
  command: string,
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const podman = process.env.LOOPAT_PODMAN_BIN || "podman"
  const id = rawLoopId(apiLoopId)
  const args = ["exec"]
  if (opts.cwd) args.push("--workdir", opts.cwd)
  args.push(containerName(id), "bash", "-lc", command)
  try {
    const { stdout, stderr } = await execFileP(podman, args, { timeout: opts.timeoutMs ?? 10_000 })
    return { stdout: String(stdout), stderr: String(stderr), code: 0 }
  } catch (e: any) {
    return {
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? e.message ?? ""),
      code: typeof e.code === "number" ? e.code : 1,
    }
  }
}

// ── misc utilities ───────────────────────────────────────────────────────

/** Ask the OS for a free TCP port. Window between probe and bind is small
 * enough to ignore for tests. Container uses `--network host`, so the port
 * the test picks is the same port the container sees. */
export async function freePort(): Promise<number> {
  const { createServer } = await import("node:net")
  return await new Promise<number>((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.on("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const a = s.address() as { port: number }
      const port = a.port
      s.close(() => resolve(port))
    })
  })
}

/** Sleep, used sparingly when waiting for a side effect that has no signal. */
export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

// ── cleanup, registered once at process exit ─────────────────────────────
//
// We deliberately do NOT export an `afterAll`-style teardown for tests to
// call — bun:test runs all files in one process and shares helpers' state,
// so a file-level afterAll would tear down the world for subsequent files.
// Instead, register cleanup at the Node-level `exit`/`beforeExit` signal,
// which fires exactly once after every file is done.

let teardownStarted = false
async function teardownOnce(): Promise<void> {
  if (teardownStarted) return
  teardownStarted = true
  await mockServer.close().catch(() => {})
  if (podmanAvailable) {
    await stopAllWorkspaceContainers().catch(() => {})
    try {
      const { spawnSync } = await import("node:child_process")
      spawnSync("podman", ["unshare", "rm", "-rf", TEST_HOME], { stdio: "ignore" })
    } catch {}
  }
  await rm(TEST_HOME, { recursive: true, force: true }).catch(() => {})
}

process.on("beforeExit", () => {
  // beforeExit is async-friendly: pending promises keep the loop alive.
  void teardownOnce()
})
// SIGINT during a hanging test should still clean up.
process.on("SIGINT", async () => {
  await teardownOnce()
  process.exit(130)
})

/** No-op kept for source compatibility with earlier per-file calls.
 * Real teardown runs on process exit via beforeExit. */
export async function teardownAll(): Promise<void> {
  // intentionally empty
}
