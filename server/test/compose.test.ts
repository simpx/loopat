/**
 * Tests for sandbox extends + loop compose pipeline.
 *
 * Covers:
 *   - resolveSandboxChain (cycles, depth cap, multi-level)
 *   - resolveLoopPlugins (builtin always, sandbox plugins, chain union + child-wins)
 *   - loadSandboxClaudeJson (mcpServers + extraKnownMarketplaces chain merge)
 *   - composeSandboxDoctrine (concat order, missing files, idempotent cleanup)
 *   - snapshotSandboxIntoLoop (mise.toml/lock/json fallback up the chain)
 *   - createLoop integration: full materialized loop dir
 *
 * IMPORTANT: LOOPAT_HOME must be set BEFORE the source modules are imported
 * because paths.ts reads it at module load time. Tests then build fixture
 * sandboxes under that home; afterAll wipes it.
 */
import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test"
import { mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

const TEST_HOME = `/tmp/loopat-compose-test-${process.pid}`
process.env.LOOPAT_HOME = TEST_HOME

// Source imports happen AFTER LOOPAT_HOME is set so paths.ts captures it.
const { resolveSandboxChain } = await import("../src/sandboxes")
const { resolveLoopPlugins } = await import("../src/plugin-installer")
const { loadSandboxClaudeJson } = await import("../src/config")
const { composeLoopClaudeConfig } = await import("../src/compose")
const { createLoop } = await import("../src/loops")
const {
  workspaceLoopatSandboxDir,
  workspaceLoopatSandboxesDir,
  workspaceLoopatSandboxPath,
  workspaceLoopatSandboxMetaPath,
  loopClaudeDir,
  loopSandboxPath,
  loopWorkdir,
  TEMPLATES_DIR,
} = await import("../src/paths")

// ── fixture helpers ─────────────────────────────────────────────────────────

type SandboxSpec = {
  /** extends field for sandbox.json */
  extendsName?: string
  /** mise.toml content (omit = no file) */
  miseToml?: string
  /** CLAUDE.md content (omit = no file) */
  claudeMd?: string
  /** mcpServers — written to .claude/.claude.json */
  mcpServers?: Record<string, { type: string; url: string }>
  /** extraKnownMarketplaces — written to .claude/.claude.json (kept here for
   *  test simplicity even though CC normally writes it to settings.json). */
  extraKnownMarketplaces?: Record<string, any>
  /** Plugins (name@market → version) — sets up .claude/plugins/installed_plugins.json
   *  and creates dummy installPath dirs so resolver's existsSync passes. */
  plugins?: Record<string, string>
}

/** Build a fixture sandbox at TEST_HOME/context/knowledge/.loopat/sandboxes/<name>/. */
async function makeSandbox(name: string, spec: SandboxSpec = {}): Promise<void> {
  const dir = workspaceLoopatSandboxDir(name)
  await mkdir(dir, { recursive: true })
  // sandbox.json
  const meta: any = { shell: "bash" }
  if (spec.extendsName) meta.extends = spec.extendsName
  await writeFile(workspaceLoopatSandboxMetaPath(name), JSON.stringify(meta))
  // mise.toml
  if (spec.miseToml !== undefined) {
    await writeFile(workspaceLoopatSandboxPath(name), spec.miseToml)
  }
  // CLAUDE.md
  if (spec.claudeMd !== undefined) {
    await writeFile(join(dir, "CLAUDE.md"), spec.claudeMd)
  }
  // .claude/.claude.json (mcpServers + extraKnownMarketplaces)
  if (spec.mcpServers || spec.extraKnownMarketplaces) {
    await mkdir(join(dir, ".claude"), { recursive: true })
    const claudeJson: any = {}
    if (spec.mcpServers) claudeJson.mcpServers = spec.mcpServers
    if (spec.extraKnownMarketplaces) claudeJson.extraKnownMarketplaces = spec.extraKnownMarketplaces
    await writeFile(join(dir, ".claude", ".claude.json"), JSON.stringify(claudeJson))
  }
  // installed_plugins.json + fake plugin install dirs (resolver checks existsSync)
  if (spec.plugins) {
    const pluginsDir = join(dir, ".claude", "plugins")
    await mkdir(pluginsDir, { recursive: true })
    const ip: any = { version: 2, plugins: {} }
    for (const [key, version] of Object.entries(spec.plugins)) {
      const [pluginName, marketName] = key.split("@")
      const installPath = join(pluginsDir, "cache", marketName, pluginName, version)
      await mkdir(installPath, { recursive: true })
      // Drop a marker so the dir's not pretending to be empty.
      await writeFile(join(installPath, "marker"), key)
      ip.plugins[key] = [{ installPath, version, gitCommitSha: "fake" + key }]
    }
    await writeFile(join(pluginsDir, "installed_plugins.json"), JSON.stringify(ip))
  }
}

// ── lifecycle ──────────────────────────────────────────────────────────────

beforeAll(async () => {
  await rm(TEST_HOME, { recursive: true, force: true })
  await mkdir(workspaceLoopatSandboxesDir(), { recursive: true })
  // Base dirs the resolver / createLoop touch.
  await mkdir(`${TEST_HOME}/loops`, { recursive: true })
  await mkdir(`${TEST_HOME}/context/knowledge/.loopat/claude/skills`, { recursive: true })
  await mkdir(`${TEST_HOME}/context/knowledge/.loopat/claude/agents`, { recursive: true })
  await mkdir(`${TEST_HOME}/context/notes`, { recursive: true })
  await mkdir(`${TEST_HOME}/personal/testuser/.loopat/claude/skills`, { recursive: true })
  // Pre-write workspace config so loadConfig() doesn't lazy-create the
  // default template (which lists simpx/loopat as a repo to auto-clone —
  // would hang the test on git network IO).
  await writeFile(`${TEST_HOME}/config.json`, JSON.stringify({
    providers: {},
    knowledge: { git: "" },
    notes: { git: "" },
    repos: [],
  }))
})

afterEach(async () => {
  // Clear sandboxes between tests so names don't collide across describes.
  await rm(workspaceLoopatSandboxesDir(), { recursive: true, force: true })
  await mkdir(workspaceLoopatSandboxesDir(), { recursive: true })
})

afterAll(async () => {
  await rm(TEST_HOME, { recursive: true, force: true })
})

// ── resolveSandboxChain ────────────────────────────────────────────────────

describe("resolveSandboxChain", () => {
  test("single sandbox without extends → 1-element chain", async () => {
    await makeSandbox("solo")
    expect(await resolveSandboxChain("solo")).toEqual(["solo"])
  })

  test("2-level: child → parent, returned oldest-first", async () => {
    await makeSandbox("parent")
    await makeSandbox("child", { extendsName: "parent" })
    expect(await resolveSandboxChain("child")).toEqual(["parent", "child"])
  })

  test("3-level: grandparent → parent → child", async () => {
    await makeSandbox("gp")
    await makeSandbox("p", { extendsName: "gp" })
    await makeSandbox("c", { extendsName: "p" })
    expect(await resolveSandboxChain("c")).toEqual(["gp", "p", "c"])
  })

  test("self-loop is detected, chain stops at self", async () => {
    await makeSandbox("self", { extendsName: "self" })
    expect(await resolveSandboxChain("self")).toEqual(["self"])
  })

  test("mutual cycle (a→b→a) is detected", async () => {
    await makeSandbox("a", { extendsName: "b" })
    await makeSandbox("b", { extendsName: "a" })
    const chain = await resolveSandboxChain("a")
    // Both names appear once; no infinite loop.
    expect(chain.length).toBe(2)
    expect(new Set(chain)).toEqual(new Set(["a", "b"]))
  })

  test("depth limit (5): 7-deep chain truncates", async () => {
    for (let i = 0; i < 7; i++) {
      await makeSandbox(`d${i}`, i === 0 ? {} : { extendsName: `d${i - 1}` })
    }
    const chain = await resolveSandboxChain("d6")
    expect(chain.length).toBeLessThanOrEqual(5)
  })

  test("invalid extends target (bad name) stops the walk", async () => {
    await makeSandbox("ok", { extendsName: "../escape" })
    expect(await resolveSandboxChain("ok")).toEqual(["ok"])
  })

  test("dangling extends (parent dir doesn't exist) is tolerated", async () => {
    await makeSandbox("orphan", { extendsName: "nonexistent" })
    // Chain walks until readSandboxMeta returns null. Both names appear
    // (oldest-first). Downstream readers skip missing files gracefully —
    // admin error doesn't crash the resolver.
    const chain = await resolveSandboxChain("orphan")
    expect(chain).toEqual(["nonexistent", "orphan"])
  })
})

// ── resolveLoopPlugins ─────────────────────────────────────────────────────

describe("resolveLoopPlugins", () => {
  test("no sandbox → builtin loopat only", async () => {
    const plugins = await resolveLoopPlugins(undefined)
    expect(plugins).toHaveLength(1)
    expect(plugins[0].name).toBe("loopat@builtin")
    expect(plugins[0].path).toBe(join(TEMPLATES_DIR, "plugins", "loopat"))
  })

  test("sandbox with plugins: builtin + sandbox", async () => {
    await makeSandbox("with-plugins", {
      plugins: { "foo@m1": "1.0.0", "bar@m2": "2.0.0" },
    })
    const plugins = await resolveLoopPlugins("with-plugins")
    const names = plugins.map((p) => p.name).sort()
    expect(names).toEqual(["bar@m2", "foo@m1", "loopat@builtin"])
  })

  test("extends: child adds plugins, parent's also included", async () => {
    await makeSandbox("base-p", { plugins: { "a@m1": "1.0.0" } })
    await makeSandbox("ext-p", { extendsName: "base-p", plugins: { "b@m1": "1.0.0" } })
    const plugins = await resolveLoopPlugins("ext-p")
    const names = plugins.map((p) => p.name).sort()
    expect(names).toEqual(["a@m1", "b@m1", "loopat@builtin"])
  })

  test("extends: child overrides parent with same name@market (child path wins)", async () => {
    await makeSandbox("parent-ovr", { plugins: { "foo@m1": "1.0.0" } })
    await makeSandbox("child-ovr", { extendsName: "parent-ovr", plugins: { "foo@m1": "2.0.0" } })
    const plugins = await resolveLoopPlugins("child-ovr")
    const foo = plugins.find((p) => p.name === "foo@m1")!
    expect(foo.path).toContain("/2.0.0") // child's version dir, not parent's 1.0.0
  })

  test("3-level: grandparent contributes too", async () => {
    await makeSandbox("gp-p", { plugins: { "a@m": "1" } })
    await makeSandbox("p-p", { extendsName: "gp-p", plugins: { "b@m": "1" } })
    await makeSandbox("c-p", { extendsName: "p-p", plugins: { "c@m": "1" } })
    const plugins = await resolveLoopPlugins("c-p")
    const names = plugins.map((p) => p.name).sort()
    expect(names).toEqual(["a@m", "b@m", "c@m", "loopat@builtin"])
  })

  test("missing installPath warns and is skipped", async () => {
    await makeSandbox("broken", { plugins: { "ok@m": "1" } })
    // Manually corrupt installed_plugins.json with bad path
    const ipPath = join(workspaceLoopatSandboxDir("broken"), ".claude", "plugins", "installed_plugins.json")
    const ip = JSON.parse(await readFile(ipPath, "utf8"))
    ip.plugins["ghost@m"] = [{ installPath: "/nonexistent/abc", version: "x", gitCommitSha: "x" }]
    await writeFile(ipPath, JSON.stringify(ip))
    const plugins = await resolveLoopPlugins("broken")
    expect(plugins.map((p) => p.name).sort()).toEqual(["loopat@builtin", "ok@m"])
  })

  test("sandbox with no plugins file → just builtin", async () => {
    await makeSandbox("empty-p")
    const plugins = await resolveLoopPlugins("empty-p")
    expect(plugins.map((p) => p.name)).toEqual(["loopat@builtin"])
  })
})

// ── loadSandboxClaudeJson (mcpServers + extraKnownMarketplaces merge) ──────

describe("loadSandboxClaudeJson", () => {
  test("no sandbox name → empty", async () => {
    const r = await loadSandboxClaudeJson(undefined)
    expect(r).toEqual({})
  })

  test("single sandbox mcpServers passthrough", async () => {
    await makeSandbox("solo-mcp", {
      mcpServers: { foo: { type: "http", url: "https://foo" } },
    })
    const r = await loadSandboxClaudeJson("solo-mcp")
    expect(r.mcpServers).toEqual({ foo: { type: "http", url: "https://foo" } })
  })

  test("extends: child adds new mcp server, parent's preserved", async () => {
    await makeSandbox("base-mcp", { mcpServers: { p1: { type: "http", url: "https://p1" } } })
    await makeSandbox("ext-mcp", {
      extendsName: "base-mcp",
      mcpServers: { c1: { type: "http", url: "https://c1" } },
    })
    const r = await loadSandboxClaudeJson("ext-mcp")
    expect(Object.keys(r.mcpServers!).sort()).toEqual(["c1", "p1"])
  })

  test("extends: child overrides parent same-name server (child URL wins)", async () => {
    await makeSandbox("ovr-base", { mcpServers: { foo: { type: "http", url: "https://parent" } } })
    await makeSandbox("ovr-child", {
      extendsName: "ovr-base",
      mcpServers: { foo: { type: "http", url: "https://child" } },
    })
    const r = await loadSandboxClaudeJson("ovr-child")
    expect((r.mcpServers!.foo as any).url).toBe("https://child")
  })

  test("extraKnownMarketplaces merge by key", async () => {
    await makeSandbox("base-mp", { extraKnownMarketplaces: { mp1: { source: { source: "git", url: "u1" } } } })
    await makeSandbox("ext-mp", {
      extendsName: "base-mp",
      extraKnownMarketplaces: { mp2: { source: { source: "github", repo: "x/y" } } },
    })
    const r = await loadSandboxClaudeJson("ext-mp")
    expect(Object.keys(r.extraKnownMarketplaces!).sort()).toEqual(["mp1", "mp2"])
  })

  test("3-level: all ancestors contribute", async () => {
    await makeSandbox("gp-mcp", { mcpServers: { gp: { type: "http", url: "u-gp" } } })
    await makeSandbox("p-mcp", { extendsName: "gp-mcp", mcpServers: { p: { type: "http", url: "u-p" } } })
    await makeSandbox("c-mcp", { extendsName: "p-mcp", mcpServers: { c: { type: "http", url: "u-c" } } })
    const r = await loadSandboxClaudeJson("c-mcp")
    expect(Object.keys(r.mcpServers!).sort()).toEqual(["c", "gp", "p"])
  })
})

// ── composeSandboxDoctrine (via composeLoopClaudeConfig) ───────────────────

describe("composeSandboxDoctrine", () => {
  /** Set up a fake loop dir + run compose; return loop's .claude/CLAUDE.md path. */
  async function composeFor(sandboxName: string | undefined): Promise<string> {
    const loopId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await mkdir(loopClaudeDir(loopId), { recursive: true })
    await composeLoopClaudeConfig(loopId, "testuser", sandboxName)
    return join(loopClaudeDir(loopId), "CLAUDE.md")
  }

  test("single sandbox CLAUDE.md → written verbatim", async () => {
    await makeSandbox("doc-solo", { claudeMd: "# Doc\nSolo content." })
    const dst = await composeFor("doc-solo")
    expect(existsSync(dst)).toBe(true)
    const content = await readFile(dst, "utf8")
    expect(content.trim()).toBe("# Doc\nSolo content.")
  })

  test("parent → child concat with separator", async () => {
    await makeSandbox("doc-p", { claudeMd: "Parent rules." })
    await makeSandbox("doc-c", { extendsName: "doc-p", claudeMd: "Child rules." })
    const dst = await composeFor("doc-c")
    const content = await readFile(dst, "utf8")
    expect(content).toContain("Parent rules.")
    expect(content).toContain("Child rules.")
    // Parent comes first.
    expect(content.indexOf("Parent")).toBeLessThan(content.indexOf("Child"))
    // Separator present.
    expect(content).toContain("\n\n---\n\n")
  })

  test("only parent has CLAUDE.md → parent only", async () => {
    await makeSandbox("only-p", { claudeMd: "Parent only." })
    await makeSandbox("no-c", { extendsName: "only-p" })
    const dst = await composeFor("no-c")
    expect((await readFile(dst, "utf8")).trim()).toBe("Parent only.")
  })

  test("only child has CLAUDE.md → child only", async () => {
    await makeSandbox("no-p")
    await makeSandbox("only-c", { extendsName: "no-p", claudeMd: "Child only." })
    const dst = await composeFor("only-c")
    expect((await readFile(dst, "utf8")).trim()).toBe("Child only.")
  })

  test("neither has CLAUDE.md → no file written", async () => {
    await makeSandbox("no-doc")
    const dst = await composeFor("no-doc")
    expect(existsSync(dst)).toBe(false)
  })

  test("no sandbox → no file written + stale file removed", async () => {
    // First compose with a sandbox to write the file
    await makeSandbox("had-doc", { claudeMd: "old" })
    const loopId = `cleanup-${Date.now()}`
    await mkdir(loopClaudeDir(loopId), { recursive: true })
    await composeLoopClaudeConfig(loopId, "testuser", "had-doc")
    const dst = join(loopClaudeDir(loopId), "CLAUDE.md")
    expect(existsSync(dst)).toBe(true)
    // Re-compose without sandbox → file should be removed (idempotent cleanup)
    await composeLoopClaudeConfig(loopId, "testuser", undefined)
    expect(existsSync(dst)).toBe(false)
  })

  test("3-level concat: order is gp → p → c", async () => {
    await makeSandbox("gp-doc", { claudeMd: "GP." })
    await makeSandbox("p-doc", { extendsName: "gp-doc", claudeMd: "P." })
    await makeSandbox("c-doc", { extendsName: "p-doc", claudeMd: "C." })
    const dst = await composeFor("c-doc")
    const content = await readFile(dst, "utf8")
    const gpIdx = content.indexOf("GP.")
    const pIdx = content.indexOf("P.")
    const cIdx = content.indexOf("C.")
    expect(gpIdx).toBeLessThan(pIdx)
    expect(pIdx).toBeLessThan(cIdx)
  })
})

// ── createLoop integration: full materialized loop dir ────────────────────

describe("createLoop integration", () => {
  test("loop with sandbox: composed CLAUDE.md + plugins + mise.toml snapshot", async () => {
    await makeSandbox("integ-base", {
      claudeMd: "Common doctrine.",
      miseToml: "[tools]\nnode = '20'\n",
      mcpServers: { coop: { type: "http", url: "https://coop" } },
      plugins: { "p1@m1": "1.0.0" },
    })
    await makeSandbox("integ-child", {
      extendsName: "integ-base",
      claudeMd: "Child rules.",
      plugins: { "p2@m1": "1.0.0" },
    })
    const loop = await createLoop({
      title: "integ test",
      createdBy: "testuser",
      sandbox: "integ-child",
    })
    // CLAUDE.md was composed
    const doctrine = await readFile(join(loopClaudeDir(loop.id), "CLAUDE.md"), "utf8")
    expect(doctrine).toContain("Common doctrine.")
    expect(doctrine).toContain("Child rules.")
    // mise.toml: child has its own, but in this test only base has one → falls back to base
    expect(await readFile(loopSandboxPath(loop.id), "utf8")).toContain("node = '20'")
    // workdir created
    expect(existsSync(loopWorkdir(loop.id))).toBe(true)
    // meta records sandbox
    expect(loop.config?.sandbox).toBe("integ-child")
    // resolved plugins reflect the chain
    const plugins = await resolveLoopPlugins(loop.config?.sandbox)
    const names = plugins.map((p) => p.name).sort()
    expect(names).toEqual(["loopat@builtin", "p1@m1", "p2@m1"])
    // mcp servers reflect chain
    const claudeJson = await loadSandboxClaudeJson(loop.config?.sandbox)
    expect(Object.keys(claudeJson.mcpServers!)).toContain("coop")
  })

  test("loop without sandbox: only builtin plugin, no doctrine", async () => {
    const loop = await createLoop({ title: "no-sandbox", createdBy: "testuser" })
    expect(loop.config?.sandbox).toBeUndefined()
    expect(existsSync(join(loopClaudeDir(loop.id), "CLAUDE.md"))).toBe(false)
    const plugins = await resolveLoopPlugins(loop.config?.sandbox)
    expect(plugins.map((p) => p.name)).toEqual(["loopat@builtin"])
  })

  test("mise.toml falls back to parent when child lacks it", async () => {
    await makeSandbox("mise-base", { miseToml: "[tools]\npython = '3.12'\n" })
    await makeSandbox("mise-child", { extendsName: "mise-base" }) // no own mise.toml
    const loop = await createLoop({
      title: "mise-fallback",
      createdBy: "testuser",
      sandbox: "mise-child",
    })
    const content = await readFile(loopSandboxPath(loop.id), "utf8")
    expect(content).toContain("python = '3.12'")
  })
})
