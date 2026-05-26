/**
 * L1+L3: multi-vault — one user can have several named vaults (default, dev,
 * prod, ...). Each loop binds exactly ONE active vault. The same loop spawned
 * with vault=dev vs vault=prod must yield completely different env/mount
 * surfaces, even though the user and the workspace are identical.
 *
 * Also covers the realpath-escape guard in walkVaultFiles: vault symlinks
 * pointing outside personal/<user>/ are rejected (anti-privilege-escalation).
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdir, rm, writeFile, symlink } from "node:fs/promises"
import { join } from "node:path"

process.env.LOOPAT_HOME ??= `/tmp/loopat-multi-vault-${process.pid}`

const {
  loadVaultEnvs,
  listVaultHomeMounts,
  listVaults,
  resolveVaultRoot,
  walkVaultFiles,
  isValidVaultName,
} = await import("../src/vaults")
const { buildPodmanCreateArgs } = await import("../src/podman")
const {
  LOOPAT_HOME,
  loopWorkdir,
  loopClaudeDir,
  loopContextKnowledge,
  loopContextNotes,
  personalDir,
  personalLoopatDir,
  personalVaultDir,
  personalVaultEnvsDir,
  personalVaultEnvPath,
  personalVaultMountsHomeDir,
} = await import("../src/paths")
const TEST_HOME = LOOPAT_HOME
const USER = "alice"

async function setup() {
  await rm(TEST_HOME, { recursive: true, force: true })
  await mkdir(TEST_HOME, { recursive: true })
  await writeFile(join(TEST_HOME, "config.json"), "{}")
  await mkdir(personalLoopatDir(USER), { recursive: true })
  // Three vaults — default, dev, prod — with diverging contents.
  for (const v of ["default", "dev", "prod"]) {
    await mkdir(personalVaultEnvsDir(USER, v), { recursive: true })
    await mkdir(personalVaultMountsHomeDir(USER, v), { recursive: true })
    await writeFile(personalVaultEnvPath(USER, v, "ENV_NAME"), v + "\n")
    await writeFile(personalVaultEnvPath(USER, v, `${v.toUpperCase()}_ONLY`), "secret-" + v + "\n")
  }
}

beforeAll(setup)
afterAll(() => rm(TEST_HOME, { recursive: true, force: true }))

describe("vault catalog", () => {
  test("listVaults returns all named vaults in alphabetic order", () => {
    expect(listVaults(USER)).toEqual(["default", "dev", "prod"])
  })

  test("listVaults returns [] when user has no vaults dir", () => {
    expect(listVaults("nobody")).toEqual([])
  })

  test("resolveVaultRoot returns absolute path for existing vault", () => {
    const p = resolveVaultRoot(USER, "dev")
    expect(p).not.toBeNull()
    expect(p!.endsWith("/personal/alice/.loopat/vaults/dev")).toBe(true)
  })

  test("resolveVaultRoot returns null for missing vault", () => {
    expect(resolveVaultRoot(USER, "ghost")).toBeNull()
  })

  test("isValidVaultName accepts good names, rejects bad", () => {
    expect(isValidVaultName("default")).toBe(true)
    expect(isValidVaultName("dev")).toBe(true)
    expect(isValidVaultName("v_1")).toBe(true)
    expect(isValidVaultName("../escape")).toBe(false)
    expect(isValidVaultName(".hidden")).toBe(false)
    expect(isValidVaultName("")).toBe(false)
    expect(isValidVaultName("a".repeat(100))).toBe(false)  // length cap
  })
})

describe("per-loop vault selection — same user, different sandbox env", () => {
  test("loadVaultEnvs delivers ONLY the named vault's envs", async () => {
    const d = await loadVaultEnvs(USER, "default")
    const dev = await loadVaultEnvs(USER, "dev")
    const prod = await loadVaultEnvs(USER, "prod")
    expect(d.ENV_NAME).toBe("default")
    expect(dev.ENV_NAME).toBe("dev")
    expect(prod.ENV_NAME).toBe("prod")
    // The vault-exclusive envs must not bleed
    expect(d.DEV_ONLY).toBeUndefined()
    expect(d.PROD_ONLY).toBeUndefined()
    expect(dev.DEFAULT_ONLY).toBeUndefined()
    expect(prod.DEV_ONLY).toBeUndefined()
  })

  test("podman argv reflects vault selection — dev spawn carries dev envs", async () => {
    const loopId = "vvvvvvvv-dddd-0000-0000-000000000001"
    await mkdir(loopWorkdir(loopId), { recursive: true })
    await mkdir(loopClaudeDir(loopId), { recursive: true })
    await mkdir(loopContextKnowledge(loopId), { recursive: true })
    await mkdir(loopContextNotes(loopId), { recursive: true })
    const cfg = await loadVaultEnvs(USER, "dev")
    const argv = await buildPodmanCreateArgs({
      loopId,
      createdBy: USER,
      vaultName: "dev",
      extraEnv: cfg,
    })
    // DEV_ONLY must appear as `--env DEV_ONLY=...`; PROD_ONLY must not
    const hasEnvKey = (k: string) => {
      for (let i = 0; i < argv.length - 1; i++) {
        if (argv[i] === "--env" && argv[i + 1].startsWith(`${k}=`)) return true
      }
      return false
    }
    expect(hasEnvKey("DEV_ONLY")).toBe(true)
    expect(hasEnvKey("PROD_ONLY")).toBe(false)
  })

  test("the SAME loop respawned with a different vault gets different envs", async () => {
    const loopId = "vvvvvvvv-eeee-0000-0000-000000000002"
    await mkdir(loopWorkdir(loopId), { recursive: true })
    await mkdir(loopClaudeDir(loopId), { recursive: true })
    await mkdir(loopContextKnowledge(loopId), { recursive: true })
    await mkdir(loopContextNotes(loopId), { recursive: true })

    const devEnvs = await loadVaultEnvs(USER, "dev")
    const prodEnvs = await loadVaultEnvs(USER, "prod")
    const argvDev = await buildPodmanCreateArgs({
      loopId,
      createdBy: USER,
      vaultName: "dev",
      extraEnv: devEnvs,
    })
    const argvProd = await buildPodmanCreateArgs({
      loopId,
      createdBy: USER,
      vaultName: "prod",
      extraEnv: prodEnvs,
    })
    const hasEnvKey = (argv: string[], k: string) => {
      for (let i = 0; i < argv.length - 1; i++) {
        if (argv[i] === "--env" && argv[i + 1].startsWith(`${k}=`)) return true
      }
      return false
    }
    expect(hasEnvKey(argvDev, "DEV_ONLY")).toBe(true)
    expect(hasEnvKey(argvDev, "PROD_ONLY")).toBe(false)
    expect(hasEnvKey(argvProd, "PROD_ONLY")).toBe(true)
    expect(hasEnvKey(argvProd, "DEV_ONLY")).toBe(false)
  })

  test("vault-specific mounts/home/* land only when that vault is active", async () => {
    // Add a mount only in dev vault
    await mkdir(join(personalVaultMountsHomeDir(USER, "dev"), ".ssh"), { recursive: true })
    await writeFile(join(personalVaultMountsHomeDir(USER, "dev"), ".ssh", "id_ed25519"), "DEV_KEY")
    const dev = listVaultHomeMounts(USER, "dev")
    const prod = listVaultHomeMounts(USER, "prod")
    expect(dev.some(m => m.rel === ".ssh")).toBe(true)
    expect(prod.some(m => m.rel === ".ssh")).toBe(false)
  })
})

describe("walkVaultFiles — symlink escape rejection (security)", () => {
  test("symlink within user tree is followed (legitimate cross-vault sharing)", async () => {
    // Shared file in default, prod references it via symlink.
    const sharedFile = personalVaultEnvPath(USER, "default", "SHARED_TOKEN")
    await writeFile(sharedFile, "shared-value")
    const linkPath = personalVaultEnvPath(USER, "prod", "SHARED_TOKEN")
    await rm(linkPath, { force: true })
    await symlink(sharedFile, linkPath)
    const found: string[] = []
    for await (const f of walkVaultFiles(USER, personalVaultDir(USER, "prod"))) {
      found.push(f.rel)
    }
    expect(found).toContain("envs/SHARED_TOKEN")
  })

  test("symlink escaping personal/<user>/ is REJECTED (never yields)", async () => {
    // Create an escaping symlink: vault/prod/envs/EVIL → /etc/passwd
    const evilLink = personalVaultEnvPath(USER, "prod", "EVIL_ESCAPE")
    await rm(evilLink, { force: true })
    await symlink("/etc/passwd", evilLink)
    const found: string[] = []
    for await (const f of walkVaultFiles(USER, personalVaultDir(USER, "prod"))) {
      found.push(f.rel)
    }
    expect(found.includes("envs/EVIL_ESCAPE")).toBe(false)
  })

  test("symlink to another user's vault is REJECTED", async () => {
    // Bob shouldn't be able to symlink into alice's secrets
    await mkdir(personalVaultEnvsDir("bob", "default"), { recursive: true })
    const aliceSecret = personalVaultEnvPath(USER, "default", "ENV_NAME")
    const bobLink = personalVaultEnvPath("bob", "default", "STEAL_ALICE")
    await rm(bobLink, { force: true })
    await symlink(aliceSecret, bobLink)
    const found: string[] = []
    for await (const f of walkVaultFiles("bob", personalVaultDir("bob", "default"))) {
      found.push(f.rel)
    }
    expect(found.includes("envs/STEAL_ALICE")).toBe(false)
  })
})
