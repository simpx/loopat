/**
 * L1: pure-function tests for parseBearerEnvName. Full OAuth flow
 * (HTTP discovery + DCR + token exchange) lives in L2.
 */
import { test, expect, describe } from "bun:test"

process.env.LOOPAT_HOME ??= `/tmp/loopat-mcp-oauth-l1-${process.pid}`

const { parseBearerEnvName } = await import("../src/mcp-oauth")

describe("parseBearerEnvName", () => {
  test("standard bearer template → captures env name", () => {
    expect(parseBearerEnvName({
      type: "http",
      url: "https://x.example/mcp",
      headers: { Authorization: "Bearer ${GH_TOKEN}" },
    } as any)).toBe("GH_TOKEN")
  })

  test("authorization header is case-insensitive", () => {
    expect(parseBearerEnvName({
      type: "http",
      url: "https://x",
      headers: { authorization: "Bearer ${X}" },
    } as any)).toBe("X")
    expect(parseBearerEnvName({
      type: "http",
      url: "https://x",
      headers: { AUTHORIZATION: "Bearer ${X}" },
    } as any)).toBe("X")
  })

  test("'Bearer' keyword is case-insensitive", () => {
    expect(parseBearerEnvName({
      type: "http",
      url: "https://x",
      headers: { Authorization: "bearer ${TOKEN}" },
    } as any)).toBe("TOKEN")
    expect(parseBearerEnvName({
      type: "http",
      url: "https://x",
      headers: { Authorization: "BEARER ${TOKEN}" },
    } as any)).toBe("TOKEN")
  })

  test("trims surrounding whitespace", () => {
    expect(parseBearerEnvName({
      type: "http",
      url: "https://x",
      headers: { Authorization: "  Bearer ${MY_TOKEN}  " },
    } as any)).toBe("MY_TOKEN")
  })

  test("rejects half-static templates (Bearer ${X}_static)", () => {
    expect(parseBearerEnvName({
      type: "http",
      url: "https://x",
      headers: { Authorization: "Bearer ${PREFIX}_suffix" },
    } as any)).toBeNull()
  })

  test("rejects multi-ref templates (Bearer ${A}${B})", () => {
    expect(parseBearerEnvName({
      type: "http",
      url: "https://x",
      headers: { Authorization: "Bearer ${A}${B}" },
    } as any)).toBeNull()
  })

  test("rejects non-Bearer schemes", () => {
    expect(parseBearerEnvName({
      type: "http",
      url: "https://x",
      headers: { Authorization: "Basic ${CREDS}" },
    } as any)).toBeNull()
    expect(parseBearerEnvName({
      type: "http",
      url: "https://x",
      headers: { Authorization: "Token ${X}" },
    } as any)).toBeNull()
  })

  test("rejects when Authorization header is missing entirely", () => {
    expect(parseBearerEnvName({
      type: "http",
      url: "https://x",
      headers: { "X-Api-Key": "${KEY}" },
    } as any)).toBeNull()
  })

  test("rejects when no headers at all", () => {
    expect(parseBearerEnvName({ type: "http", url: "https://x" } as any)).toBeNull()
  })

  test("rejects when value isn't a string", () => {
    expect(parseBearerEnvName({
      type: "http",
      url: "https://x",
      headers: { Authorization: 42 as any },
    } as any)).toBeNull()
  })

  test("rejects literal-token values (no env ref)", () => {
    expect(parseBearerEnvName({
      type: "http",
      url: "https://x",
      headers: { Authorization: "Bearer abc123" },
    } as any)).toBeNull()
  })

  test("rejects invalid env name characters", () => {
    // env var must start with letter/underscore + be uppercase[A-Z0-9_]
    expect(parseBearerEnvName({
      type: "http",
      url: "https://x",
      headers: { Authorization: "Bearer ${lowercase}" },
    } as any)).toBeNull()
    expect(parseBearerEnvName({
      type: "http",
      url: "https://x",
      headers: { Authorization: "Bearer ${1STARTS_WITH_DIGIT}" },
    } as any)).toBeNull()
  })

  test("null / undefined server returns null", () => {
    expect(parseBearerEnvName(null)).toBeNull()
    expect(parseBearerEnvName(undefined)).toBeNull()
  })

  test("stdio server (no headers) returns null", () => {
    expect(parseBearerEnvName({
      type: "stdio",
      command: "node",
      args: ["server.js"],
      env: { GITHUB_TOKEN: "${GH_TOKEN}" },
    } as any)).toBeNull()
  })
})
