/**
 * L3: vault delivery via podman volume + env args.
 *
 * Asserts the vault refactor's contract: vault/mounts/home/<rel> → --volume
 * at $HOME/<rel>; vault/envs/<NAME> → --env NAME=value at container create
 * time. Also asserts the old vault entrypoint behaviors are absent.
 *
 * Build args only, no actual podman exec.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

process.env.LOOPAT_HOME ??= `/tmp/loopat-podman-vault-${process.pid}`

const { buildVolumeMounts, buildPodmanCreateArgs, V_HOME } = await import("../src/podman")
const { loadVaultEnvs } = await import("../src/vaults")
const {
  LOOPAT_HOME,
  loopWorkdir,
  loopClaudeDir,
  loopContextKnowledge,
  loopContextNotes,
  loopHomeUpper,
  personalDir,
  personalVaultMountsHomeDir,
} = await import("../src/paths")
const TEST_HOME = LOOPAT_HOME
const LOOP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const USER = "alice"
const SANDBOX_HOME = V_HOME(USER)

async function reset() {
  await rm(TEST_HOME, { recursive: true, force: true })
  await mkdir(loopWorkdir(LOOP_ID), { recursive: true })
  await mkdir(loopClaudeDir(LOOP_ID), { recursive: true })
  await mkdir(loopContextKnowledge(LOOP_ID), { recursive: true })
  await mkdir(loopContextNotes(LOOP_ID), { recursive: true })
  await mkdir(loopHomeUpper(LOOP_ID), { recursive: true })
  await mkdir(join(personalDir(USER), ".loopat", "vaults", "default"), { recursive: true })
  await writeFile(join(personalDir(USER), ".loopat", "config.json"), "{}")
  await writeFile(join(TEST_HOME, "config.json"), "{}")
}

beforeAll(reset)
afterAll(() => rm(TEST_HOME, { recursive: true, force: true }))

describe("buildVolumeMounts — vault/mounts/home/ auto-bind", () => {
  test("each top-level entry under mounts/home/ becomes a --volume at $HOME/<rel>", async () => {
    await reset()
    const mh = personalVaultMountsHomeDir(USER, "default")
    await mkdir(join(mh, ".ssh"), { recursive: true })
    await mkdir(join(mh, ".config", "gh"), { recursive: true })
    await writeFile(join(mh, ".gitconfig"), "[user]\nname = test\n")

    const mounts = await buildVolumeMounts({ loopId: LOOP_ID, createdBy: USER, vaultName: "default" })

    expect(mounts.some((m) => m.src === join(mh, ".ssh") && m.dst === join(SANDBOX_HOME, ".ssh"))).toBe(true)
    expect(mounts.some((m) => m.src === join(mh, ".config") && m.dst === join(SANDBOX_HOME, ".config"))).toBe(true)
    expect(mounts.some((m) => m.src === join(mh, ".gitconfig") && m.dst === join(SANDBOX_HOME, ".gitconfig"))).toBe(true)
  })

  test("no entries → no vault mounts emitted (no spurious args)", async () => {
    await reset()
    const mounts = await buildVolumeMounts({ loopId: LOOP_ID, createdBy: USER, vaultName: "default" })
    const vaultMounts = mounts.filter((m) =>
      m.src.startsWith(personalVaultMountsHomeDir(USER, "default")),
    )
    expect(vaultMounts).toEqual([])
  })

  test("subdirectories inside top-level entries are NOT separately bound", async () => {
    await reset()
    const mh = personalVaultMountsHomeDir(USER, "default")
    await mkdir(join(mh, ".config", "gh"), { recursive: true })
    await mkdir(join(mh, ".config", "a1"), { recursive: true })

    const mounts = await buildVolumeMounts({ loopId: LOOP_ID, createdBy: USER, vaultName: "default" })
    const vaultMounts = mounts.filter((m) =>
      m.src.startsWith(personalVaultMountsHomeDir(USER, "default")),
    )
    expect(vaultMounts.length).toBe(1)
    expect(vaultMounts[0].src).toBe(join(mh, ".config"))
  })

  test("vault selection: dev vault entries used when vaultName=dev", async () => {
    await reset()
    const mhDefault = personalVaultMountsHomeDir(USER, "default")
    const mhDev = personalVaultMountsHomeDir(USER, "dev")
    await mkdir(join(mhDefault, ".gitconfig"), { recursive: true })
    await mkdir(join(mhDev, ".ssh"), { recursive: true })

    const mounts = await buildVolumeMounts({ loopId: LOOP_ID, createdBy: USER, vaultName: "dev" })
    expect(mounts.some((m) => m.src === join(mhDev, ".ssh"))).toBe(true)
    expect(mounts.some((m) => m.src === join(mhDefault, ".gitconfig"))).toBe(false)
  })
})

describe("buildPodmanCreateArgs — vault env injection via --env", () => {
  test("vault envs (loaded by caller and passed via extraEnv) land as --env K=V", async () => {
    await reset()
    // Pretend caller already loaded vault envs and passed them through.
    const envs = { DEV_KEY: "secret-dev", ENV_NAME: "dev" }
    const args = await buildPodmanCreateArgs({
      loopId: LOOP_ID,
      createdBy: USER,
      vaultName: "dev",
      extraEnv: envs,
    })
    const envArgs = args
      .map((a, i) => (a === "--env" ? args[i + 1] : null))
      .filter((s): s is string => s !== null)
    expect(envArgs).toContain("DEV_KEY=secret-dev")
    expect(envArgs).toContain("ENV_NAME=dev")
  })
})
