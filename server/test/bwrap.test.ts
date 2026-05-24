/**
 * Regression tests for bwrap argv builder, focused on the sandbox-visibility
 * contract: every artifact in loops/<id>/.claude/ (and the SDK-passed plugin
 * paths) must be visible to the inner CC process.
 *
 * The bug these tests prevent: plugin host paths like
 * ~/.claude/plugins/marketplaces/<m>/plugins/<n> were not bound into the
 * sandbox, so the SDK's `--plugin-dir <host-path>` args resolved to nothing
 * and CC silently loaded zero plugins.
 *
 * NOTE: LOOPAT_HOME must be set BEFORE source imports (paths.ts captures it
 * at module load time). We build a fixture workspace under TEST_HOME, then
 * exercise buildBwrapArgs and assert on the argv it produced — no actual
 * bwrap exec.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

// Test home: prefer our own fixture path, but if paths.ts already captured
// a different LOOPAT_HOME (because another test file in this bun run loaded
// it first), use the captured one — paths.ts reads the env at module load,
// so a later assignment has no effect.
process.env.LOOPAT_HOME ??= `/tmp/loopat-bwrap-test-${process.pid}`
process.env.LOOPAT_NO_HOME_OVERLAY = "1"

const { buildBwrapArgs, V_LOOP_CLAUDE, V_LOOP_WORKDIR, V_CONTEXT_PERSONAL } =
  await import("../src/bwrap")
const {
  LOOPAT_HOME,
  loopWorkdir,
  loopClaudeDir,
  loopContextKnowledge,
  loopContextNotes,
  personalDir,
  LOOPAT_INSTALL_DIR,
} = await import("../src/paths")
const { homedir } = await import("node:os")
// Always align our fixture to whatever LOOPAT_HOME paths.ts actually resolved.
const TEST_HOME = LOOPAT_HOME

const LOOP_ID = "11111111-2222-3333-4444-555555555555"
const USER = "alice"

async function setupFixture() {
  await rm(TEST_HOME, { recursive: true, force: true })
  // Loop dirs
  await mkdir(loopWorkdir(LOOP_ID), { recursive: true })
  await mkdir(loopClaudeDir(LOOP_ID), { recursive: true })
  await mkdir(loopContextKnowledge(LOOP_ID), { recursive: true })
  await mkdir(loopContextNotes(LOOP_ID), { recursive: true })
  // Personal dir (with at least .loopat/ so loadPersonalConfig doesn't fail)
  await mkdir(join(personalDir(USER), ".loopat", "vaults", "default"), { recursive: true })
  await writeFile(join(personalDir(USER), ".loopat", "config.json"), "{}")
  // Pretend operator config
  await writeFile(join(TEST_HOME, "config.json"), "{}")
}

beforeAll(setupFixture)
afterAll(() => rm(TEST_HOME, { recursive: true, force: true }))

/**
 * Helper: find `--ro-bind` / `--bind` / `--ro-bind-try` / `--bind-try`
 * pairs in the argv. Returns a Map keyed by source path → list of dst paths.
 */
function collectBinds(argv: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--bind" || a === "--ro-bind" || a === "--bind-try" || a === "--ro-bind-try") {
      const src = argv[i + 1]
      const dst = argv[i + 2]
      if (!out.has(src)) out.set(src, [])
      out.get(src)!.push(dst)
      i += 2
    }
  }
  return out
}

describe("buildBwrapArgs — merged .claude visibility", () => {
  test("loops/<id>/.claude is bound at V_LOOP_CLAUDE", async () => {
    const argv = await buildBwrapArgs(LOOP_ID, USER)
    const binds = collectBinds(argv)
    expect(binds.get(loopClaudeDir(LOOP_ID))).toContain(V_LOOP_CLAUDE(LOOP_ID))
  })

  test("loops/<id>/workdir is bound at V_LOOP_WORKDIR", async () => {
    const argv = await buildBwrapArgs(LOOP_ID, USER)
    const binds = collectBinds(argv)
    expect(binds.get(loopWorkdir(LOOP_ID))).toContain(V_LOOP_WORKDIR(LOOP_ID))
  })

  test("personal/<user>/ is bound at BOTH virtual path AND host-absolute path", async () => {
    // The double-bind is required because compose.ts creates symlinks under
    // loops/<id>/.claude/skills/<name> whose targets are host-absolute paths
    // into personalDir(user). Without the host-abs re-bind, those targets
    // would not resolve inside the sandbox ($HOME is an empty overlay).
    const argv = await buildBwrapArgs(LOOP_ID, USER)
    const binds = collectBinds(argv)
    const dsts = binds.get(personalDir(USER)) ?? []
    expect(dsts).toContain(V_CONTEXT_PERSONAL)
    expect(dsts).toContain(personalDir(USER))
  })

  test("LOOPAT_INSTALL_DIR is ro-bound at host-absolute path (covers builtin loopat plugin)", async () => {
    const argv = await buildBwrapArgs(LOOP_ID, USER)
    const binds = collectBinds(argv)
    expect(binds.get(LOOPAT_INSTALL_DIR)).toContain(LOOPAT_INSTALL_DIR)
  })
})

describe("buildBwrapArgs — plugin visibility via wholesale ~/.claude/plugins/ bind", () => {
  test("~/.claude/plugins/ is ro-bound wholesale at the host-absolute path", async () => {
    // The wholesale bind is what lets the inner SDK natively resolve
    // enabledPlugins (settings.json declares specs → SDK looks up
    // installPath in ~/.claude/plugins/installed_plugins.json → loads
    // each plugin dir under ~/.claude/plugins/marketplaces|cache/).
    // Without this bind, every spec resolution would fail and CC would
    // silently load zero external plugins.
    const argv = await buildBwrapArgs(LOOP_ID, USER)
    const binds = collectBinds(argv)
    const pluginsDir = join(homedir(), ".claude", "plugins")
    expect(binds.get(pluginsDir)).toContain(pluginsDir)
  })
})

describe("buildBwrapArgs — CLAUDE_CONFIG_DIR contract", () => {
  test("CLAUDE.md / skills/ / agents/ in loops/<id>/.claude/ are reachable via the V_LOOP_CLAUDE bind", async () => {
    // CC's user-tier auto-loads $CLAUDE_CONFIG_DIR/{CLAUDE.md,skills,agents}.
    // session.ts sets CLAUDE_CONFIG_DIR = V_LOOP_CLAUDE(loopId). So as long as
    // V_LOOP_CLAUDE is bound to the loop's merged .claude dir, all three
    // artifacts are visible. This test pins that wiring.
    const argv = await buildBwrapArgs(LOOP_ID, USER)
    const binds = collectBinds(argv)
    expect(binds.get(loopClaudeDir(LOOP_ID))).toContain(V_LOOP_CLAUDE(LOOP_ID))
    // The bind must be writable (--bind), not --ro-bind — CC writes session
    // state under .claude/ during runtime.
    let foundRw = false
    for (let i = 0; i < argv.length - 2; i++) {
      if (argv[i] === "--bind" && argv[i + 1] === loopClaudeDir(LOOP_ID) && argv[i + 2] === V_LOOP_CLAUDE(LOOP_ID)) {
        foundRw = true
        break
      }
    }
    expect(foundRw).toBe(true)
  })
})
