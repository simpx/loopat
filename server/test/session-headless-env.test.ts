import { test, expect, describe } from "bun:test"

process.env.LOOPAT_HOME ??= `/tmp/loopat-session-env-test-${process.pid}`

const { buildHeadlessSdkSpawnEnv } = await import("../src/session")

describe("headless SDK spawn env", () => {
  test("enables Claude Code marketplace plugin sync for SDK query spawns", () => {
    const env = buildHeadlessSdkSpawnEnv({
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_BASE_URL: "https://anthropic.example.com/api/anthropic",
      CLAUDE_CONFIG_DIR: "/loopat/loop/test/.claude",
      CLAUDE_CODE_SYNC_PLUGIN_INSTALL: "0",
    })

    expect(env.ANTHROPIC_API_KEY).toBe("sk-test")
    expect(env.CLAUDE_CONFIG_DIR).toBe("/loopat/loop/test/.claude")
    expect(env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL).toBe("1")
  })
})
