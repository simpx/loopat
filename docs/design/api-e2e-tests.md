---
title: API e2e tests (loop API + sandbox)
tags: [loopat, api, test, e2e, sandbox]
status: spec
date: 2026-05-27
---

# API e2e tests — design

> **Goal**: end-to-end test the v1 loop API by driving real user behaviors
> against the real SDK + real claude binary + real podman sandbox, with
> zero token cost and deterministic outcomes. Sandbox state observed via
> `podman exec` probe (terminal WS is out of scope here).

## What we test, what we mock

| Component | Real or mock |
|---|---|
| Anthropic API (`/v1/messages`) | **mock** — scripted SSE responses dispatched by user-text marker |
| `claude` binary (CC agent) | **real** — same binary the production loop uses |
| Claude Agent SDK in `session.ts` | **real** |
| Loopat v1 API surface | **real** |
| Podman sandbox + tool execution (Bash, Write, Read, BashOutput) | **real** |
| Loop session state, queue, idempotency, SSE framing | **real** |
| Web UI / WS terminal | **not tested here** (covered by e2e/loop.spec.ts) |

The mock plays the **model's role**: emit `tool_use` content blocks → CC
dispatches tools for real → CC sends `tool_result` back → mock emits the
final assistant text. Mock is stateless; dispatch is keyed on the first
user message's marker (`[[scenario-name]]`), turn index derived from
`messages.length`.

## File layout

```
server/test/api-e2e/
  mock-anthropic.ts        ← Bun.serve, scenario registry, Anthropic SSE framing
  helpers.ts               ← env setup, mock singleton, user/loop API helpers, podman exec probe
  hello.test.ts            ← smoke: text-only response
  file-roundtrip.test.ts   ← Bash tool_use writes, probe verifies; cc reads back
  cross-surface.test.ts    ← cc ↔ probe bidirectional; background http server lifecycle
  multi-turn.test.ts       ← 3-turn iteration on one file
  api-edges.test.ts        ← interrupt, archive, GET /events viewer, idempotency replay
```

## Networking

`server/src/podman.ts:362` uses `--network host` for loop containers, so
CC inside the container reaches the mock by `http://127.0.0.1:<mock_port>`.
The mock picks a free port at process start (port=0 → read back actual).

## Process model

bun:test runs all files in one process (verified). One mock server,
one `LOOPAT_HOME = /tmp/loopat-api-e2e-${pid}`, one registered test user
shared across files. Per-test isolation is at the loop level (each test
calls `api.createLoop()` → fresh loopId → fresh podman container).

## Mock API protocol

### Request handling

```
POST /v1/messages   → 200 text/event-stream
*                   → 404
```

Strategy:
1. Find scenario by matching `firstUserText(messages)` against `marker` substring
2. Determine turn index from `Math.floor(messages.length / 2)`
3. Call `scenario.respond(req, turn)` → iterable of `MockBlock`
4. Stream them as Anthropic SSE events (`message_start` → `content_block_*` → `message_delta` → `message_stop`)

```ts
type MockBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown; id?: string }
  | { type: "end"; stop_reason: "end_turn" | "tool_use" }
```

### Turn-index math

Anthropic `messages` shape grows by 2 per round trip:

| Turn # | `messages.length` | Last role |
|---|---|---|
| 0 | 1 | user (string content) |
| 1 | 3 | user (tool_result content) |
| 2 | 5 | user (tool_result content) |

So `turn = floor(messages.length / 2)`.

### Fallback scenario

Marker `""` matches anything. Yields `{ text: "ack" }` + `{ end: end_turn }`.
Catches "forgot to register a scenario" so tests fail loudly instead of
hanging.

### What we ignore from the request

- `system` prompt (whatever CC sends)
- `cache_control` headers
- `temperature`, `max_tokens`, `thinking`, `top_p`, `top_k`
- `metadata`, `service_tier`, `stream` flag (always stream)
- model name validation (always claim to be `claude-mock`)

## Test helpers API

```ts
// helpers.ts — auto-init at top-level import

// scenario registry
export const mock: {
  register(s: Scenario): void
  clear(): void                 // each test calls in afterEach
}

// user/loop fixtures
export async function authedRequest(path: string, init: RequestInit): Promise<Response>
export async function createLoop(opts?: { title?: string }): Promise<string>
export async function sendMessage(loopId: string, content: string, opts?: { idempotencyKey?: string }): Promise<Response>
export async function readSSE(r: Response, opts: { until: (e: SSEEvent) => boolean; timeoutMs?: number }): Promise<SSEEvent[]>

// sandbox probe (bypasses ws/auth)
export async function inSandbox(loopId: string, command: string, opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; code: number }>

// scenario builder helpers
export const blocks: {
  text: (t: string) => MockBlock
  bash: (cmd: string, opts?: { run_in_background?: boolean }) => MockBlock
  write: (path: string, content: string) => MockBlock
  endTurn: () => MockBlock
  endTool: () => MockBlock
}
```

## Scenario set (MVP — 6 files, ~15 tests)

### hello.test.ts
- `T1 send "hi" → mock returns text → SSE: assistant_delta with "hi" + done`

### file-roundtrip.test.ts
- `T2 cc creates /workdir/foo.txt via Bash tool_use → done → probe asserts file content`
- `T3 multi-turn: cc creates file (msg 1) → cc ls /workdir (msg 2) → second SSE assistant text contains "foo.txt"` (each msg = separate POST)

### cross-surface.test.ts (core)
- `T4 cc writes → probe sees`: cc Bash `echo X > /workdir/a` → probe `cat /workdir/a` = "X"
- `T5 probe writes → cc reads`: probe `echo Y > /workdir/b` → cc Bash `cat /workdir/b`; assert tool_result delivered (cc final text contains "Y")
- `T6 cc starts background http server (run_in_background: true) → probe curl localhost:8765 → 200`
- `T7 after T6's server is running, send another loop message → loop responds normally; proves loop survives an outstanding bg process`

### multi-turn.test.ts
- `T8 three messages, each adds to /workdir/add.py — final file contains all three additions (function body + type hints + docstring)`

### api-edges.test.ts
- `T9 interrupt mid-tool: mock emits Bash sleep 30 → test POSTs /interrupt → SSE event interrupted`
- `T10 archive blocks send: DELETE /loops/:id then POST /messages → 400 with code loop_archived`
- `T11 GET /events read-only viewer parallel to POST /messages: both see assistant_delta events`
- `T12 idempotency replay: POST /messages twice with same key → second is replay (no second mock invocation)`

## Lifecycle / cleanup

- `helpers.ts` top-level (runs once on first import): pick mock port, set env, write provider config, register test user, start mock server
- Cleanup runs once at `process.on('beforeExit')` — NOT per-file afterAll. Per-file afterAll would tear down the shared mock + LOOPAT_HOME for subsequent files in the same `bun test` invocation
- Container idle stop: `LOOPAT_CONTAINER_IDLE_MS=60000` — long enough that two-message tests don't lose the container between turns, short enough that leftover bg processes from a failed test get reaped before the next file
- All tests gated by `describe.skipIf(!podmanAvailable)` like chat-integration

## Mixed-suite env handling

When `bun test` runs the whole repo, the api-e2e files inherit env vars from earlier-loaded test files:

| Env var | Set by | Our handling |
|---|---|---|
| `LOOPAT_HOME` | api-v1.test.ts (alphabetically earlier) | adopt via `??=`; paths.ts has already cached it. Write our config.json on top |
| `LOOPAT_CLAUDE_BIN` | chat-integration.test.ts (points at mock-claude.sh) | `delete process.env.LOOPAT_CLAUDE_BIN` at top of helpers.ts so the real claude binary resolves and connects to our mock anthropic |
| `LOOPAT_CONTAINER_IDLE_MS` | unset by others | we set it via `??=` |

## Known risks + mitigations

| Risk | Mitigation |
|---|---|
| CC version bumps change `tools` schema field names (`run_in_background` renamed, etc.) | Mock reads `req.tools` at runtime; falls back to "best guess" + log warning. Tests catch on broken assertion |
| CC sends `/v1/messages/count_tokens` probe | 404; SDK falls back to estimation |
| Anthropic SSE event order subtle differences | Validate mock output once with `@anthropic-ai/sdk` parser in a meta-test |
| Stale `python -m http.server` from T6 blocks port 8765 in next file | Use a per-test port (loopId hash → port range) or wait for container removal |
| Long bg process from killed test leaks | `stopAllWorkspaceContainers` in `afterAll`; `LOOPAT_CONTAINER_IDLE_MS` short |

## Out of scope (v1)

- WS terminal coverage (already covered weakly by e2e/loop.spec.ts; deep coverage = separate task)
- Permission flow (`canUseTool` + permission_mode interaction) — mock currently always allows
- Real LLM smoke tests (backlog: `server/test/api-soak/` with LiteLLM + Qwen2.5-Coder)
- Multi-user driver/handoff scenarios (covered by `driver-handoff.test.ts` at unit level)
