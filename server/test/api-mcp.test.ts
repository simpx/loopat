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
const {
  personalDir,
  personalLoopatDir,
  personalLoopatConfigPath,
  personalVaultDir,
  personalVaultEnvPath,
  workspaceTeamSettingsPath,
  workspaceTeamClaudeDir,
} = await import("../src/paths")
const { createUser, createSession, COOKIE_NAME } = await import("../src/auth")

const USER = "tester"
let SESSION_COOKIE = ""

// Build an authed session cookie so requireAuth-protected endpoints pass.
async function authedHeaders(): Promise<Record<string, string>> {
  return { Cookie: `${COOKIE_NAME}=${SESSION_COOKIE}` }
}

async function setupUserAndTeam() {
  // Create user + session (first user → admin/active automatically)
  try { await createUser({ id: USER, password: "pw" }) } catch {}
  SESSION_COOKIE = createSession(USER)
  // Personal scaffolding
  await mkdir(personalLoopatDir(USER), { recursive: true })
  await mkdir(personalVaultDir(USER, "default"), { recursive: true })
  await mkdir(join(personalVaultDir(USER, "default"), "envs"), { recursive: true })
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
  // Team-tier mcpServers (knowledge/.loopat/.claude/settings.json)
  await mkdir(workspaceTeamClaudeDir(), { recursive: true })
  await writeFile(workspaceTeamSettingsPath(), JSON.stringify({
    mcpServers: {
      github: {
        type: "http",
        url: "https://api.githubcopilot.com/mcp",
        headers: { Authorization: "Bearer ${MCP_GITHUB_TOKEN}" },
      },
      "stdio-server": { type: "stdio", command: "echo", args: ["hi"] },
    },
  }))
}

beforeAll(setupUserAndTeam)
afterAll(async () => { await rm(HOME, { recursive: true, force: true }) })

// Probe network calls would slow tests down; the team server's URL points to
// a real host. We don't assert on oauthSupport — the endpoint may produce
// "unreachable" depending on network. The shape and tier presence are what
// we care about.

describe("GET /api/mcp-servers — tier shape", () => {
  test("returns team / plugin / personal tiers in that order", async () => {
    const r = await app.request("/api/mcp-servers", { headers: await authedHeaders() })
    expect(r.status).toBe(200)
    const j = await r.json() as any
    expect(j.tiers).toBeArray()
    const ids = j.tiers.map((t: any) => t.id)
    expect(ids).toEqual(["team", "plugin", "personal"])
  })

  test("team tier surfaces workspace-defined servers", async () => {
    const r = await app.request("/api/mcp-servers", { headers: await authedHeaders() })
    const j = await r.json() as any
    const team = j.tiers.find((t: any) => t.id === "team")
    const names = team.servers.map((s: any) => s.name).sort()
    expect(names).toEqual(["github", "stdio-server"])
    const gh = team.servers.find((s: any) => s.name === "github")
    expect(gh.type).toBe("http")
    expect(gh.url).toBe("https://api.githubcopilot.com/mcp")
  })

  test("personal tier carries shadowsWorkspace flag for same-named entries", async () => {
    // Add a personal mcpServer with same name as a team one.
    const { personalSettingsPath, personalClaudeDir } = await import("../src/paths")
    await mkdir(personalClaudeDir(USER), { recursive: true })
    await writeFile(personalSettingsPath(USER), JSON.stringify({
      mcpServers: {
        github: { type: "http", url: "https://my.personal.gh/mcp" },
        "personal-only": { type: "stdio", command: "x" },
      },
    }))
    const r = await app.request("/api/mcp-servers", { headers: await authedHeaders() })
    const j = await r.json() as any
    const personal = j.tiers.find((t: any) => t.id === "personal")
    const gh = personal.servers.find((s: any) => s.name === "github")
    const own = personal.servers.find((s: any) => s.name === "personal-only")
    expect(gh.shadowsWorkspace).toBe(true)
    expect(own.shadowsWorkspace).toBe(false)
  })
})

describe("GET /api/mcp-auth — connection summary", () => {
  test("returns map keyed by MCP_<NAME>_TOKEN with connected boolean", async () => {
    // Seed two MCP_*_TOKEN env files, one empty, one with value.
    await writeFile(personalVaultEnvPath(USER, "default", "MCP_GITHUB_TOKEN"), "ghu_secret_xxx")
    await writeFile(personalVaultEnvPath(USER, "default", "MCP_LINEAR_TOKEN"), "")
    const r = await app.request("/api/mcp-auth?vault=default", { headers: await authedHeaders() })
    expect(r.status).toBe(200)
    const j = await r.json() as any
    expect(j.MCP_GITHUB_TOKEN).toEqual({ connected: true, varName: "MCP_GITHUB_TOKEN" })
    expect(j.MCP_LINEAR_TOKEN).toEqual({ connected: false, varName: "MCP_LINEAR_TOKEN" })
  })

  test("only MCP_*_TOKEN env files appear in summary", async () => {
    await writeFile(personalVaultEnvPath(USER, "default", "RANDOM_VAR"), "v")
    const r = await app.request("/api/mcp-auth?vault=default", { headers: await authedHeaders() })
    const j = await r.json() as any
    expect(j.RANDOM_VAR).toBeUndefined()
  })

  test("rejects invalid vault name", async () => {
    const r = await app.request("/api/mcp-auth?vault=../escape", { headers: await authedHeaders() })
    expect(r.status).toBe(400)
  })
})

describe("DELETE /api/mcp-auth/:server — removes vault env", () => {
  test("deletes the matching MCP_<NAME>_TOKEN file", async () => {
    await writeFile(personalVaultEnvPath(USER, "default", "MCP_GITHUB_TOKEN"), "ghu_will_die")
    const r = await app.request("/api/mcp-auth/github?vault=default", {
      method: "DELETE",
      headers: await authedHeaders(),
    })
    expect(r.status).toBe(200)
    expect(await Bun.file(personalVaultEnvPath(USER, "default", "MCP_GITHUB_TOKEN")).exists()).toBe(false)
  })

  test("rejects invalid server name with shell metas", async () => {
    // semicolon is not in SERVER_NAME_RE — backend rejects with 400.
    const r = await app.request("/api/mcp-auth/foo%3Brm?vault=default", {
      method: "DELETE",
      headers: await authedHeaders(),
    })
    expect(r.status).toBe(400)
  })
})
