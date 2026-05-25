/**
 * L1: pure-function tests for the vault refactor — loadVaultEnvs +
 * listVaultHomeMounts. Heavy fixtures (LOOPAT_HOME tree, git repos) live in
 * later tiers; here we just exercise the file-walking helpers against a
 * disposable temp dir.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdir, rm, writeFile, symlink } from "node:fs/promises"
import { join } from "node:path"

// paths.ts captures LOOPAT_HOME at module load — set it before any import.
process.env.LOOPAT_HOME ??= `/tmp/loopat-vault-l1-${process.pid}`

const { loadVaultEnvs, listVaultHomeMounts } = await import("../src/vaults")
const {
  LOOPAT_HOME,
  personalVaultEnvsDir,
  personalVaultMountsHomeDir,
  personalVaultDir,
} = await import("../src/paths")

const USER = "alice"
const VAULT = "default"

async function reset() {
  await rm(LOOPAT_HOME, { recursive: true, force: true })
  await mkdir(personalVaultDir(USER, VAULT), { recursive: true })
}

beforeAll(reset)
afterAll(async () => { await rm(LOOPAT_HOME, { recursive: true, force: true }) })

describe("loadVaultEnvs", () => {
  test("returns empty object when vault dir missing", async () => {
    await rm(LOOPAT_HOME, { recursive: true, force: true })
    expect(await loadVaultEnvs(USER, VAULT)).toEqual({})
  })

  test("returns empty object when envs/ dir missing", async () => {
    await reset()
    expect(await loadVaultEnvs(USER, VAULT)).toEqual({})
  })

  test("reads filename → trimmed content for each file", async () => {
    await reset()
    const envs = personalVaultEnvsDir(USER, VAULT)
    await mkdir(envs, { recursive: true })
    await writeFile(join(envs, "ANTHROPIC_API_KEY"), "sk-ant-xxxxx\n")
    await writeFile(join(envs, "GITHUB_TOKEN"), "ghp_yyyyy")  // no newline
    const result = await loadVaultEnvs(USER, VAULT)
    expect(result).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-xxxxx",
      GITHUB_TOKEN: "ghp_yyyyy",
    })
  })

  test("strips only trailing newlines, preserves interior whitespace", async () => {
    await reset()
    const envs = personalVaultEnvsDir(USER, VAULT)
    await mkdir(envs, { recursive: true })
    await writeFile(join(envs, "MULTILINE"), "line1\n  indented  \nline3\n\n")
    const r = await loadVaultEnvs(USER, VAULT)
    expect(r.MULTILINE).toBe("line1\n  indented  \nline3")
  })

  test("skips filenames that aren't valid POSIX env var names", async () => {
    await reset()
    const envs = personalVaultEnvsDir(USER, VAULT)
    await mkdir(envs, { recursive: true })
    await writeFile(join(envs, "GOOD_NAME"), "ok")
    await writeFile(join(envs, "bad-name"), "skipped")     // hyphen → invalid
    await writeFile(join(envs, "1starts_with_digit"), "skipped")
    await writeFile(join(envs, ".dotfile"), "skipped")
    await writeFile(join(envs, "with space"), "skipped")
    const r = await loadVaultEnvs(USER, VAULT)
    expect(Object.keys(r).sort()).toEqual(["GOOD_NAME"])
  })

  test("skips subdirectories under envs/", async () => {
    await reset()
    const envs = personalVaultEnvsDir(USER, VAULT)
    await mkdir(join(envs, "subdir"), { recursive: true })
    await writeFile(join(envs, "subdir", "INSIDE"), "ignored")
    await writeFile(join(envs, "TOP"), "kept")
    const r = await loadVaultEnvs(USER, VAULT)
    expect(r).toEqual({ TOP: "kept" })
  })

  test("isolates per-vault — dev vault doesn't see default vault envs", async () => {
    await reset()
    await mkdir(personalVaultEnvsDir(USER, "default"), { recursive: true })
    await mkdir(personalVaultEnvsDir(USER, "dev"), { recursive: true })
    await writeFile(join(personalVaultEnvsDir(USER, "default"), "K"), "dval")
    await writeFile(join(personalVaultEnvsDir(USER, "dev"), "K"), "devval")
    expect((await loadVaultEnvs(USER, "default")).K).toBe("dval")
    expect((await loadVaultEnvs(USER, "dev")).K).toBe("devval")
  })
})

describe("listVaultHomeMounts", () => {
  test("returns [] when mounts/home dir missing", () => {
    expect(listVaultHomeMounts(USER, VAULT)).toEqual([])
  })

  test("returns one entry per top-level child (file or dir)", async () => {
    await reset()
    const mh = personalVaultMountsHomeDir(USER, VAULT)
    await mkdir(join(mh, ".ssh"), { recursive: true })
    await mkdir(join(mh, ".config", "gh"), { recursive: true })
    await writeFile(join(mh, ".gitconfig"), "[user]\n  name = test\n")
    const r = listVaultHomeMounts(USER, VAULT)
    expect(r.map(m => m.rel).sort()).toEqual([".config", ".gitconfig", ".ssh"])
    // Each src must be an absolute path under the vault dir
    for (const m of r) {
      expect(m.src.startsWith(personalVaultMountsHomeDir(USER, VAULT))).toBe(true)
    }
  })

  test("does NOT recurse into subdirectories — top-level only", async () => {
    await reset()
    const mh = personalVaultMountsHomeDir(USER, VAULT)
    await mkdir(join(mh, ".config", "gh"), { recursive: true })
    const r = listVaultHomeMounts(USER, VAULT)
    expect(r.map(m => m.rel)).toEqual([".config"])
    // .config is the single bind point; bwrap mounts the whole tree under it
  })
})
