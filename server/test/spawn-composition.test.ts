/**
 * L3+: spawn-time composition glue.
 *
 * Asserts the chain session.ts executes at every spawn:
 *
 *   vault/envs/* + provider.apiKey (${VAR}) + merged settings.json mcpServers
 *      ↓ (loadPersonalConfig + buildPodmanCreateArgs)
 *   podman argv with --env K=V entries and the mcpServers JSON ready to
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

const { buildPodmanCreateArgs, V_LOOP_CLAUDE, V_HOME } = await import("../src/podman")
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
  await writeFile(personalVaultEnvPath(USER, "default", "IDEALAB_API_KEY"), "sk-idealab-test\n")
  await writeFile(personalVaultEnvPath(USER, "default", "MCP_COOP_TOKEN"), "mcpa_coop_xxx\n")
  await writeFile(personalVaultEnvPath(USER, "default", "GENERIC_VAR"), "generic-value\n")
  // Personal config — provider uses ${VAR}
  await writeFile(personalLoopatConfigPath(USER), JSON.stringify({
    providers: {
      default: "idealab",
      idealab: {
        baseUrl: "https://idealab.example.com/api/anthropic",
        model: "claude-opus-4-7",
        apiKey: "${IDEALAB_API_KEY}",
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

function findEnv(argv: string[], key: string): string | undefined {
  const prefix = `${key}=`
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "--env" && argv[i + 1].startsWith(prefix)) {
      return argv[i + 1].slice(prefix.length)
    }
  }
  return undefined
}

describe("spawn-time composition — vault envs reach sandbox via podman --env", () => {
  test("loadPersonalConfig resolves provider apiKey from vault envs", async () => {
    const cfg = await loadPersonalConfig(USER, "default")
    expect(cfg.providers.idealab.apiKey).toBe("sk-idealab-test")
  })

  test("vaultEnvs on cfg includes ALL envs/* (provider + MCP + generic)", async () => {
    const cfg = await loadPersonalConfig(USER, "default")
    expect(cfg.vaultEnvs).toMatchObject({
      IDEALAB_API_KEY: "sk-idealab-test",
      MCP_COOP_TOKEN: "mcpa_coop_xxx",
      GENERIC_VAR: "generic-value",
    })
  })

  test("podman argv carries every vault env as --env (the actual session.ts pattern)", async () => {
    const cfg = await loadPersonalConfig(USER, "default")
    const extraEnv = {
      ...cfg.vaultEnvs,
      ANTHROPIC_API_KEY: cfg.providers.idealab.apiKey,
      ANTHROPIC_BASE_URL: cfg.providers.idealab.baseUrl,
      CLAUDE_CONFIG_DIR: V_LOOP_CLAUDE(LOOP_ID),
    }
    const argv = await buildPodmanCreateArgs({
      loopId: LOOP_ID,
      createdBy: USER,
      vaultName: "default",
      extraEnv,
    })
    expect(findEnv(argv, "IDEALAB_API_KEY")).toBe("sk-idealab-test")
    expect(findEnv(argv, "MCP_COOP_TOKEN")).toBe("mcpa_coop_xxx")
    expect(findEnv(argv, "GENERIC_VAR")).toBe("generic-value")
    // ANTHROPIC_API_KEY is the alias that the claude SDK reads
    expect(findEnv(argv, "ANTHROPIC_API_KEY")).toBe("sk-idealab-test")
    expect(findEnv(argv, "ANTHROPIC_BASE_URL")).toBe("https://idealab.example.com/api/anthropic")
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
        default: "idealab",
        idealab: { baseUrl: "u", model: "m", apiKey: "${IDEALAB_API_KEY}" },
        ghostly: { baseUrl: "u", model: "m", apiKey: "${NOT_IN_VAULT}" },
      },
    }))
    clearPersonalCache(USER)
    const cfg = await loadPersonalConfig(USER, "default")
    expect(cfg.providers.idealab.apiKey).toBe("sk-idealab-test")
    expect(cfg.providers.ghostly.apiKey).toBe("")
  })
})

describe("spawn-time composition — mounts/home/ → $HOME via podman --volume", () => {
  test("vault mounts/home/<entry> reaches sandbox $HOME alongside vault envs", async () => {
    // Add a mount alongside the envs
    const mh = personalVaultMountsHomeDir(USER, "default")
    await mkdir(join(mh, ".ssh"), { recursive: true })
    await writeFile(join(mh, ".ssh", "id_ed25519"), "FAKE_PRIV_KEY")
    await writeFile(join(mh, ".gitconfig"), "[user]\nname = test\n")

    const cfg = await loadPersonalConfig(USER, "default")
    const argv = await buildPodmanCreateArgs({
      loopId: LOOP_ID,
      createdBy: USER,
      vaultName: "default",
      extraEnv: cfg.vaultEnvs,
    })

    // Each top-level entry under mounts/home/ → --volume at sandbox $HOME/<rel>
    const SANDBOX_HOME = V_HOME(USER)
    const volumes: string[] = []
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--volume") volumes.push(argv[i + 1])
    }
    expect(volumes).toContain(`${join(mh, ".ssh")}:${join(SANDBOX_HOME, ".ssh")}`)
    expect(volumes).toContain(`${join(mh, ".gitconfig")}:${join(SANDBOX_HOME, ".gitconfig")}`)
  })
})
