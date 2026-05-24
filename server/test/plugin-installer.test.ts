/**
 * Tests for plugin-installer's host-side helpers — `sourcesMatch` (marketplace
 * URL drift detection) and `lookupPluginInstallPath` (spec → host path
 * resolution used by slash-command pre-seed, loop-stats, and mcp-oauth).
 *
 * Note: ensureLoopPluginsInstalled is intentionally NOT covered here — it
 * shells out to the host `claude plugin install` CLI, which would either be
 * slow or require a CC binary in the test environment. The end-to-end
 * behavior is exercised by manually running a loop with plugins enabled.
 */
import { test, expect, describe } from "bun:test"

// paths.ts captures LOOPAT_HOME at module load. If another test file in this
// run loaded it first, our assignment here is a no-op — but plugin-installer
// itself doesn't touch LOOPAT_HOME, so collisions are harmless.
process.env.LOOPAT_HOME ??= `/tmp/loopat-plugin-test-${process.pid}`

const { sourcesMatch, lookupPluginInstallPath, BUILTIN_LOOPAT_PLUGIN_PATH } =
  await import("../src/plugin-installer")

// ─── sourcesMatch ────────────────────────────────────────────────────────

describe("sourcesMatch — marketplace source equivalence", () => {
  test("identical objects match", () => {
    const a = { source: "git", url: "git@example.com:team/mp.git" }
    expect(sourcesMatch(a, a)).toBe(true)
  })

  test("git sources match on url, ignore other fields", () => {
    expect(
      sourcesMatch(
        { source: "git", url: "git@a.com:x/y.git" },
        { source: "git", url: "git@a.com:x/y.git", lastUpdated: 12345 },
      ),
    ).toBe(true)
  })

  test("github source matches on repo or repository", () => {
    expect(
      sourcesMatch(
        { source: "github", repo: "anthropics/claude-for-legal" },
        { source: "github", repository: "anthropics/claude-for-legal" },
      ),
    ).toBe(true)
  })

  test("git URL drift fails the match (used to trigger re-register)", () => {
    expect(
      sourcesMatch(
        { source: "git", url: "git@old.example:team/mp.git" },
        { source: "git", url: "git@new.example:team/mp.git" },
      ),
    ).toBe(false)
  })

  test("different source type fails the match", () => {
    expect(
      sourcesMatch(
        { source: "git", url: "x" },
        { source: "github", repo: "x/y" },
      ),
    ).toBe(false)
  })

  test("asymmetric null / undefined fails the match", () => {
    expect(sourcesMatch(null, { source: "git", url: "x" })).toBe(false)
    expect(sourcesMatch({ source: "git", url: "x" }, undefined)).toBe(false)
  })

  test("both undefined is trivially a match — no drift to detect", () => {
    // If both sides are missing, neither side declared anything, so there's
    // nothing to re-register. The caller treats true as "stay put".
    expect(sourcesMatch(undefined, undefined)).toBe(true)
  })
})

// ─── lookupPluginInstallPath ─────────────────────────────────────────────

describe("lookupPluginInstallPath — resolve spec → host path", () => {
  // We don't try to mock homedir — the function reads ~/.claude/plugins/.
  // Instead we use a spec name no real marketplace could provide; if the
  // host's CC happens to know that exact name, that's an environment bug,
  // not a test bug.
  const FAKE_SPEC = "this-plugin-cannot-possibly-exist@xyzzy-test-marketplace"

  test("returns null when host has no CC plugin cache for the spec", async () => {
    const result = await lookupPluginInstallPath(FAKE_SPEC)
    expect(result).toBeNull()
  })

  test("returns null when spec is malformed", async () => {
    const result = await lookupPluginInstallPath("no-at-sign-here")
    // No "@" in the spec — function still tries to look up; result depends
    // on host CC state but should never throw. Most likely null.
    expect(result === null || typeof result === "string").toBe(true)
  })

  test("BUILTIN_LOOPAT_PLUGIN_PATH is exported and points under LOOPAT_INSTALL_DIR", () => {
    // The builtin's location is the one plugin that is NOT in ~/.claude/plugins/
    // — it ships with loopat itself. The session.ts spawn passes this via the
    // `plugins:` SDK option (everything else goes via enabledPlugins +
    // wholesale bind).
    expect(typeof BUILTIN_LOOPAT_PLUGIN_PATH).toBe("string")
    expect(BUILTIN_LOOPAT_PLUGIN_PATH.length).toBeGreaterThan(0)
    expect(BUILTIN_LOOPAT_PLUGIN_PATH).toContain("templates")
    expect(BUILTIN_LOOPAT_PLUGIN_PATH).toContain("plugins")
    expect(BUILTIN_LOOPAT_PLUGIN_PATH).toContain("loopat")
  })
})
