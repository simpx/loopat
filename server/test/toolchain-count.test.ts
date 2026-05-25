/**
 * L1+L3: toolchainCount — count tools declared in mise.toml.
 *
 * Each top-level key under [tools] counts as one (bare like `python = "3.12"`
 * or nested like `[tools."http:a1"]`). Missing/malformed file → 0.
 *
 * Display sites assert presence in:
 *   - NewLoopDialog footer (LoopStats.toolchain via /api/loop-stats)
 *   - ClaudeConfigPanel StatChip (TierInfo.toolchainCount via /api/tiers)
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

process.env.LOOPAT_HOME ??= `/tmp/loopat-toolchain-${process.pid}`
const { countToolchainTools, computeLoopStats } = await import("../src/loop-stats")
const {
  LOOPAT_HOME,
  workspaceTeamClaudeDir,
  workspaceProfileClaudeDir,
} = await import("../src/paths")
const TEST_HOME = LOOPAT_HOME

async function reset() { await rm(TEST_HOME, { recursive: true, force: true }) }

beforeAll(reset)
afterAll(() => rm(TEST_HOME, { recursive: true, force: true }))

describe("countToolchainTools", () => {
  test("returns [] when mise.toml missing", () => {
    expect(countToolchainTools("/tmp/nope-" + Math.random())).toEqual([])
  })

  test("counts bare-key entries: `name = \"version\"`", async () => {
    const dir = join(TEST_HOME, "fixture-bare")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "mise.toml"), `[tools]
python = "3.12"
bun = "latest"
gh = "latest"
`)
    expect(countToolchainTools(dir).sort()).toEqual(["bun", "gh", "python"])
  })

  test("counts nested [tools.<name>] sections", async () => {
    const dir = join(TEST_HOME, "fixture-nested")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "mise.toml"), `[tools]
node = "20"

[tools."http:a1"]
version = "0.1.87"

[tools."http:dashctl"]
version = "v0.4.3"
`)
    expect(countToolchainTools(dir).sort()).toEqual(["http:a1", "http:dashctl", "node"])
  })

  test("counts quoted-key bare entries (ubi:..., http:..., etc.)", async () => {
    const dir = join(TEST_HOME, "fixture-quoted")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "mise.toml"), `[tools]
"ubi:fish-shell/fish-shell" = { version = "latest", exe = "fish" }
jq = "latest"
`)
    expect(countToolchainTools(dir).sort()).toEqual(["jq", "ubi:fish-shell/fish-shell"])
  })

  test("empty [tools] → []", async () => {
    const dir = join(TEST_HOME, "fixture-empty")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "mise.toml"), `[tools]\n`)
    expect(countToolchainTools(dir)).toEqual([])
  })

  test("no [tools] section at all → []", async () => {
    const dir = join(TEST_HOME, "fixture-no-tools")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "mise.toml"), `[env]\nFOO = "bar"\n`)
    expect(countToolchainTools(dir)).toEqual([])
  })

  test("malformed toml → [] (no throw)", async () => {
    const dir = join(TEST_HOME, "fixture-bad")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "mise.toml"), `not valid toml [[[\n`)
    expect(countToolchainTools(dir)).toEqual([])
  })
})

describe("computeLoopStats — toolchain field", () => {
  beforeAll(async () => {
    await reset()
    // Team has 3 tools: python, bun, gh
    await mkdir(workspaceTeamClaudeDir(), { recursive: true })
    await writeFile(join(workspaceTeamClaudeDir(), "mise.toml"), `[tools]
python = "3.12"
bun = "latest"
gh = "latest"
`)
    // Profile A adds 2 new tools: jq, uv (deduped: 5 total)
    await mkdir(workspaceProfileClaudeDir("a"), { recursive: true })
    await writeFile(join(workspaceProfileClaudeDir("a"), "mise.toml"), `[tools]
jq = "latest"
uv = "latest"
`)
    // Profile B overrides bun + adds node (deduped: 1 new = 6 total when both selected)
    await mkdir(workspaceProfileClaudeDir("b"), { recursive: true })
    await writeFile(join(workspaceProfileClaudeDir("b"), "mise.toml"), `[tools]
bun = "1.0.0"
node = "20"
`)
  })

  test("team-only → 3 toolchain", async () => {
    const stats = await computeLoopStats([])
    expect(stats.toolchain).toBe(3)
  })

  test("team + profile A → 5 (3 + 2 new)", async () => {
    const stats = await computeLoopStats(["a"])
    expect(stats.toolchain).toBe(5)
  })

  test("team + profile A + profile B → 6 (3 team + 2 A + 1 new from B; bun is shared)", async () => {
    const stats = await computeLoopStats(["a", "b"])
    // python, bun, gh, jq, uv, node = 6 distinct
    expect(stats.toolchain).toBe(6)
  })

  test("team + profile B only → 4 (3 + 1 new; bun is overridden but same key)", async () => {
    const stats = await computeLoopStats(["b"])
    // python, bun, gh, node = 4 (bun dedupes with team's bun)
    expect(stats.toolchain).toBe(4)
  })
})
