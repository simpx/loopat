/**
 * L3: vault delivery via bwrap argv.
 *
 * Asserts the new vault refactor's contract: vault/mounts/home/<rel> →
 * --bind-try at $HOME/<rel>. Also asserts the absence of the old behavior
 * (no /loopat/context/vault symlink; no personal config.json mounts).
 *
 * Same pattern as bwrap.test.ts — build argv only, no real bwrap exec.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

process.env.LOOPAT_HOME ??= `/tmp/loopat-bwrap-vault-${process.pid}`
process.env.LOOPAT_NO_HOME_OVERLAY = "1"

const { buildBwrapArgs } = await import("../src/bwrap")
const {
  LOOPAT_HOME,
  loopWorkdir,
  loopClaudeDir,
  loopContextKnowledge,
  loopContextNotes,
  personalDir,
  personalVaultMountsHomeDir,
} = await import("../src/paths")
const TEST_HOME = LOOPAT_HOME

const LOOP_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const USER = "alice"
const HOME = homedir()

async function reset() {
  await rm(TEST_HOME, { recursive: true, force: true })
  await mkdir(loopWorkdir(LOOP_ID), { recursive: true })
  await mkdir(loopClaudeDir(LOOP_ID), { recursive: true })
  await mkdir(loopContextKnowledge(LOOP_ID), { recursive: true })
  await mkdir(loopContextNotes(LOOP_ID), { recursive: true })
  await mkdir(join(personalDir(USER), ".loopat", "vaults", "default"), { recursive: true })
  await writeFile(join(personalDir(USER), ".loopat", "config.json"), "{}")
  await writeFile(join(TEST_HOME, "config.json"), "{}")
}

beforeAll(reset)
afterAll(() => rm(TEST_HOME, { recursive: true, force: true }))

/** Collect bwrap bind pairs. */
function collectBinds(argv: string[]): Array<{ flag: string; src: string; dst: string }> {
  const out: Array<{ flag: string; src: string; dst: string }> = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--bind" || a === "--ro-bind" || a === "--bind-try" || a === "--ro-bind-try") {
      out.push({ flag: a, src: argv[i + 1], dst: argv[i + 2] })
      i += 2
    }
  }
  return out
}

describe("buildBwrapArgs — vault/mounts/home/ auto-bind", () => {
  test("each top-level entry under mounts/home/ becomes a --bind-try at $HOME/<rel>", async () => {
    await reset()
    const mh = personalVaultMountsHomeDir(USER, "default")
    await mkdir(join(mh, ".ssh"), { recursive: true })
    await mkdir(join(mh, ".config", "gh"), { recursive: true })
    await writeFile(join(mh, ".gitconfig"), "[user]\nname = test\n")

    const argv = await buildBwrapArgs(LOOP_ID, USER, {}, "default")
    const binds = collectBinds(argv)

    const sshBind = binds.find(b => b.src === join(mh, ".ssh") && b.dst === join(HOME, ".ssh"))
    const cfgBind = binds.find(b => b.src === join(mh, ".config") && b.dst === join(HOME, ".config"))
    const gitBind = binds.find(b => b.src === join(mh, ".gitconfig") && b.dst === join(HOME, ".gitconfig"))

    expect(sshBind?.flag).toBe("--bind-try")
    expect(cfgBind?.flag).toBe("--bind-try")
    expect(gitBind?.flag).toBe("--bind-try")
  })

  test("no entries → no vault binds emitted (no spurious args)", async () => {
    await reset()
    // mounts/home/ does not exist
    const argv = await buildBwrapArgs(LOOP_ID, USER, {}, "default")
    const vaultBinds = collectBinds(argv).filter(b =>
      b.src.startsWith(personalVaultMountsHomeDir(USER, "default")),
    )
    expect(vaultBinds).toEqual([])
  })

  test("subdirectories inside top-level entries are NOT separately bound", async () => {
    await reset()
    const mh = personalVaultMountsHomeDir(USER, "default")
    await mkdir(join(mh, ".config", "gh"), { recursive: true })
    await mkdir(join(mh, ".config", "a1"), { recursive: true })

    const argv = await buildBwrapArgs(LOOP_ID, USER, {}, "default")
    const vaultBinds = collectBinds(argv).filter(b =>
      b.src.startsWith(personalVaultMountsHomeDir(USER, "default")),
    )
    // Only one bind: the whole .config dir. gh and a1 are NOT individually bound.
    expect(vaultBinds.length).toBe(1)
    expect(vaultBinds[0].src).toBe(join(mh, ".config"))
  })

  test("vault selection: dev vault entries used when vaultName=dev", async () => {
    await reset()
    const mhDefault = personalVaultMountsHomeDir(USER, "default")
    const mhDev = personalVaultMountsHomeDir(USER, "dev")
    await mkdir(join(mhDefault, ".gitconfig"), { recursive: true })
    await mkdir(join(mhDev, ".ssh"), { recursive: true })

    const argv = await buildBwrapArgs(LOOP_ID, USER, {}, "dev")
    const binds = collectBinds(argv)
    const ssh = binds.find(b => b.src === join(mhDev, ".ssh"))
    const gitFromDefault = binds.find(b => b.src === join(mhDefault, ".gitconfig"))
    expect(ssh).toBeTruthy()
    expect(gitFromDefault).toBeUndefined()
  })
})

describe("buildBwrapArgs — old vault entrypoint is gone", () => {
  test("no --symlink targeting /loopat/context/vault", async () => {
    await reset()
    const argv = await buildBwrapArgs(LOOP_ID, USER, {}, "default")
    const idx = argv.indexOf("--symlink")
    const symlinks: Array<{ src: string; dst: string }> = []
    let i = idx
    while (i >= 0) {
      symlinks.push({ src: argv[i + 1], dst: argv[i + 2] })
      i = argv.indexOf("--symlink", i + 1)
    }
    const vaultSym = symlinks.find(s => s.dst === "/loopat/context/vault")
    expect(vaultSym).toBeUndefined()
  })

  test("V_CONTEXT_VAULT export is gone — module does not re-export it", async () => {
    const mod = await import("../src/bwrap")
    expect((mod as any).V_CONTEXT_VAULT).toBeUndefined()
  })
})

describe("buildBwrapArgs — extraSetenv reaches sandbox", () => {
  test("each extraSetenv entry becomes --setenv K V (used for vault envs at spawn time)", async () => {
    await reset()
    const argv = await buildBwrapArgs(LOOP_ID, USER, {
      ANTHROPIC_API_KEY: "sk-test",
      MY_VAR: "value with spaces",
    }, "default")

    // Find --setenv ANTHROPIC_API_KEY sk-test
    const findSetenv = (k: string) => {
      for (let i = 0; i < argv.length - 2; i++) {
        if (argv[i] === "--setenv" && argv[i + 1] === k) return argv[i + 2]
      }
      return undefined
    }
    expect(findSetenv("ANTHROPIC_API_KEY")).toBe("sk-test")
    expect(findSetenv("MY_VAR")).toBe("value with spaces")
  })
})
