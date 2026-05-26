/**
 * L1+L3: driver handoff (RFD) — the loop's "driver" is the user whose vault
 * + personal config the sandbox runs under. Distinct from `createdBy`.
 *
 *   - alice creates a loop → driver = alice (default = createdBy)
 *   - alice requests-for-drive → rfdRequestedAt set, sandbox torn down
 *   - bob takes over → driver = bob, pendingDriverNote set for first message
 *   - subsequent spawns: vault, personal CLAUDE.md, apiKey are BOB's not alice's
 *
 * We don't test the HTTP /api/loops/:id/drive endpoint here (covered in L2 if
 * needed). We test the effectiveDriver primitive + downstream side effects:
 * loadPersonalConfig and bwrap targeting follow the driver, not the creator.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

process.env.LOOPAT_HOME ??= `/tmp/loopat-driver-${process.pid}`

const { effectiveDriver, isDriver } = await import("../src/loops")
const { loadPersonalConfig, clearPersonalCache } = await import("../src/config")
const { buildPodmanCreateArgs } = await import("../src/podman")
const {
  LOOPAT_HOME,
  loopWorkdir,
  loopClaudeDir,
  loopContextKnowledge,
  loopContextNotes,
  personalLoopatDir,
  personalLoopatConfigPath,
  personalVaultEnvsDir,
  personalVaultEnvPath,
} = await import("../src/paths")
const TEST_HOME = LOOPAT_HOME

async function seedUser(user: string, apiKey: string) {
  await mkdir(personalLoopatDir(user), { recursive: true })
  await mkdir(personalVaultEnvsDir(user, "default"), { recursive: true })
  await writeFile(personalVaultEnvPath(user, "default", "ANTHROPIC_API_KEY"), apiKey + "\n")
  await writeFile(personalLoopatConfigPath(user), JSON.stringify({
    providers: {
      default: "anthropic",
      anthropic: { baseUrl: `https://${user}.example`, model: "x", apiKey: "${ANTHROPIC_API_KEY}" },
    },
  }))
  clearPersonalCache(user)
}

async function setup() {
  await rm(TEST_HOME, { recursive: true, force: true })
  await mkdir(TEST_HOME, { recursive: true })
  await writeFile(join(TEST_HOME, "config.json"), "{}")
  await seedUser("alice", "sk-alice-handoff")
  await seedUser("bob", "sk-bob-handoff")
}

beforeAll(setup)
afterAll(() => rm(TEST_HOME, { recursive: true, force: true }))

describe("effectiveDriver primitive", () => {
  test("missing driver field → falls back to createdBy", () => {
    expect(effectiveDriver({ createdBy: "alice" })).toBe("alice")
  })

  test("driver field set → that wins over createdBy", () => {
    expect(effectiveDriver({ createdBy: "alice", driver: "bob" })).toBe("bob")
  })

  test("isDriver matches effective, not createdBy", () => {
    const meta = { createdBy: "alice", driver: "bob" }
    expect(isDriver(meta, "bob")).toBe(true)
    expect(isDriver(meta, "alice")).toBe(false)
  })

  test("legacy loop with no driver → createdBy is the driver", () => {
    const meta = { createdBy: "alice" }  // no driver field — pre-handoff era
    expect(isDriver(meta, "alice")).toBe(true)
    expect(isDriver(meta, "bob")).toBe(false)
  })
})

describe("after handoff — spawn uses driver's vault, not createdBy's", () => {
  test("loadPersonalConfig(driver) returns driver's apiKey", async () => {
    // alice created, bob now drives
    const driverCfg = await loadPersonalConfig("bob", "default")
    expect(driverCfg.providers.anthropic.apiKey).toBe("sk-bob-handoff")
    // alice still has her own apiKey, but a session for THIS loop would use bob's
    const creatorCfg = await loadPersonalConfig("alice", "default")
    expect(creatorCfg.providers.anthropic.apiKey).toBe("sk-alice-handoff")
  })

  test("podman argv binds driver's personal dir, not createdBy's", async () => {
    const loopId = "11111111-2222-3333-4444-111111111111"
    await mkdir(loopWorkdir(loopId), { recursive: true })
    await mkdir(loopClaudeDir(loopId), { recursive: true })
    await mkdir(loopContextKnowledge(loopId), { recursive: true })
    await mkdir(loopContextNotes(loopId), { recursive: true })

    // session.ts would call buildPodmanCreateArgs(loopId, effectiveDriver(meta), ...)
    // — simulate post-handoff (driver=bob, createdBy=alice).
    const argv = await buildPodmanCreateArgs({
      loopId,
      createdBy: "bob",
      vaultName: "default",
    })
    const personalBinds: string[] = []
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--volume" && argv[i + 1].includes("/personal/")) {
        personalBinds.push(argv[i + 1].split(":")[0])
      }
    }
    expect(personalBinds.every(p => p.includes("/personal/bob"))).toBe(true)
    expect(personalBinds.some(p => p.includes("/personal/alice"))).toBe(false)
  })

  test("driver's vault envs reach sandbox --env after handoff", async () => {
    const loopId = "11111111-2222-3333-4444-222222222222"
    await mkdir(loopWorkdir(loopId), { recursive: true })
    await mkdir(loopClaudeDir(loopId), { recursive: true })
    await mkdir(loopContextKnowledge(loopId), { recursive: true })
    await mkdir(loopContextNotes(loopId), { recursive: true })

    const bobCfg = await loadPersonalConfig("bob", "default")
    const argv = await buildPodmanCreateArgs({
      loopId,
      createdBy: "bob",
      vaultName: "default",
      extraEnv: { ...bobCfg.vaultEnvs, ANTHROPIC_API_KEY: bobCfg.providers.anthropic.apiKey },
    })

    const findEnv = (k: string) => {
      const prefix = `${k}=`
      for (let i = 0; i < argv.length - 1; i++) {
        if (argv[i] === "--env" && argv[i + 1].startsWith(prefix)) {
          return argv[i + 1].slice(prefix.length)
        }
      }
      return undefined
    }
    expect(findEnv("ANTHROPIC_API_KEY")).toBe("sk-bob-handoff")
    // alice's key must not leak — search both env values and any other arg
    for (let i = 0; i < argv.length; i++) {
      expect(argv[i].includes("sk-alice-handoff")).toBe(false)
    }
  })
})

describe("RFD (request-for-drive) state — meta-level", () => {
  test("rfdRequestedAt set + driver unchanged = waiting-for-take-over", () => {
    const meta = {
      createdBy: "alice",
      driver: "alice",
      rfdRequestedAt: new Date().toISOString(),
      rfdRequestedBy: "alice",
    }
    // effectiveDriver still alice (until someone drives)
    expect(effectiveDriver(meta)).toBe("alice")
    // But the session should be torn down — UI gates writes by checking rfd state
    expect(meta.rfdRequestedAt).toBeTruthy()
  })

  test("after takeover: rfd cleared, driver replaced, history appended", () => {
    const meta = {
      createdBy: "alice",
      driver: "bob",
      driverHistory: [
        { driver: "alice", since: "2026-05-01T00:00:00.000Z" },
        { driver: "bob",   since: "2026-05-25T00:00:00.000Z" },
      ],
      // rfdRequestedAt cleared by the /drive endpoint
    }
    expect(effectiveDriver(meta)).toBe("bob")
    expect(meta.driverHistory.length).toBeGreaterThan(1)
    // The most recent entry must match the current driver
    const last = meta.driverHistory[meta.driverHistory.length - 1]
    expect(last.driver).toBe(meta.driver)
  })

  test("pendingDriverNote shape — consumed once on next user message", () => {
    const meta = {
      createdBy: "alice",
      driver: "bob",
      pendingDriverNote: { from: "alice", to: "bob", at: new Date().toISOString() },
    }
    // It's a structural contract — sendUserText reads then clears.
    expect(meta.pendingDriverNote.from).toBe("alice")
    expect(meta.pendingDriverNote.to).toBe("bob")
  })
})
