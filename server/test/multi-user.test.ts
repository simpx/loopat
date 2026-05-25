/**
 * L1+L3: multi-user (alice vs bob) isolation.
 *
 * Loopat is multi-tenant within a single workspace — many users share team
 * knowledge but each has their own vault, personal CLAUDE.md, .claude/, and
 * config.json. None of it should bleed across users.
 *
 * Covers G-COMPOSE-USER-* / G-VAULT-USER-* / G-ISO-USER-* goals.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"

process.env.LOOPAT_HOME ??= `/tmp/loopat-multi-user-${process.pid}`
process.env.LOOPAT_NO_HOME_OVERLAY = "1"

const { loadVaultEnvs } = await import("../src/vaults")
const { loadPersonalConfig, clearPersonalCache } = await import("../src/config")
const { composeFromPlan } = await import("../src/compose")
const { buildBwrapArgs } = await import("../src/bwrap")
const {
  LOOPAT_HOME,
  loopWorkdir,
  loopClaudeDir,
  loopContextKnowledge,
  loopContextNotes,
  personalDir,
  personalLoopatDir,
  personalLoopatConfigPath,
  personalClaudeDir,
  personalClaudeMdPath,
  personalVaultDir,
  personalVaultEnvPath,
  personalVaultEnvsDir,
} = await import("../src/paths")
const TEST_HOME = LOOPAT_HOME

async function seedUser(user: string, opts: {
  personalClaudeMd?: string
  vaultEnvs?: Record<string, string>
  providers?: Record<string, any>
}) {
  await mkdir(personalLoopatDir(user), { recursive: true })
  await mkdir(personalClaudeDir(user), { recursive: true })
  await mkdir(personalVaultEnvsDir(user, "default"), { recursive: true })
  if (opts.personalClaudeMd) {
    await writeFile(personalClaudeMdPath(user), opts.personalClaudeMd)
  }
  for (const [k, v] of Object.entries(opts.vaultEnvs ?? {})) {
    await writeFile(personalVaultEnvPath(user, "default", k), v + "\n")
  }
  if (opts.providers) {
    await writeFile(personalLoopatConfigPath(user), JSON.stringify({ providers: opts.providers }))
  }
  clearPersonalCache(user)
}

async function setup() {
  await rm(TEST_HOME, { recursive: true, force: true })
  await mkdir(TEST_HOME, { recursive: true })
  await writeFile(join(TEST_HOME, "config.json"), "{}")
  await seedUser("alice", {
    personalClaudeMd: "# ALICE_DOCTRINE — only alice should see this",
    vaultEnvs: { GITHUB_TOKEN: "alice-gh-token", PRIVATE_VAR: "alice-secret" },
    providers: {
      default: "anthropic",
      anthropic: { baseUrl: "https://alice.example", model: "x", apiKey: "${ALICE_KEY}" },
    },
  })
  await writeFile(personalVaultEnvPath("alice", "default", "ALICE_KEY"), "sk-alice\n")
  await seedUser("bob", {
    personalClaudeMd: "# BOB_DOCTRINE — only bob should see this",
    vaultEnvs: { GITHUB_TOKEN: "bob-gh-token", PRIVATE_VAR: "bob-secret" },
    providers: {
      default: "anthropic",
      anthropic: { baseUrl: "https://bob.example", model: "y", apiKey: "${BOB_KEY}" },
    },
  })
  await writeFile(personalVaultEnvPath("bob", "default", "BOB_KEY"), "sk-bob\n")
  clearPersonalCache("alice")
  clearPersonalCache("bob")
}

beforeAll(setup)
afterAll(() => rm(TEST_HOME, { recursive: true, force: true }))

describe("multi-user — vault isolation", () => {
  test("loadVaultEnvs returns ONLY that user's vault, never the other", async () => {
    const aliceEnvs = await loadVaultEnvs("alice", "default")
    const bobEnvs = await loadVaultEnvs("bob", "default")
    expect(aliceEnvs.PRIVATE_VAR).toBe("alice-secret")
    expect(bobEnvs.PRIVATE_VAR).toBe("bob-secret")
    expect(aliceEnvs.BOB_KEY).toBeUndefined()
    expect(bobEnvs.ALICE_KEY).toBeUndefined()
  })

  test("same-named env in different vaults resolves to each owner's value", async () => {
    const a = await loadVaultEnvs("alice", "default")
    const b = await loadVaultEnvs("bob", "default")
    expect(a.GITHUB_TOKEN).toBe("alice-gh-token")
    expect(b.GITHUB_TOKEN).toBe("bob-gh-token")
  })
})

describe("multi-user — provider config isolation", () => {
  test("each user's apiKey resolves from their own vault", async () => {
    const aliceCfg = await loadPersonalConfig("alice", "default")
    const bobCfg = await loadPersonalConfig("bob", "default")
    expect(aliceCfg.providers.anthropic.apiKey).toBe("sk-alice")
    expect(bobCfg.providers.anthropic.apiKey).toBe("sk-bob")
  })

  test("each user's baseUrl/model differ (configs don't leak)", async () => {
    const aliceCfg = await loadPersonalConfig("alice", "default")
    const bobCfg = await loadPersonalConfig("bob", "default")
    expect(aliceCfg.providers.anthropic.baseUrl).toBe("https://alice.example")
    expect(bobCfg.providers.anthropic.baseUrl).toBe("https://bob.example")
  })

  test("user without config gets template — does not inherit any other user's", async () => {
    const cfg = await loadPersonalConfig("nobody-yet", "default")
    expect(cfg.providers.anthropic?.apiKey).toBeFalsy() // template apiKey is empty
    // nothing pulled from alice/bob
    expect(JSON.stringify(cfg).includes("alice")).toBe(false)
    expect(JSON.stringify(cfg).includes("bob")).toBe(false)
  })
})

describe("multi-user — composed CLAUDE.md doctrine", () => {
  async function composeFor(user: string, loopId: string) {
    await rm(loopClaudeDir(loopId), { recursive: true, force: true })
    await mkdir(loopWorkdir(loopId), { recursive: true })
    await mkdir(loopClaudeDir(loopId), { recursive: true })
    await mkdir(loopContextKnowledge(loopId), { recursive: true })
    await mkdir(loopContextNotes(loopId), { recursive: true })
    // Plan: team layer empty, personal layer only.
    const plan = {
      user,
      claudeSources: [
        { source: `personal:${user}`, dir: personalDir(user) },
      ],
    }
    return await composeFromPlan(loopId, plan as any)
  }

  test("alice's loop CLAUDE.md contains ALICE_DOCTRINE, NOT BOB_DOCTRINE", async () => {
    const loopId = "a0000000-0000-0000-0000-000000000001"
    await composeFor("alice", loopId)
    const md = await readFile(join(loopClaudeDir(loopId), "CLAUDE.md"), "utf8")
    expect(md.includes("ALICE_DOCTRINE")).toBe(true)
    expect(md.includes("BOB_DOCTRINE")).toBe(false)
  })

  test("bob's loop CLAUDE.md contains BOB_DOCTRINE, NOT ALICE_DOCTRINE", async () => {
    const loopId = "b0000000-0000-0000-0000-000000000001"
    await composeFor("bob", loopId)
    const md = await readFile(join(loopClaudeDir(loopId), "CLAUDE.md"), "utf8")
    expect(md.includes("BOB_DOCTRINE")).toBe(true)
    expect(md.includes("ALICE_DOCTRINE")).toBe(false)
  })
})

describe("multi-user — bwrap binds correct user's personal dir", () => {
  function getPersonalBinds(argv: string[]): string[] {
    const out: string[] = []
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--bind" || argv[i] === "--bind-try") {
        const src = argv[i + 1]
        if (src.includes("/personal/")) out.push(src)
      }
    }
    return out
  }

  test("alice's spawn ro-binds /personal/alice, not /personal/bob", async () => {
    const loopId = "a0000000-0000-0000-0000-000000000002"
    await mkdir(loopWorkdir(loopId), { recursive: true })
    await mkdir(loopClaudeDir(loopId), { recursive: true })
    await mkdir(loopContextKnowledge(loopId), { recursive: true })
    await mkdir(loopContextNotes(loopId), { recursive: true })
    const argv = await buildBwrapArgs(loopId, "alice", {}, "default")
    const personalBinds = getPersonalBinds(argv)
    expect(personalBinds.every(p => p.includes("/personal/alice"))).toBe(true)
    expect(personalBinds.some(p => p.includes("/personal/bob"))).toBe(false)
  })

  test("bob's spawn ro-binds /personal/bob, not /personal/alice", async () => {
    const loopId = "b0000000-0000-0000-0000-000000000002"
    await mkdir(loopWorkdir(loopId), { recursive: true })
    await mkdir(loopClaudeDir(loopId), { recursive: true })
    await mkdir(loopContextKnowledge(loopId), { recursive: true })
    await mkdir(loopContextNotes(loopId), { recursive: true })
    const argv = await buildBwrapArgs(loopId, "bob", {}, "default")
    const personalBinds = getPersonalBinds(argv)
    expect(personalBinds.every(p => p.includes("/personal/bob"))).toBe(true)
    expect(personalBinds.some(p => p.includes("/personal/alice"))).toBe(false)
  })

  test("alice's vault envs do NOT appear in bob's bwrap setenv", async () => {
    const loopId = "b0000000-0000-0000-0000-000000000003"
    await mkdir(loopWorkdir(loopId), { recursive: true })
    await mkdir(loopClaudeDir(loopId), { recursive: true })
    await mkdir(loopContextKnowledge(loopId), { recursive: true })
    await mkdir(loopContextNotes(loopId), { recursive: true })
    const bobCfg = await loadPersonalConfig("bob", "default")
    const argv = await buildBwrapArgs(loopId, "bob", bobCfg.vaultEnvs, "default")
    // ALICE_KEY belongs to alice; must not leak into bob's spawn
    expect(argv.includes("ALICE_KEY")).toBe(false)
    expect(argv.includes("sk-alice")).toBe(false)
    // BOB_KEY is bob's own
    expect(argv.includes("BOB_KEY")).toBe(true)
  })
})
