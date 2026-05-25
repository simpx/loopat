/**
 * L1+L2: provider resolution chain.
 *
 * Priority order (mirrors session.ts pickProvider):
 *   1. explicit candidates (WS override, loop.meta.config.default_model)
 *   2. personal config's `default` field
 *   3. workspace config's `default` field
 *   4. enumeration (personal first, then workspace)
 *
 * `requireKey=true` skips providers with empty apiKey.
 *
 * The "user sets default in their personal config" flow is the common case.
 * "Workspace provides a fallback" supports admins seeding a shared provider
 * for new users without forcing them to configure their own. "Switching
 * provider mid-loop" is restart-session driven (covered in lifecycle).
 */
import { test, expect, describe } from "bun:test"
import type { ProviderConfig } from "../src/config"

process.env.LOOPAT_HOME ??= `/tmp/loopat-provider-${process.pid}`
const { pickProvider } = await import("../src/session")

// Tiny builder so tests stay readable
function p(apiKey = "sk-x", baseUrl = "https://x"): ProviderConfig {
  return { models: [{ id: "m", enabled: true }], baseUrl, apiKey, enabled: true }
}

describe("pickProvider — priority order", () => {
  test("explicit candidate beats personal default", () => {
    const r = pickProvider(
      { default: "personal-pref", providers: { "personal-pref": p(), "explicit": p() } },
      {},
      ["explicit"],
      true,
    )
    expect(r?.name).toBe("explicit")
  })

  test("personal default beats workspace default", () => {
    const r = pickProvider(
      { default: "personal-pref", providers: { "personal-pref": p() } },
      { default: "workspace-pref", providers: { "workspace-pref": p() } },
      [],
      true,
    )
    expect(r?.name).toBe("personal-pref")
  })

  test("workspace default used when personal has no default", () => {
    const r = pickProvider(
      { default: "", providers: {} },
      { default: "workspace-pref", providers: { "workspace-pref": p() } },
      [],
      true,
    )
    expect(r?.name).toBe("workspace-pref")
  })

  test("personal providers enumerated before workspace providers", () => {
    // No default anywhere — enumerate. Personal "z" beats workspace "a"
    // because personal is walked first.
    const r = pickProvider(
      { default: "", providers: { z: p() } },
      { default: "", providers: { a: p() } },
      [],
      true,
    )
    expect(r?.name).toBe("z")
  })

  test("explicit candidate falls through to next when missing", () => {
    const r = pickProvider(
      { default: "fallback", providers: { fallback: p() } },
      {},
      ["nonexistent"],
      true,
    )
    expect(r?.name).toBe("fallback")
  })
})

describe("pickProvider — requireKey semantics", () => {
  test("with requireKey=true, providers with empty apiKey are skipped", () => {
    const r = pickProvider(
      { default: "no-key", providers: { "no-key": p(""), "has-key": p("sk-yes") } },
      {},
      [],
      true,
    )
    // no-key is the default but lacks apiKey → walk to next
    expect(r?.name).toBe("has-key")
  })

  test("with requireKey=false, the default wins even without apiKey", () => {
    const r = pickProvider(
      { default: "no-key", providers: { "no-key": p("") } },
      {},
      [],
      false,
    )
    expect(r?.name).toBe("no-key")
  })

  test("returns null when no provider has an apiKey and requireKey=true", () => {
    const r = pickProvider(
      { default: "", providers: { a: p(""), b: p("") } },
      { providers: { c: p("") } },
      [],
      true,
    )
    expect(r).toBeNull()
  })

  test("returns null on completely empty configs", () => {
    expect(pickProvider({ default: "", providers: {} }, {}, [], true)).toBeNull()
    expect(pickProvider({ default: "", providers: {} }, {}, [], false)).toBeNull()
  })
})

describe("pickProvider — workspace fallback (admin scenario)", () => {
  test("new user with no personal config falls through to workspace-shared provider", () => {
    const r = pickProvider(
      { default: "", providers: {} },                                 // bare personal
      { default: "team-shared", providers: { "team-shared": p() } },  // admin seeded
      [],
      true,
    )
    expect(r?.name).toBe("team-shared")
  })

  test("personal override SHADOWS workspace under the same name", () => {
    const personalSpecial = p("sk-personal")
    const workspaceShared = p("sk-workspace")
    const r = pickProvider(
      { default: "", providers: { foo: personalSpecial } },
      { providers: { foo: workspaceShared } },
      ["foo"],
      true,
    )
    // Personal wins on same name (line: `pCfg.providers[name] ?? wCfg.providers?.[name]`)
    expect(r?.provider.apiKey).toBe("sk-personal")
  })
})

describe("pickProvider — explicit candidate with provider/model syntax", () => {
  test('candidate "anthropic/claude-opus-4-7" matches provider "anthropic"', () => {
    // pickProvider takes pre-parsed provider names. session.ts already strips
    // the model part via parseDefault upstream. This test asserts the contract.
    const r = pickProvider(
      { default: "", providers: { anthropic: p() } },
      {},
      ["anthropic"],  // already-parsed name
      true,
    )
    expect(r?.name).toBe("anthropic")
  })
})

describe("pickProvider — dedup", () => {
  test("the same name appearing twice in candidates only resolves once", () => {
    const r = pickProvider(
      { default: "a", providers: { a: p(""), b: p("sk-b") } },
      {},
      ["a", "a", "a"],  // would loop forever if not deduped
      true,
    )
    // a has no apiKey + dedup → walk through default "a" again (deduped) → enumeration → b
    expect(r?.name).toBe("b")
  })
})
