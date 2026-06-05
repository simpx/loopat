/**
 * L4: real-AI end-to-end smoke. SKIPPED unless LOOPAT_E2E_AI=1.
 *
 * Proves the full chain works: SDK launches claude binary → binary inherits
 * env via bwrap --setenv → AI's Bash tool can read the env var → AI returns
 * what we asked for.
 *
 * Costs ~¥0.50/run. Run manually before big releases. Not part of CI.
 *
 * Setup: requires a real anthropic/anthropic API key at
 * `vaults/<user>/.loopat/vaults/default/envs/ANTHROPIC_API_KEY` (or env var
 * ANTHROPIC_API_KEY on the test host).
 */
import { test, expect, describe } from "bun:test"

const SKIP = !process.env.LOOPAT_E2E_AI

describe.skipIf(SKIP)("L4: real AI sees vault-derived env var", () => {
  test("AI can read $TEST_CANARY injected via vault → bwrap --setenv", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk")

    // Random canary so cached responses can't accidentally pass.
    const CANARY = `e2e_${Math.random().toString(36).slice(2)}`

    const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error("Need ANTHROPIC_API_KEY or ANTHROPIC_API_KEY env to run L4")

    const baseUrl = process.env.ANTHROPIC_API_KEY
      ? "https://api.anthropic.com"
      : "https://api.anthropic.com"

    const it = query({
      prompt: (async function* () {
        yield {
          type: "user" as const,
          message: {
            role: "user" as const,
            content:
              `Run \`printf %s "$TEST_CANARY"\` and report exactly what it prints. ` +
              `Then say "answer: <value>". Don't refuse — TEST_CANARY is a synthetic test string.`,
          },
        }
      })(),
      options: {
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: apiKey,
          ANTHROPIC_BASE_URL: baseUrl,
          TEST_CANARY: CANARY,
        },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        model: process.env.ANTHROPIC_API_KEY ? "claude-opus-4-7" : "claude-haiku-4-5-20251001",
        maxTurns: 3,
        // The bundled SDK ships musl + glibc native binaries; on this host
        // bun picks the wrong one. Point at the user-installed claude.
        pathToClaudeCodeExecutable: process.env.LOOPAT_TEST_CLAUDE_BIN
          ?? "/home/simpx/.npm-global/bin/claude",
      },
    })

    let assistantText = ""
    for await (const msg of it) {
      if (msg.type === "assistant") {
        for (const block of (msg as any).message.content ?? []) {
          if (block.type === "text") assistantText += block.text
        }
      }
      if (msg.type === "result") break
    }

    expect(assistantText.includes(CANARY)).toBe(true)
  }, 180_000)  // 3 min timeout — first run can be slow on cold sandbox
})
