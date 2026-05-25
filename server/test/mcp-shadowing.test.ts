/**
 * L2+L3: MCP server tier shadowing — when team + personal define the same
 * server name, what reaches the spawned binary, and what does the API
 * report?
 *
 * Merge semantics: server-key-granularity whole-object replacement. Personal
 * entry shadows team's same-named entry completely (URLs, headers, all).
 *
 * Surface check: /api/mcp-servers reads the loop's merged settings.json
 * (single source) and returns a flat `servers` list. No tier breakdown,
 * because tokens are vault envs — the popover doesn't need provenance.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"

process.env.LOOPAT_HOME ??= `/tmp/loopat-mcp-shadow-${process.pid}`
process.env.PORT = "0"
process.env.LOOPAT_SERVE_PORT = "0"

const HOME = process.env.LOOPAT_HOME!
await rm(HOME, { recursive: true, force: true })
await mkdir(HOME, { recursive: true })
await writeFile(join(HOME, "config.json"), JSON.stringify({
  knowledge: { git: "" }, notes: { git: "" }, repos: [], providers: {},
}))

const { app } = await import("../src/index")
const { composeFromPlan } = await import("../src/compose")
const {
  loopWorkdir, loopClaudeDir, loopContextKnowledge, loopContextNotes,
  personalDir, personalLoopatDir, personalClaudeDir, personalSettingsPath,
  workspaceTeamClaudeDir, workspaceTeamSettingsPath,
} = await import("../src/paths")
const { createUser, createSession, COOKIE_NAME } = await import("../src/auth")

const USER = "shadowtester"
let COOKIE = ""

async function authed(): Promise<Record<string, string>> {
  return { Cookie: `${COOKIE_NAME}=${COOKIE}` }
}

beforeAll(async () => {
  try { await createUser({ id: USER, password: "pw" }) } catch {}
  COOKIE = createSession(USER)
  await mkdir(personalLoopatDir(USER), { recursive: true })
  await mkdir(personalClaudeDir(USER), { recursive: true })
  // Team-tier MCPs: github + linear
  await mkdir(workspaceTeamClaudeDir(), { recursive: true })
  await writeFile(workspaceTeamSettingsPath(), JSON.stringify({
    mcpServers: {
      github: { type: "http", url: "https://team.github/mcp", headers: { Authorization: "Bearer ${GH_TOKEN}" } },
      linear: { type: "http", url: "https://team.linear/mcp" },
    },
  }))
  // Personal-tier MCPs: github (shadow), private-only (no shadow)
  await writeFile(personalSettingsPath(USER), JSON.stringify({
    mcpServers: {
      github: { type: "http", url: "https://my-fork.github/mcp" },
      "private-only": { type: "stdio", command: "echo", args: ["personal"] },
    },
  }))
})

afterAll(async () => { await rm(HOME, { recursive: true, force: true }) })

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

describe("MCP merge semantics — composed loop settings.json", () => {
  test("personal entry wins over team (last-wins at server-key granularity)", async () => {
    const loopId = "shadowsh-0000-0000-0000-000000000001"
    await setupLoop(loopId)
    const merged = JSON.parse(await readFile(join(loopClaudeDir(loopId), "settings.json"), "utf8"))
    expect(merged.mcpServers.github.url).toBe("https://my-fork.github/mcp")
    expect(merged.mcpServers.linear.url).toBe("https://team.linear/mcp")
    expect(merged.mcpServers["private-only"]).toBeDefined()
  })

  test("personal entry without headers DROPS the team's headers (whole-object replace)", async () => {
    // Important semantic: personal `github` has no headers, so the merged
    // entry has no Authorization template — the OAuth flow would refuse this
    // server. The team's headers do NOT leak through.
    const loopId = "shadowsh-0000-0000-0000-000000000002"
    await setupLoop(loopId)
    const merged = JSON.parse(await readFile(join(loopClaudeDir(loopId), "settings.json"), "utf8"))
    expect(merged.mcpServers.github.headers).toBeUndefined()
  })

  test("team-only server (no personal counterpart) keeps its full object", async () => {
    const loopId = "shadowsh-0000-0000-0000-000000000003"
    await setupLoop(loopId)
    const merged = JSON.parse(await readFile(join(loopClaudeDir(loopId), "settings.json"), "utf8"))
    expect(merged.mcpServers.linear).toEqual({ type: "http", url: "https://team.linear/mcp" })
  })
})

describe("MCP inventory — /api/mcp-servers reads the loop's merged settings.json", () => {
  test("without loopId, returns empty list", async () => {
    const r = await app.request("/api/mcp-servers", { headers: await authed() })
    const j = await r.json() as any
    expect(j.servers).toEqual([])
  })

  test("with loopId, returns flat list reflecting merged settings.json", async () => {
    const loopId = "shadowsh-0000-0000-0000-000000000010"
    await setupLoop(loopId)
    const r = await app.request(`/api/mcp-servers?loopId=${loopId}`, { headers: await authed() })
    const j = await r.json() as any
    const names = j.servers.map((s: any) => s.name).sort()
    expect(names).toEqual(["github", "linear", "private-only"])
    const github = j.servers.find((s: any) => s.name === "github")
    expect(github.url).toBe("https://my-fork.github/mcp") // personal-shadowed URL
  })

  test("server with Bearer template exposes authTokenEnv", async () => {
    // Use a fresh loop where team's github has the Bearer template AND no
    // personal shadow drops the headers.
    await writeFile(personalSettingsPath(USER), JSON.stringify({ mcpServers: {} }))
    const loopId = "shadowsh-0000-0000-0000-000000000011"
    await setupLoop(loopId)
    const r = await app.request(`/api/mcp-servers?loopId=${loopId}`, { headers: await authed() })
    const j = await r.json() as any
    const github = j.servers.find((s: any) => s.name === "github")
    expect(github.authTokenEnv).toBe("GH_TOKEN")
    expect(github.authed).toBe(false) // no env file written
  })

  test("server without Bearer template has authTokenEnv=null", async () => {
    const loopId = "shadowsh-0000-0000-0000-000000000012"
    await setupLoop(loopId)
    const r = await app.request(`/api/mcp-servers?loopId=${loopId}`, { headers: await authed() })
    const j = await r.json() as any
    const linear = j.servers.find((s: any) => s.name === "linear")
    expect(linear.authTokenEnv).toBeNull()
    expect(linear.authed).toBe(false)
  })
})
