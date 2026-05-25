/**
 * L3: principle 1 — "loops are frozen at creation".
 *
 * composeLoopClaudeConfig writes the merged .claude/ once at loop creation.
 * Admin pushes to team knowledge after that do NOT affect the existing loop's
 * settings.json / CLAUDE.md / skills snapshot. New loops get the new state.
 *
 * Why this matters: lets users keep a long-running loop on a known toolchain
 * even as the team evolves the team-tier config underneath them.
 *
 * session.ts re-runs compose ONLY when the snapshot is missing (self-heal for
 * pre-snapshot loops). The test asserts: re-running compose on a loop that
 * already has a snapshot is a no-op (overwrites with same content, but more
 * importantly, the orchestrator never calls it again unless missing).
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

process.env.LOOPAT_HOME ??= `/tmp/loopat-frozen-${process.pid}`

const { composeFromPlan } = await import("../src/compose")
const {
  LOOPAT_HOME,
  loopClaudeDir,
  loopWorkdir,
  loopContextKnowledge,
  loopContextNotes,
  personalDir,
  personalLoopatDir,
  workspaceTeamClaudeDir,
  workspaceTeamSettingsPath,
  workspaceTeamClaudeMdPath,
} = await import("../src/paths")
const TEST_HOME = LOOPAT_HOME

const USER = "alice"
const LOOP_ID = "ffffffff-0000-1111-2222-333333333333"

async function setupLoop() {
  await rm(TEST_HOME, { recursive: true, force: true })
  await mkdir(loopWorkdir(LOOP_ID), { recursive: true })
  await mkdir(loopClaudeDir(LOOP_ID), { recursive: true })
  await mkdir(loopContextKnowledge(LOOP_ID), { recursive: true })
  await mkdir(loopContextNotes(LOOP_ID), { recursive: true })
  await mkdir(personalLoopatDir(USER), { recursive: true })
  await writeFile(join(TEST_HOME, "config.json"), "{}")
}

async function writeTeam(claudeMd: string, mcpServers: Record<string, any>) {
  await mkdir(workspaceTeamClaudeDir(), { recursive: true })
  await writeFile(workspaceTeamClaudeMdPath(), claudeMd)
  await writeFile(workspaceTeamSettingsPath(), JSON.stringify({ mcpServers }))
}

beforeAll(setupLoop)
afterAll(() => rm(TEST_HOME, { recursive: true, force: true }))

describe("frozen snapshot — compose writes once, downstream changes don't affect it", () => {
  test("initial compose materializes team CLAUDE.md + settings.json", async () => {
    await writeTeam("# TEAM_V1", { coop: { type: "http", url: "https://v1.example/mcp" } })
    const plan = {
      user: USER,
      claudeSources: [
        { source: "team", dir: workspaceTeamClaudeDir() },
      ],
    }
    await composeFromPlan(LOOP_ID, plan as any)
    const md = await readFile(join(loopClaudeDir(LOOP_ID), "CLAUDE.md"), "utf8")
    const settings = JSON.parse(await readFile(join(loopClaudeDir(LOOP_ID), "settings.json"), "utf8"))
    expect(md.includes("TEAM_V1")).toBe(true)
    expect(settings.mcpServers.coop.url).toBe("https://v1.example/mcp")
  })

  test("admin pushes a v2 team — loop snapshot unchanged until re-composed", async () => {
    await writeTeam("# TEAM_V2_BREAKING_CHANGE", { coop: { type: "http", url: "https://v2.example/mcp" } })
    // ↑ this simulates admin git-pushing knowledge; we DO NOT call compose again.
    // session.ts only re-runs compose when the snapshot is MISSING (self-heal).
    const md = await readFile(join(loopClaudeDir(LOOP_ID), "CLAUDE.md"), "utf8")
    const settings = JSON.parse(await readFile(join(loopClaudeDir(LOOP_ID), "settings.json"), "utf8"))
    // Loop still on v1 — the v2 push is invisible to this loop
    expect(md.includes("TEAM_V1")).toBe(true)
    expect(md.includes("TEAM_V2_BREAKING_CHANGE")).toBe(false)
    expect(settings.mcpServers.coop.url).toBe("https://v1.example/mcp")
  })

  test("a NEW loop created after the admin push picks up v2", async () => {
    const NEW_LOOP = "ffffffff-1111-1111-2222-333333333333"
    await mkdir(loopWorkdir(NEW_LOOP), { recursive: true })
    await mkdir(loopClaudeDir(NEW_LOOP), { recursive: true })
    await mkdir(loopContextKnowledge(NEW_LOOP), { recursive: true })
    await mkdir(loopContextNotes(NEW_LOOP), { recursive: true })
    const plan = {
      user: USER,
      claudeSources: [
        { source: "team", dir: workspaceTeamClaudeDir() },
      ],
    }
    await composeFromPlan(NEW_LOOP, plan as any)
    const md = await readFile(join(loopClaudeDir(NEW_LOOP), "CLAUDE.md"), "utf8")
    expect(md.includes("TEAM_V2_BREAKING_CHANGE")).toBe(true)
    expect(md.includes("TEAM_V1")).toBe(false)
  })

  test("re-running compose on the OLD loop DOES regenerate (caller's choice)", async () => {
    // compose itself is idempotent by *current source state*. Snapshot freeze
    // is enforced upstream (session.ts: only compose when snapshot absent).
    // We document this here so it's not surprising.
    const plan = {
      user: USER,
      claudeSources: [
        { source: "team", dir: workspaceTeamClaudeDir() },
      ],
    }
    await composeFromPlan(LOOP_ID, plan as any)
    const md = await readFile(join(loopClaudeDir(LOOP_ID), "CLAUDE.md"), "utf8")
    // After explicit re-compose, the old loop got the v2 too. This is by design
    // — compose is a "materialize current state" op, not a "stay frozen" op.
    expect(md.includes("TEAM_V2_BREAKING_CHANGE")).toBe(true)
  })
})

describe("frozen snapshot — session.ts skip semantics (snapshot-presence guard)", () => {
  test("settings.json existence acts as the snapshot sentinel", async () => {
    // The actual gate lives in session.ts:331 — `if (!existsSync(composedSettingsPath))`.
    // We assert the file IS at the expected path after compose, so the gate sees it.
    const composedSettingsPath = join(loopClaudeDir(LOOP_ID), "settings.json")
    expect(existsSync(composedSettingsPath)).toBe(true)
  })
})
