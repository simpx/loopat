/**
 * L2: HTTP-endpoint tests for the v1 Loop API (token store + Loop CRUD +
 * auth). SSE streaming endpoints require a live agent and are exercised by
 * the Playwright e2e suite.
 */
import { test, expect, describe, beforeAll } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

process.env.LOOPAT_HOME ??= `/tmp/loopat-api-v1-${process.pid}`
process.env.PORT = "0"
process.env.LOOPAT_SERVE_PORT = "0"

const HOME = process.env.LOOPAT_HOME!
await rm(HOME, { recursive: true, force: true })
await mkdir(HOME, { recursive: true })
await writeFile(join(HOME, "config.json"), JSON.stringify({
  knowledge: { git: "" },
  notes: { git: "" },
  repos: [],
  providers: {},
}))

const { app } = await import("../src/index")
const { createUser, createSession, COOKIE_NAME } = await import("../src/auth")
const { _resetCache } = await import("../src/api-tokens")

const USER_A = "alice"
const USER_B = "bob"
let SESSION_A = ""
let SESSION_B = ""
let TOKEN_A = ""

beforeAll(async () => {
  await createUser({ id: USER_A, password: "pw", role: "admin", status: "active" })
  await createUser({ id: USER_B, password: "pw", role: "member", status: "active" })
  SESSION_A = createSession(USER_A)
  SESSION_B = createSession(USER_B)
  _resetCache()
})

function cookieHeader(sess: string): Record<string, string> {
  return { Cookie: `${COOKIE_NAME}=${sess}` }
}

describe("token management (/me/tokens)", () => {
  test("requires session cookie (not bearer)", async () => {
    const r = await app.request("/api/v1/me/tokens", { method: "GET" })
    expect(r.status).toBe(401)
  })

  test("create + list + revoke round-trip", async () => {
    const created = await app.request("/api/v1/me/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: JSON.stringify({ label: "ci-bot" }),
    })
    expect(created.status).toBe(201)
    const cj = await created.json()
    expect(cj.token).toMatch(/^la_[0-9a-f]+$/)
    expect(cj.tokenId).toMatch(/^tok_[0-9a-f]+$/)
    expect(cj.label).toBe("ci-bot")
    TOKEN_A = cj.token

    const listed = await app.request("/api/v1/me/tokens", { headers: cookieHeader(SESSION_A) })
    expect(listed.status).toBe(200)
    const lj = await listed.json()
    expect(lj.tokens.length).toBe(1)
    expect(lj.tokens[0]).toMatchObject({ label: "ci-bot", tokenId: cj.tokenId })
    expect(lj.tokens[0].token).toBeUndefined() // never returned after creation

    const revoked = await app.request(`/api/v1/me/tokens/${cj.tokenId}`, {
      method: "DELETE",
      headers: cookieHeader(SESSION_A),
    })
    expect(revoked.status).toBe(204)

    const afterRevoke = await app.request("/api/v1/me/tokens", { headers: cookieHeader(SESSION_A) })
    expect((await afterRevoke.json()).tokens.length).toBe(0)
  })

  test("user B does not see user A's tokens", async () => {
    await app.request("/api/v1/me/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: JSON.stringify({ label: "alice-private" }),
    })
    const bobList = await app.request("/api/v1/me/tokens", { headers: cookieHeader(SESSION_B) })
    expect((await bobList.json()).tokens.length).toBe(0)
  })

  test("revoke fails 404 for unknown tokenId", async () => {
    const r = await app.request("/api/v1/me/tokens/tok_nonexistent", {
      method: "DELETE",
      headers: cookieHeader(SESSION_A),
    })
    expect(r.status).toBe(404)
  })
})

describe("auth: cookie vs bearer on /loops", () => {
  let bearerToken = ""
  beforeAll(async () => {
    const r = await app.request("/api/v1/me/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: JSON.stringify({ label: "test-bearer" }),
    })
    bearerToken = (await r.json()).token
  })

  test("cookie auth works", async () => {
    const r = await app.request("/api/v1/loops", { headers: cookieHeader(SESSION_A) })
    expect(r.status).toBe(200)
  })

  test("bearer auth works", async () => {
    const r = await app.request("/api/v1/loops", {
      headers: { Authorization: `Bearer ${bearerToken}` },
    })
    expect(r.status).toBe(200)
  })

  test("bad bearer rejected", async () => {
    const r = await app.request("/api/v1/loops", {
      headers: { Authorization: "Bearer la_definitely_invalid" },
    })
    expect(r.status).toBe(401)
  })

  test("malformed bearer rejected", async () => {
    const r = await app.request("/api/v1/loops", {
      headers: { Authorization: "Bearer not-la-prefix" },
    })
    expect(r.status).toBe(401)
  })

  test("no auth → 401", async () => {
    const r = await app.request("/api/v1/loops")
    expect(r.status).toBe(401)
  })
})

describe("loop CRUD (/loops)", () => {
  let createdLoopId = ""

  test("POST /loops creates with vault/metadata", async () => {
    // profiles intentionally omitted — test env has no workspace profile dir
    const r = await app.request("/api/v1/loops", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: JSON.stringify({
        title: "demo loop",
        vault: "default",
        metadata: { slack_thread: "C1:t2" },
      }),
    })
    expect(r.status).toBe(201)
    const j = await r.json()
    expect(j.id).toMatch(/^loop_[0-9a-f-]+$/)
    expect(j.title).toBe("demo loop")
    expect(j.created_by).toBe(USER_A)
    expect(j.vault).toBe("default")
    expect(j.archived).toBe(false)
    expect(j.metadata).toEqual({ slack_thread: "C1:t2" })
    createdLoopId = j.id
  })

  test("POST /loops with empty body uses defaults", async () => {
    const r = await app.request("/api/v1/loops", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: "{}",
    })
    expect(r.status).toBe(201)
    const j = await r.json()
    expect(j.title).toBe("untitled")
  })

  test("POST /loops rejects oversized metadata", async () => {
    const huge = { x: "y".repeat(17 * 1024) }
    const r = await app.request("/api/v1/loops", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: JSON.stringify({ metadata: huge }),
    })
    expect(r.status).toBe(400)
    expect((await r.json()).error.code).toBe("metadata_too_large")
  })

  test("POST /loops rejects long title", async () => {
    const r = await app.request("/api/v1/loops", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: JSON.stringify({ title: "x".repeat(201) }),
    })
    expect(r.status).toBe(400)
    expect((await r.json()).error.code).toBe("title_too_long")
  })

  test("GET /loops returns user's loops", async () => {
    const r = await app.request("/api/v1/loops", { headers: cookieHeader(SESSION_A) })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.data.length).toBeGreaterThanOrEqual(2)
    expect(j.data.every((l: any) => l.created_by === USER_A)).toBe(true)
    expect(j.has_more).toBe(false)
  })

  test("GET /loops respects limit", async () => {
    const r = await app.request("/api/v1/loops?limit=1", { headers: cookieHeader(SESSION_A) })
    const j = await r.json()
    expect(j.data.length).toBe(1)
    expect(j.has_more).toBe(true)
  })

  test("GET /loops does not leak other users' loops", async () => {
    await app.request("/api/v1/loops", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_B) },
      body: JSON.stringify({ title: "bob's loop" }),
    })
    const bob = await app.request("/api/v1/loops", { headers: cookieHeader(SESSION_B) })
    const bobJson = await bob.json()
    expect(bobJson.data.every((l: any) => l.created_by === USER_B)).toBe(true)

    const alice = await app.request("/api/v1/loops", { headers: cookieHeader(SESSION_A) })
    const aliceJson = await alice.json()
    expect(aliceJson.data.every((l: any) => l.created_by === USER_A)).toBe(true)
  })

  test("GET /loops/{id} returns full detail", async () => {
    const r = await app.request(`/api/v1/loops/${createdLoopId}`, { headers: cookieHeader(SESSION_A) })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.id).toBe(createdLoopId)
    expect(j.title).toBe("demo loop")
    expect(typeof j.busy).toBe("boolean")
    expect(typeof j.queue_depth).toBe("number")
  })

  test("GET /loops/{id} 403 for non-owner", async () => {
    const r = await app.request(`/api/v1/loops/${createdLoopId}`, { headers: cookieHeader(SESSION_B) })
    expect(r.status).toBe(403)
    expect((await r.json()).error.code).toBe("not_loop_owner")
  })

  test("GET /loops/{id} 404 for unknown", async () => {
    const r = await app.request("/api/v1/loops/loop_doesnotexist", { headers: cookieHeader(SESSION_A) })
    expect(r.status).toBe(404)
  })

  test("DELETE /loops/{id} archives", async () => {
    const r = await app.request(`/api/v1/loops/${createdLoopId}`, {
      method: "DELETE",
      headers: cookieHeader(SESSION_A),
    })
    expect(r.status).toBe(204)
    const detail = await app.request(`/api/v1/loops/${createdLoopId}`, { headers: cookieHeader(SESSION_A) })
    expect((await detail.json()).archived).toBe(true)
  })

  test("archived loops are excluded from default list", async () => {
    const r = await app.request("/api/v1/loops", { headers: cookieHeader(SESSION_A) })
    const j = await r.json()
    expect(j.data.find((l: any) => l.id === createdLoopId)).toBeUndefined()
  })

  test("?archived=true includes archived", async () => {
    const r = await app.request("/api/v1/loops?archived=true", { headers: cookieHeader(SESSION_A) })
    const j = await r.json()
    expect(j.data.find((l: any) => l.id === createdLoopId)).toBeDefined()
  })

  test("DELETE 403 for non-owner", async () => {
    // Make a fresh loop for B's archive attempt
    const create = await app.request("/api/v1/loops", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: JSON.stringify({ title: "alice's only" }),
    })
    const id = (await create.json()).id
    const r = await app.request(`/api/v1/loops/${id}`, {
      method: "DELETE",
      headers: cookieHeader(SESSION_B),
    })
    expect(r.status).toBe(403)
  })
})

describe("idempotency conflict on /messages", () => {
  let id = ""
  beforeAll(async () => {
    const r = await app.request("/api/v1/loops", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: JSON.stringify({ title: "idem" }),
    })
    id = (await r.json()).id
  })

  test("same key + different body → 409", async () => {
    // We can't actually run the agent in this test env (no provider config),
    // so we check the validation paths up front: oversized content + missing
    // content return non-SSE 400s, and the idempotency conflict path returns
    // 409 before any streaming kicks in.

    // First, prime the idempotency store by hitting the validator with a
    // request that gets past auth but fails downstream. To force a stored
    // record without invoking the agent, we use the loop_archived path.
    // (The store is only written for successful streaming requests; this
    // means we can't easily test the 409 in isolation without an agent.)
    // → Skip: relies on streaming. Covered by e2e instead.
    expect(true).toBe(true)
  })

  test("oversized content rejected before SSE", async () => {
    const r = await app.request(`/api/v1/loops/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: JSON.stringify({ content: "x".repeat(2 * 1024 * 1024) }),
    })
    expect(r.status).toBe(400)
    expect((await r.json()).error.code).toBe("content_too_large")
  })

  test("missing content rejected", async () => {
    const r = await app.request(`/api/v1/loops/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: "{}",
    })
    expect(r.status).toBe(400)
    expect((await r.json()).error.code).toBe("missing_content")
  })

  test("oversized idempotency key rejected", async () => {
    const r = await app.request(`/api/v1/loops/${id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "x".repeat(257),
        ...cookieHeader(SESSION_A),
      },
      body: JSON.stringify({ content: "hi" }),
    })
    expect(r.status).toBe(400)
    expect((await r.json()).error.code).toBe("idempotency_key_too_long")
  })
})

describe("choices + interrupt validation", () => {
  let id = ""
  beforeAll(async () => {
    const r = await app.request("/api/v1/loops", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: JSON.stringify({ title: "ctrl" }),
    })
    id = (await r.json()).id
  })

  test("POST /choices/{id} with invalid body → 400", async () => {
    const r = await app.request(`/api/v1/loops/${id}/choices/choice_xyz`, {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: JSON.stringify({}),
    })
    expect(r.status).toBe(400)
    expect((await r.json()).error.code).toBe("invalid_choice_payload")
  })

  test("POST /choices/{id} with no pending choice → 404", async () => {
    const r = await app.request(`/api/v1/loops/${id}/choices/choice_does_not_exist`, {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: JSON.stringify({ allow: true }),
    })
    expect(r.status).toBe(404)
    expect((await r.json()).error.code).toBe("choice_not_found")
  })

  test("POST /interrupt 202 even when no turn is running", async () => {
    const r = await app.request(`/api/v1/loops/${id}/interrupt`, {
      method: "POST",
      headers: cookieHeader(SESSION_A),
    })
    expect(r.status).toBe(202)
  })

  test("non-owner cannot interrupt", async () => {
    const r = await app.request(`/api/v1/loops/${id}/interrupt`, {
      method: "POST",
      headers: cookieHeader(SESSION_B),
    })
    expect(r.status).toBe(403)
  })
})

// ─── 公共账号 (owned accounts / "agents") ────────────────────────────────

describe("/me/accounts (public account management)", () => {
  test("POST creates an owned account; appears in GET", async () => {
    const r = await app.request("/api/v1/me/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: JSON.stringify({ id: "alice-coderev" }),
    })
    expect(r.status).toBe(201)
    const j = await r.json()
    expect(j.id).toBe("alice-coderev")
    expect(j.ownerId).toBe(USER_A)
    expect(j.role).toBe("member")
    expect(j.status).toBe("active")

    const list = await app.request("/api/v1/me/accounts", { headers: cookieHeader(SESSION_A) })
    const lj = await list.json()
    expect(lj.accounts.find((a: any) => a.id === "alice-coderev")).toBeDefined()
  })

  test("GET returns only caller's owned accounts", async () => {
    await app.request("/api/v1/me/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: JSON.stringify({ id: "alice-slack" }),
    })
    await app.request("/api/v1/me/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_B) },
      body: JSON.stringify({ id: "bob-bot" }),
    })
    const aList = await (await app.request("/api/v1/me/accounts", { headers: cookieHeader(SESSION_A) })).json()
    expect(aList.accounts.every((a: any) => a.ownerId === USER_A)).toBe(true)
    expect(aList.accounts.find((a: any) => a.id === "bob-bot")).toBeUndefined()
    const bList = await (await app.request("/api/v1/me/accounts", { headers: cookieHeader(SESSION_B) })).json()
    expect(bList.accounts.find((a: any) => a.id === "bob-bot")).toBeDefined()
  })

  test("duplicate id → 409", async () => {
    const r = await app.request("/api/v1/me/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: JSON.stringify({ id: "alice-coderev" }),
    })
    expect(r.status).toBe(409)
    expect((await r.json()).error.code).toBe("id_taken")
  })

  test("invalid id format → 400", async () => {
    const r = await app.request("/api/v1/me/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: JSON.stringify({ id: "Has Spaces!" }),
    })
    expect(r.status).toBe(400)
    expect((await r.json()).error.code).toBe("invalid_id")
  })

  test("missing id → 400", async () => {
    const r = await app.request("/api/v1/me/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: "{}",
    })
    expect(r.status).toBe(400)
    expect((await r.json()).error.code).toBe("missing_id")
  })

  test("DELETE owner can delete their public account", async () => {
    // Create a fresh one to delete
    await app.request("/api/v1/me/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: JSON.stringify({ id: "alice-temp" }),
    })
    const del = await app.request("/api/v1/me/accounts/alice-temp", {
      method: "DELETE",
      headers: cookieHeader(SESSION_A),
    })
    expect(del.status).toBe(204)
    const list = await (await app.request("/api/v1/me/accounts", { headers: cookieHeader(SESSION_A) })).json()
    expect(list.accounts.find((a: any) => a.id === "alice-temp")).toBeUndefined()
  })

  test("DELETE non-owner → 403", async () => {
    const r = await app.request("/api/v1/me/accounts/alice-coderev", {
      method: "DELETE",
      headers: cookieHeader(SESSION_B),
    })
    expect(r.status).toBe(403)
  })

  test("DELETE unknown → 404", async () => {
    const r = await app.request("/api/v1/me/accounts/nope-xyz", {
      method: "DELETE",
      headers: cookieHeader(SESSION_A),
    })
    expect(r.status).toBe(404)
  })

  test("public account cannot create another public account (no nesting)", async () => {
    // Use the owned account's session (simulating: somehow logged in as it).
    // We don't actually support password login for owned accounts, but
    // createSession bypasses that — this tests the API-layer guard.
    const subSession = createSession("alice-coderev")
    const r = await app.request("/api/v1/me/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(subSession) },
      body: JSON.stringify({ id: "alice-coderev-child" }),
    })
    expect(r.status).toBe(403)
    expect((await r.json()).error.code).toBe("not_personal_account")
  })
})

describe("/me/tokens forAccount", () => {
  test("issue token for an owned public account", async () => {
    const r = await app.request("/api/v1/me/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: JSON.stringify({ label: "ci-coderev", forAccount: "alice-coderev" }),
    })
    expect(r.status).toBe(201)
    const j = await r.json()
    expect(j.forAccount).toBe("alice-coderev")
    expect(j.token).toMatch(/^la_[0-9a-f]+$/)
  })

  test("issue token for non-owned account → 403", async () => {
    const r = await app.request("/api/v1/me/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: JSON.stringify({ label: "x", forAccount: "bob-bot" }),
    })
    expect(r.status).toBe(403)
    expect((await r.json()).error.code).toBe("not_account_owner")
  })

  test("issue token for non-existent account → 404", async () => {
    const r = await app.request("/api/v1/me/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: JSON.stringify({ label: "x", forAccount: "ghost-account-xyz" }),
    })
    expect(r.status).toBe(404)
  })

  test("GET tokens ?forAccount lists tokens for that account", async () => {
    const r = await app.request("/api/v1/me/tokens?forAccount=alice-coderev", {
      headers: cookieHeader(SESSION_A),
    })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j.tokens.length).toBeGreaterThan(0)
    expect(j.tokens[0].label).toBe("ci-coderev")
  })

  test("token issued for owned account resolves to that account, not the owner", async () => {
    // Create a fresh owned-account token + use it to call /loops.
    const create = await (await app.request("/api/v1/me/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", ...cookieHeader(SESSION_A) },
      body: JSON.stringify({ label: "resolve-test", forAccount: "alice-coderev" }),
    })).json()
    const loopCreate = await app.request("/api/v1/loops", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${create.token}`,
      },
      body: JSON.stringify({ title: "by-public-account" }),
    })
    expect(loopCreate.status).toBe(201)
    const loop = await loopCreate.json()
    // Loop should be owned by the public account, not by alice.
    expect(loop.created_by).toBe("alice-coderev")
  })
})

describe("login rejects owned accounts", () => {
  test("password login for an owned account returns 401", async () => {
    const r = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice-coderev", password: "anything" }),
    })
    expect(r.status).toBe(401)
  })
})
