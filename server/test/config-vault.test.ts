/**
 * L1: pure-function tests for config.ts vault-aware pieces:
 * expandVars / providerEnvVarName / describeApiKeyRef / writeVaultEnv /
 * deleteVaultEnv / loadPersonalConfig (with ${VAR} resolution).
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

process.env.LOOPAT_HOME ??= `/tmp/loopat-config-l1-${process.pid}`

const {
  expandVars,
  providerEnvVarName,
  describeApiKeyRef,
  writeVaultEnv,
  deleteVaultEnv,
  loadPersonalConfig,
  clearPersonalCache,
} = await import("../src/config")
const {
  LOOPAT_HOME,
  personalLoopatDir,
  personalLoopatConfigPath,
  personalVaultEnvsDir,
  personalVaultEnvPath,
} = await import("../src/paths")

const USER = "alice"

async function resetUser() {
  await rm(LOOPAT_HOME, { recursive: true, force: true })
  await mkdir(personalLoopatDir(USER), { recursive: true })
  clearPersonalCache(USER)
}

beforeAll(resetUser)
afterAll(async () => { await rm(LOOPAT_HOME, { recursive: true, force: true }) })

describe("expandVars", () => {
  test("substitutes single ${VAR}", () => {
    expect(expandVars("${X}", { X: "hello" })).toBe("hello")
  })
  test("substitutes multiple ${VAR} in one string", () => {
    expect(expandVars("a${X}b${Y}c", { X: "1", Y: "2" })).toBe("a1b2c")
  })
  test("unknown vars resolve to empty string", () => {
    expect(expandVars("${MISSING}", {})).toBe("")
    expect(expandVars("pre${MISSING}post", {})).toBe("prepost")
  })
  test("literal string without $ passes through unchanged", () => {
    expect(expandVars("plain literal", { X: "ignored" })).toBe("plain literal")
  })
  test("empty input → empty output", () => {
    expect(expandVars("", { X: "v" })).toBe("")
  })
  test("does not substitute malformed refs", () => {
    expect(expandVars("$X", { X: "v" })).toBe("$X")          // missing braces
    expect(expandVars("${1BAD}", { "1BAD": "v" })).toBe("${1BAD}")  // var name must start with letter
  })
})

describe("providerEnvVarName", () => {
  test("uppercases simple name + _API_KEY suffix", () => {
    expect(providerEnvVarName("anthropic")).toBe("ANTHROPIC_API_KEY")
    expect(providerEnvVarName("Anthropic")).toBe("ANTHROPIC_API_KEY")
  })
  test("normalizes non-alphanumeric to underscore", () => {
    expect(providerEnvVarName("deep-seek")).toBe("DEEP_SEEK_API_KEY")
    expect(providerEnvVarName("My Provider")).toBe("MY_PROVIDER_API_KEY")
    expect(providerEnvVarName("foo.bar")).toBe("FOO_BAR_API_KEY")
  })
  test("trims leading/trailing underscores from sanitized portion", () => {
    expect(providerEnvVarName("-foo-")).toBe("FOO_API_KEY")
  })
  test("falls back to PROVIDER for all-junk names", () => {
    expect(providerEnvVarName("---")).toBe("PROVIDER_API_KEY")
  })
})

describe("describeApiKeyRef", () => {
  beforeEach(resetUser)

  test("empty / undefined → kind=empty exists=false", () => {
    expect(describeApiKeyRef(undefined, USER).kind).toBe("empty")
    expect(describeApiKeyRef("", USER).kind).toBe("empty")
    expect(describeApiKeyRef(undefined, USER).exists).toBe(false)
  })

  test("literal string (no ${...}) → kind=literal exists=true", () => {
    const d = describeApiKeyRef("sk-literal", USER)
    expect(d.kind).toBe("literal")
    expect(d.exists).toBe(true)
  })

  test("single ${VAR} → kind=var, exists tracks file presence", async () => {
    const d1 = describeApiKeyRef("${MY_KEY}", USER)
    expect(d1.kind).toBe("var")
    expect(d1.varName).toBe("MY_KEY")
    expect(d1.exists).toBe(false)
    expect(d1.path).toContain("envs/MY_KEY")

    // Once the file is written, exists flips true.
    await writeVaultEnv(USER, "default", "MY_KEY", "value")
    const d2 = describeApiKeyRef("${MY_KEY}", USER)
    expect(d2.exists).toBe(true)
  })

  test("mixed template (literal+ref or multi-ref) → kind=mixed", () => {
    expect(describeApiKeyRef("Bearer ${X}", USER).kind).toBe("mixed")
    expect(describeApiKeyRef("${X}${Y}", USER).kind).toBe("mixed")
  })
})

describe("writeVaultEnv / deleteVaultEnv", () => {
  beforeEach(resetUser)

  test("writes value to envs/<name> with trailing newline + creates parent", async () => {
    const r = await writeVaultEnv(USER, "default", "FOO", "bar")
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("type narrowing")
    expect(existsSync(r.path)).toBe(true)
    const contents = await Bun.file(r.path).text()
    expect(contents).toBe("bar\n")
  })

  test("rejects invalid env name", async () => {
    const r = await writeVaultEnv(USER, "default", "bad-name", "v")
    expect(r.ok).toBe(false)
  })

  test("delete removes the file; deleting missing is a no-op", async () => {
    await writeVaultEnv(USER, "default", "TEMP", "x")
    expect(existsSync(personalVaultEnvPath(USER, "default", "TEMP"))).toBe(true)
    await deleteVaultEnv(USER, "default", "TEMP")
    expect(existsSync(personalVaultEnvPath(USER, "default", "TEMP"))).toBe(false)
    // again — no throw
    await deleteVaultEnv(USER, "default", "TEMP")
  })

  test("ignores invalid names on delete (no-op, no throw)", async () => {
    await deleteVaultEnv(USER, "default", "bad-name")  // must not throw
  })
})

describe("loadPersonalConfig — ${VAR} resolution in provider.apiKey", () => {
  beforeEach(resetUser)

  async function writeConfig(disk: any) {
    await mkdir(personalLoopatDir(USER), { recursive: true })
    await writeFile(personalLoopatConfigPath(USER), JSON.stringify(disk, null, 2))
  }

  test("provider apiKey ${VAR} resolves from vault envs", async () => {
    await writeVaultEnv(USER, "default", "ANTHROPIC_API_KEY", "sk-secret-xyz")
    await writeConfig({
      providers: {
        default: "anthropic",
        anthropic: {
          baseUrl: "https://anthropic.example.com",
          model: "claude-opus-4-7",
          apiKey: "${ANTHROPIC_API_KEY}",
        },
      },
    })
    const cfg = await loadPersonalConfig(USER, "default")
    expect(cfg.providers.anthropic.apiKey).toBe("sk-secret-xyz")
    expect(cfg.vaultEnvs.ANTHROPIC_API_KEY).toBe("sk-secret-xyz")
  })

  test("missing ${VAR} resolves to empty string (provider effectively disabled)", async () => {
    await writeConfig({
      providers: {
        default: "anthropic",
        anthropic: {
          baseUrl: "https://api.anthropic.com",
          model: "x",
          apiKey: "${NOT_SET_ANYWHERE}",
        },
      },
    })
    const cfg = await loadPersonalConfig(USER, "default")
    expect(cfg.providers.anthropic.apiKey).toBe("")
  })

  test("literal apiKey (no ${...}) passes through unchanged", async () => {
    await writeConfig({
      providers: {
        default: "anthropic",
        anthropic: { baseUrl: "x", model: "y", apiKey: "sk-literal-abc" },
      },
    })
    const cfg = await loadPersonalConfig(USER, "default")
    expect(cfg.providers.anthropic.apiKey).toBe("sk-literal-abc")
  })

  test("vaultEnvs exposes the loaded env map on cfg", async () => {
    await writeVaultEnv(USER, "default", "A_KEY", "av")
    await writeVaultEnv(USER, "default", "B_KEY", "bv")
    await writeConfig({ providers: { default: "x", x: { baseUrl: "u", model: "m" } } })
    const cfg = await loadPersonalConfig(USER, "default")
    expect(cfg.vaultEnvs).toMatchObject({ A_KEY: "av", B_KEY: "bv" })
  })

  test("missing config.json → in-memory template (no write)", async () => {
    await rm(personalLoopatConfigPath(USER), { force: true })
    const cfg = await loadPersonalConfig(USER, "default")
    expect(cfg.providers).toBeDefined()
    expect(existsSync(personalLoopatConfigPath(USER))).toBe(false)
  })
})
