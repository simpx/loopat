/**
 * L1: pure-function tests for the env-var-name derivation. Full OAuth flow
 * (HTTP discovery + DCR + token exchange) lives in L2.
 */
import { test, expect, describe } from "bun:test"

process.env.LOOPAT_HOME ??= `/tmp/loopat-mcp-oauth-l1-${process.pid}`

const { mcpServerEnvVarName } = await import("../src/mcp-oauth")

describe("mcpServerEnvVarName", () => {
  test("simple lowercase name → MCP_<UPPER>_TOKEN", () => {
    expect(mcpServerEnvVarName("github")).toBe("MCP_GITHUB_TOKEN")
    expect(mcpServerEnvVarName("coop")).toBe("MCP_COOP_TOKEN")
  })

  test("hyphenated name → underscore", () => {
    expect(mcpServerEnvVarName("aone-ci")).toBe("MCP_AONE_CI_TOKEN")
    expect(mcpServerEnvVarName("linear-mcp")).toBe("MCP_LINEAR_MCP_TOKEN")
  })

  test("name with spaces → underscore", () => {
    expect(mcpServerEnvVarName("Google Drive")).toBe("MCP_GOOGLE_DRIVE_TOKEN")
  })

  test("name with dots → underscore", () => {
    expect(mcpServerEnvVarName("foo.bar")).toBe("MCP_FOO_BAR_TOKEN")
  })

  test("trims leading/trailing separators from sanitized portion", () => {
    expect(mcpServerEnvVarName("-foo-")).toBe("MCP_FOO_TOKEN")
    expect(mcpServerEnvVarName("...x...")).toBe("MCP_X_TOKEN")
  })

  test("all-junk name → MCP_SERVER_TOKEN fallback", () => {
    expect(mcpServerEnvVarName("---")).toBe("MCP_SERVER_TOKEN")
  })

  test("collisions are documented (irreversible mapping)", () => {
    // These all collapse to the same env var name. The system tolerates this:
    // the mapping is human-readable, not crypto-unique.
    expect(mcpServerEnvVarName("foo-bar")).toBe(mcpServerEnvVarName("foo_bar"))
    expect(mcpServerEnvVarName("foo bar")).toBe(mcpServerEnvVarName("foo-bar"))
  })
})
