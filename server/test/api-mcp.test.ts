/**
 * L2: HTTP-endpoint tests for the MCP-facing API. Uses Hono's app.request()
 * — no real network listener.
 *
 * Setup hazards:
 *   1. paths.ts captures LOOPAT_HOME at module load → must be set first.
 *   2. index.ts bootstraps at module load (loadConfig, clones repos[], starts
 *      ./serve listener). Pre-seed a minimal config.json (no repos) BEFORE
 *      import so bootstrap is cheap. Random ports avoid collision.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

process.env.LOOPAT_HOME ??= `/tmp/loopat-api-mcp-${process.pid}`
process.env.PORT = "0"
process.env.LOOPAT_SERVE_PORT = "0"

// Pre-seed before import so the bootstrap doesn't try to clone repos
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
const { composeFromPlan } = await import("../src/compose")
const {
  personalDir,
  personalLoopatDir,
  personalLoopatConfigPath,
  personalVaultDir,
  personalVaultEnvPath,
  personalClaudeDir,
  personalSettingsPath,
  workspaceTeamSettingsPath,
  workspaceTeamClaudeDir,
  loopWorkdir,
  loopClaudeDir,
  loopContextKnowledge,
  loopContextNotes,
} = await import("../src/paths")
const { createUser, createSession, COOKIE_NAME } = await import("../src/auth")

const USER = "tester"
let SESSION_COOKIE = ""

async function authedHeaders(): Promise<Record<string, string>> {
  return { Cookie: `${COOKIE_NAME}=${SESSION_COOKIE}` }
}

async function setupLoop(loopId: string): Promise<void> {
  await mkdir(loopWorkdir(loopId), { recursive: true })
  await mkdir(loopClaudeDir(loopId), { recursive: true })
  await mkdir(loopContextKnowledge(loopId), { recursive: true })
  await mkdir(loopContextNotes(loopId), { recursive: true })
  await composeFromPlan(loopId, {
    user: USER,
    claudeSources: [
      { source: "team", dir: workspaceTeamClaudeDir() },
      { source: `personal:${USER}`, dir: personalDir(USER) },
    ],
  } as any)
}

async function setupUserAndTeam() {
  try { await createUser({ id: USER, password: "pw" }) } catch {}
  SESSION_COOKIE = createSession(USER)
  await mkdir(personalLoopatDir(USER), { recursive: true })
  await mkdir(personalVaultDir(USER, "default"), { recursive: true })
  await mkdir(join(personalVaultDir(USER, "default"), "envs"), { recursive: true })
  await mkdir(personalClaudeDir(USER), { recursive: true })
  await writeFile(personalSettingsPath(USER), JSON.stringify({ mcpServers: {} }))
  await writeFile(personalLoopatConfigPath(USER), JSON.stringify({
    providers: {
      default: "anthropic",
      anthropic: {
        baseUrl: "https://api.anthropic.com",
        model: "claude-opus-4-7",
        apiKey: "${ANTHROPIC_API_KEY}",
      },
    },
  }))
  await mkdir(workspaceTeamClaudeDir(), { recursive: true })
  await writeFile(workspaceTeamSettingsPath(), JSON.stringify({
    mcpServers: {
      github: {
        type: "http",
        url: "https://api.githubcopilot.com/mcp",
        headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
      },
      "stdio-server": { type: "stdio", command: "echo", args: ["hi"] },
      "no-bearer": {
        type: "http",
        url: "https://api.example/mcp",
        headers: { "X-Api-Key": "${EXAMPLE_KEY}" },
      },
    },
  }))
}

beforeAll(setupUserAndTeam)
afterAll(async () => { await rm(HOME, { recursive: true, force: true }) })

// Note: we don't assert on oauthSupport — that field depends on network
// reachability of the server's .well-known endpoints. Shape and authed-flag
// derivation are what we care about.

describe("GET /api/mcp-servers — flat list from merged settings.json", () => {
  test("without loopId, returns empty list", async () => {
    const r = await app.request("/api/mcp-servers", { headers: await authedHeaders() })
    expect(r.status).toBe(200)
    const j = await r.json() as any
    expect(j.servers).toEqual([])
  })

  test("with loopId, returns servers from the loop's composed settings.json", async () => {
    const loopId = "api-mcp-0000-0000-0000-000000000001"
    await setupLoop(loopId)
    const r = await app.request(`/api/mcp-servers?loopId=${loopId}`, { headers: await authedHeaders() })
    const j = await r.json() as any
    const names = j.servers.map((s: any) => s.name).sort()
    expect(names).toEqual(["github", "no-bearer", "stdio-server"])
  }, { timeout: 15000 })

  test("Bearer-templated server exposes authTokenEnv", async () => {
    const loopId = "api-mcp-0000-0000-0000-000000000002"
    await setupLoop(loopId)
    const r = await app.request(`/api/mcp-servers?loopId=${loopId}`, { headers: await authedHeaders() })
    const j = await r.json() as any
    const gh = j.servers.find((s: any) => s.name === "github")
    expect(gh.authTokenEnv).toBe("GITHUB_TOKEN")
  }, { timeout: 15000 })

  test("non-Bearer auth → authTokenEnv is null", async () => {
    const loopId = "api-mcp-0000-0000-0000-000000000003"
    await setupLoop(loopId)
    const r = await app.request(`/api/mcp-servers?loopId=${loopId}`, { headers: await authedHeaders() })
    const j = await r.json() as any
    const nb = j.servers.find((s: any) => s.name === "no-bearer")
    expect(nb.authTokenEnv).toBeNull()
  }, { timeout: 15000 })

  test("stdio server → authTokenEnv is null", async () => {
    const loopId = "api-mcp-0000-0000-0000-000000000004"
    await setupLoop(loopId)
    const r = await app.request(`/api/mcp-servers?loopId=${loopId}`, { headers: await authedHeaders() })
    const j = await r.json() as any
    const stdio = j.servers.find((s: any) => s.name === "stdio-server")
    expect(stdio.authTokenEnv).toBeNull()
  })

  test("authed flag reflects env file existence", async () => {
    const loopId = "api-mcp-0000-0000-0000-000000000005"
    await setupLoop(loopId)
    // Without env file: authed=false
    let r = await app.request(`/api/mcp-servers?loopId=${loopId}`, { headers: await authedHeaders() })
    let j = await r.json() as any
    expect(j.servers.find((s: any) => s.name === "github").authed).toBe(false)
    // Write the env file → authed=true
    await writeFile(personalVaultEnvPath(USER, "default", "GITHUB_TOKEN"), "ghu_xxx")
    r = await app.request(`/api/mcp-servers?loopId=${loopId}`, { headers: await authedHeaders() })
    j = await r.json() as any
    expect(j.servers.find((s: any) => s.name === "github").authed).toBe(true)
    // Empty env file → authed=false (treated as unset)
    await writeFile(personalVaultEnvPath(USER, "default", "GITHUB_TOKEN"), "")
    r = await app.request(`/api/mcp-servers?loopId=${loopId}`, { headers: await authedHeaders() })
    j = await r.json() as any
    expect(j.servers.find((s: any) => s.name === "github").authed).toBe(false)
  })
})

describe("POST /api/mcp-auth/start — input validation", () => {
  test("rejects missing serverName", async () => {
    const r = await app.request("/api/mcp-auth/start", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authedHeaders()) },
      body: JSON.stringify({ loopId: "any" }),
    })
    expect(r.status).toBe(400)
  })

  test("rejects missing loopId", async () => {
    const r = await app.request("/api/mcp-auth/start", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authedHeaders()) },
      body: JSON.stringify({ serverName: "github" }),
    })
    expect(r.status).toBe(400)
  })

  test("rejects server with shell metas in name", async () => {
    const r = await app.request("/api/mcp-auth/start", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authedHeaders()) },
      body: JSON.stringify({ serverName: "foo;rm -rf", loopId: "any" }),
    })
    expect(r.status).toBe(400)
  })

  test("rejects server not present in merged settings", async () => {
    const loopId = "api-mcp-0000-0000-0000-000000000020"
    await setupLoop(loopId)
    const r = await app.request("/api/mcp-auth/start", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authedHeaders()) },
      body: JSON.stringify({ serverName: "ghost", loopId }),
    })
    expect(r.status).toBe(400)
    const j = await r.json() as any
    expect(j.error).toMatch(/not found in loop's merged settings/)
  })

  test("rejects stdio server (OAuth only applies to http/sse)", async () => {
    const loopId = "api-mcp-0000-0000-0000-000000000021"
    await setupLoop(loopId)
    const r = await app.request("/api/mcp-auth/start", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authedHeaders()) },
      body: JSON.stringify({ serverName: "stdio-server", loopId }),
    })
    expect(r.status).toBe(400)
  })

  test("rejects server without Bearer template", async () => {
    const loopId = "api-mcp-0000-0000-0000-000000000022"
    await setupLoop(loopId)
    const r = await app.request("/api/mcp-auth/start", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authedHeaders()) },
      body: JSON.stringify({ serverName: "no-bearer", loopId }),
    })
    expect(r.status).toBe(400)
    const j = await r.json() as any
    expect(j.error).toMatch(/Authorization: Bearer/)
  })
})

describe("DELETE /api/envs/:name — removes vault env (= Forget MCP token)", () => {
  test("deletes the named env file from personal default vault", async () => {
    await writeFile(personalVaultEnvPath(USER, "default", "GITHUB_TOKEN"), "ghu_will_die")
    const r = await app.request("/api/envs/GITHUB_TOKEN", {
      method: "DELETE",
      headers: await authedHeaders(),
    })
    expect(r.status).toBe(200)
    expect(await Bun.file(personalVaultEnvPath(USER, "default", "GITHUB_TOKEN")).exists()).toBe(false)
  })

  test("succeeds even when env file doesn't exist (idempotent)", async () => {
    const r = await app.request("/api/envs/NEVER_EXISTED", {
      method: "DELETE",
      headers: await authedHeaders(),
    })
    expect(r.status).toBe(200)
  })

  test("rejects invalid env name (lowercase / leading digit / shell metas)", async () => {
    const r1 = await app.request("/api/envs/lowercase", {
      method: "DELETE",
      headers: await authedHeaders(),
    })
    expect(r1.status).toBe(400)
    const r2 = await app.request("/api/envs/1STARTS", {
      method: "DELETE",
      headers: await authedHeaders(),
    })
    expect(r2.status).toBe(400)
    const r3 = await app.request("/api/envs/foo%3Brm", {
      method: "DELETE",
      headers: await authedHeaders(),
    })
    expect(r3.status).toBe(400)
  })
})
