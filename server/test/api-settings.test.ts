/**
 * L2: HTTP-endpoint tests for /api/settings/personal/* — the Settings UI's
 * write path.
 *
 * Same bootstrap-suppression pattern as api-mcp.test.ts.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

process.env.LOOPAT_HOME ??= `/tmp/loopat-api-settings-${process.pid}`
process.env.PORT = "0"
process.env.LOOPAT_SERVE_PORT = "0"

const HOME = process.env.LOOPAT_HOME!
await rm(HOME, { recursive: true, force: true })
await mkdir(HOME, { recursive: true })
await writeFile(join(HOME, "config.json"), JSON.stringify({
  knowledge: { git: "" }, notes: { git: "" }, repos: [], providers: {},
}))

const { app } = await import("../src/index")
const {
  personalLoopatDir,
  personalLoopatConfigPath,
  personalVaultEnvPath,
  personalVaultEnvsDir,
} = await import("../src/paths")
const { createUser, createSession, COOKIE_NAME } = await import("../src/auth")
const { clearPersonalCache } = await import("../src/config")

const USER = "settest"
let COOKIE = ""

async function authed(): Promise<Record<string, string>> {
  return { Cookie: `${COOKIE_NAME}=${COOKIE}` }
}

beforeAll(async () => {
  try { await createUser({ id: USER, password: "pw" }) } catch {}
  COOKIE = createSession(USER)
  await mkdir(personalLoopatDir(USER), { recursive: true })
  await mkdir(personalVaultEnvsDir(USER, "default"), { recursive: true })
})

afterAll(async () => { await rm(HOME, { recursive: true, force: true }) })

describe("GET /api/settings/personal/disk", () => {
  test("returns disk shape + refExists for each provider apiKey", async () => {
    await writeFile(personalLoopatConfigPath(USER), JSON.stringify({
      providers: {
        default: "anthropic",
        anthropic: { baseUrl: "https://api.anthropic.com", model: "x", apiKey: "${ANTHROPIC_API_KEY}" },
        anthropic:   { baseUrl: "https://anthropic.example.com", model: "y", apiKey: "${ANTHROPIC_API_KEY}" },
        custom:    { baseUrl: "u", model: "z", apiKey: "sk-literal-here" },
      },
    }))
    // Only ANTHROPIC_API_KEY exists on disk
    await writeFile(personalVaultEnvPath(USER, "default", "ANTHROPIC_API_KEY"), "sk-ant-actual")
    clearPersonalCache(USER)

    const r = await app.request("/api/settings/personal/disk", { headers: await authed() })
    expect(r.status).toBe(200)
    const j = await r.json() as any

    expect(j.disk.providers).toBeDefined()
    expect(j.refExists["providers.anthropic.apiKey"]).toEqual({
      kind: "var", exists: true, varName: "ANTHROPIC_API_KEY",
    })
    expect(j.refExists["providers.anthropic.apiKey"]).toEqual({
      kind: "var", exists: false, varName: "ANTHROPIC_API_KEY",
    })
    expect(j.refExists["providers.custom.apiKey"]).toEqual({
      kind: "literal", exists: true,
    })
  })

  test("does NOT leak resolved apiKey values to client", async () => {
    const r = await app.request("/api/settings/personal/disk", { headers: await authed() })
    const j = await r.json() as any
    // disk shape carries the template (${VAR}), not the resolved value
    expect(j.disk.providers.anthropic.apiKey).toBe("${ANTHROPIC_API_KEY}")
    // No field anywhere contains the real secret
    const all = JSON.stringify(j)
    expect(all.includes("sk-ant-actual")).toBe(false)
  })
})

describe("POST /api/settings/personal/value — write vault env", () => {
  test("writes the value to vaults/<v>/envs/<NAME>", async () => {
    const r = await app.request("/api/settings/personal/value", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authed()) },
      body: JSON.stringify({ name: "MY_NEW_KEY", value: "fresh-value", vault: "default" }),
    })
    expect(r.status).toBe(200)
    const written = await Bun.file(personalVaultEnvPath(USER, "default", "MY_NEW_KEY")).text()
    expect(written).toBe("fresh-value\n")
  })

  test("vault defaults to 'default' when omitted", async () => {
    const r = await app.request("/api/settings/personal/value", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authed()) },
      body: JSON.stringify({ name: "DEFAULT_VAULT_TEST", value: "v" }),
    })
    expect(r.status).toBe(200)
    expect(existsSync(personalVaultEnvPath(USER, "default", "DEFAULT_VAULT_TEST"))).toBe(true)
  })

  test("rejects missing name", async () => {
    const r = await app.request("/api/settings/personal/value", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authed()) },
      body: JSON.stringify({ value: "v" }),
    })
    expect(r.status).toBe(400)
  })

  test("rejects invalid vault name", async () => {
    const r = await app.request("/api/settings/personal/value", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authed()) },
      body: JSON.stringify({ name: "X", value: "v", vault: "../escape" }),
    })
    expect(r.status).toBe(400)
  })

  test("rejects invalid env name", async () => {
    const r = await app.request("/api/settings/personal/value", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authed()) },
      body: JSON.stringify({ name: "bad-name", value: "v" }),
    })
    expect(r.status).toBe(400)
  })
})

describe("PUT /api/settings/personal/disk — config.json structural patch", () => {
  test("saves providers patch", async () => {
    const r = await app.request("/api/settings/personal/disk", {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await authed()) },
      body: JSON.stringify({
        providers: {
          default: "new-one",
          "new-one": { baseUrl: "u", model: "m", apiKey: "${NEW_ONE_API_KEY}" },
        },
      }),
    })
    expect(r.status).toBe(200)
    const j = JSON.parse(await Bun.file(personalLoopatConfigPath(USER)).text())
    expect(j.providers["new-one"].baseUrl).toBe("u")
    expect(j.providers.default).toBe("new-one")
  })

  test("rejects non-string default provider", async () => {
    const r = await app.request("/api/settings/personal/disk", {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await authed()) },
      body: JSON.stringify({ providers: { default: 123, foo: { baseUrl: "u", model: "m" } } }),
    })
    expect(r.status).toBe(400)
  })

  test("rejects provider missing baseUrl", async () => {
    const r = await app.request("/api/settings/personal/disk", {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await authed()) },
      body: JSON.stringify({ providers: { foo: { model: "m" } } }),
    })
    expect(r.status).toBe(400)
  })
})
