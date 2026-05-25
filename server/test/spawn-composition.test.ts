/**
 * L3+: spawn-time composition glue.
 *
 * Asserts the chain session.ts executes at every spawn:
 *
 *   vault/envs/* + provider.apiKey (${VAR}) + merged settings.json mcpServers
 *      ↓ (loadPersonalConfig + buildBwrapArgs)
 *   bwrap argv with --setenv X Y entries and the mcpServers JSON ready to
 *   be passed through to the spawned claude binary verbatim.
 *
 * This is the integration that the vault refactor's behavior depends on.
 * We don't spawn a real claude here; that's L4.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

process.env.LOOPAT_HOME ??= `/tmp/loopat-spawn-comp-${process.pid}`
process.env.LOOPAT_NO_HOME_OVERLAY = "1"

const { buildBwrapArgs, V_LOOP_CLAUDE } = await import("../src/bwrap")
const { loadPersonalConfig, clearPersonalCache } = await import("../src/config")
const {
  LOOPAT_HOME,
  loopWorkdir,
  loopClaudeDir,
  loopContextKnowledge,
  loopContextNotes,
  personalDir,
  personalLoopatDir,
  personalLoopatConfigPath,
  personalVaultEnvsDir,
  personalVaultEnvPath,
  personalVaultMountsHomeDir,
  workspaceTeamClaudeDir,
  workspaceTeamSettingsPath,
} = await import("../src/paths")
const TEST_HOME = LOOPAT_HOME

const LOOP_ID = "cccccccc-1111-2222-3333-444444444444"
const USER = "alice"

async function setup() {
  await rm(TEST_HOME, { recursive: true, force: true })
  await mkdir(loopWorkdir(LOOP_ID), { recursive: true })
  await mkdir(loopClaudeDir(LOOP_ID), { recursive: true })
  await mkdir(loopContextKnowledge(LOOP_ID), { recursive: true })
  await mkdir(loopContextNotes(LOOP_ID), { recursive: true })
  await mkdir(personalLoopatDir(USER), { recursive: true })
  await mkdir(personalVaultEnvsDir(USER, "default"), { recursive: true })
  await writeFile(join(TEST_HOME, "config.json"), "{}")
  // Vault envs: provider key + an MCP token + a generic env
  await writeFile(personalVaultEnvPath(USER, "default", "ANTHROPIC_API_KEY"), "sk-anthropic-test\n")
  await writeFile(personalVaultEnvPath(USER, "default", "MCP_COOP_TOKEN"), "mcpa_coop_xxx\n")
  await writeFile(personalVaultEnvPath(USER, "default", "GENERIC_VAR"), "generic-value\n")
  // Personal config — provider uses ${VAR}
  await writeFile(personalLoopatConfigPath(USER), JSON.stringify({
    providers: {
      default: "anthropic",
      anthropic: {
        baseUrl: "https://anthropic.example.com/api/anthropic",
        model: "claude-opus-4-7",
        apiKey: "${ANTHROPIC_API_KEY}",
      },
    },
  }))
  // Merged loop settings.json with mcpServers that reference ${VAR}
  await writeFile(join(loopClaudeDir(LOOP_ID), "settings.json"), JSON.stringify({
    mcpServers: {
      coop: {
        type: "http",
        url: "https://mcp.example.com/coop/mcp",
        headers: { Authorization: "Bearer ${MCP_COOP_TOKEN}" },
      },
    },
  }))
  // Team-tier settings (not strictly needed for this test, but realistic)
  await mkdir(workspaceTeamClaudeDir(), { recursive: true })
  await writeFile(workspaceTeamSettingsPath(), JSON.stringify({ mcpServers: {} }))
  clearPersonalCache(USER)
}

beforeAll(setup)
afterAll(() => rm(TEST_HOME, { recursive: true, force: true }))

function findSetenv(argv: string[], key: string): string | undefined {
  for (let i = 0; i < argv.length - 2; i++) {
    if (argv[i] === "--setenv" && argv[i + 1] === key) return argv[i + 2]
  }
  return undefined
}

describe("spawn-time composition — vault envs reach sandbox via bwrap --setenv", () => {
  test("loadPersonalConfig resolves provider apiKey from vault envs", async () => {
    const cfg = await loadPersonalConfig(USER, "default")
    expect(cfg.providers.anthropic.apiKey).toBe("sk-anthropic-test")
  })

  test("vaultEnvs on cfg includes ALL envs/* (provider + MCP + generic)", async () => {
    const cfg = await loadPersonalConfig(USER, "default")
    expect(cfg.vaultEnvs).toMatchObject({
      ANTHROPIC_API_KEY: "sk-anthropic-test",
      MCP_COOP_TOKEN: "mcpa_coop_xxx",
      GENERIC_VAR: "generic-value",
    })
  })

  test("bwrap argv carries every vault env as --setenv (the actual session.ts pattern)", async () => {
    const cfg = await loadPersonalConfig(USER, "default")
    const extraEnv = {
      ...cfg.vaultEnvs,
      ANTHROPIC_API_KEY: cfg.providers.anthropic.apiKey,
      ANTHROPIC_BASE_URL: cfg.providers.anthropic.baseUrl,
      CLAUDE_CONFIG_DIR: V_LOOP_CLAUDE(LOOP_ID),
    }
    const argv = await buildBwrapArgs(LOOP_ID, USER, extraEnv, "default")
    expect(findSetenv(argv, "ANTHROPIC_API_KEY")).toBe("sk-anthropic-test")
    expect(findSetenv(argv, "MCP_COOP_TOKEN")).toBe("mcpa_coop_xxx")
    expect(findSetenv(argv, "GENERIC_VAR")).toBe("generic-value")
    // ANTHROPIC_API_KEY is the alias that the claude SDK reads
    expect(findSetenv(argv, "ANTHROPIC_API_KEY")).toBe("sk-anthropic-test")
    expect(findSetenv(argv, "ANTHROPIC_BASE_URL")).toBe("https://anthropic.example.com/api/anthropic")
  })

  test("merged settings.json mcpServers headers preserve ${VAR} (substituted by spawned binary)", async () => {
    const merged = JSON.parse(await readFile(join(loopClaudeDir(LOOP_ID), "settings.json"), "utf8"))
    const coop = merged.mcpServers.coop
    // CRUCIAL: literal ${VAR} must survive — the spawned claude binary
    // substitutes it from its own process.env, which is what we just injected.
    expect(coop.headers.Authorization).toBe("Bearer ${MCP_COOP_TOKEN}")
  })

  test("provider with missing ${VAR} → empty apiKey (provider effectively unusable)", async () => {
    // Add a provider whose ${VAR} doesn't exist in vault
    await writeFile(personalLoopatConfigPath(USER), JSON.stringify({
      providers: {
        default: "anthropic",
        anthropic: { baseUrl: "u", model: "m", apiKey: "${ANTHROPIC_API_KEY}" },
        ghostly: { baseUrl: "u", model: "m", apiKey: "${NOT_IN_VAULT}" },
      },
    }))
    clearPersonalCache(USER)
    const cfg = await loadPersonalConfig(USER, "default")
    expect(cfg.providers.anthropic.apiKey).toBe("sk-anthropic-test")
    expect(cfg.providers.ghostly.apiKey).toBe("")
  })
})

describe("spawn-time composition — mounts/home/ → $HOME via bwrap binds", () => {
  test("vault mounts/home/<entry> reaches sandbox $HOME alongside vault envs", async () => {
    // Add a mount alongside the envs
    const mh = personalVaultMountsHomeDir(USER, "default")
    await mkdir(join(mh, ".ssh"), { recursive: true })
    await writeFile(join(mh, ".ssh", "id_ed25519"), "FAKE_PRIV_KEY")
    await writeFile(join(mh, ".gitconfig"), "[user]\nname = test\n")

    const cfg = await loadPersonalConfig(USER, "default")
    const argv = await buildBwrapArgs(LOOP_ID, USER, cfg.vaultEnvs, "default")

    // Each top-level entry under mounts/home/ → --bind-try at $HOME/<rel>
    const { homedir } = await import("node:os")
    const HOME = homedir()
    const binds: Array<[string, string]> = []
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--bind-try") binds.push([argv[i + 1], argv[i + 2]])
    }
    expect(binds.some(([s, d]) => s === join(mh, ".ssh") && d === join(HOME, ".ssh"))).toBe(true)
    expect(binds.some(([s, d]) => s === join(mh, ".gitconfig") && d === join(HOME, ".gitconfig"))).toBe(true)
  })
})
