/**
 * Pure-function tests for the podman sandbox builders. We exercise
 * buildVolumeMounts, buildContainerEnv, buildPodmanCreateArgs, and
 * buildPodmanExecArgs without ever invoking the podman binary.
 *
 * NOTE: LOOPAT_HOME must be set BEFORE source imports (paths.ts captures it
 * at module load time).
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

process.env.LOOPAT_HOME ??= `/tmp/loopat-podman-test-${process.pid}`

const {
  buildVolumeMounts,
  buildContainerEnv,
  buildPodmanCreateArgs,
  buildPodmanExecArgs,
  containerName,
  V_LOOP_CLAUDE,
  V_LOOP_WORKDIR,
  V_CONTEXT_PERSONAL,
  V_CONTEXT_KNOWLEDGE,
  V_CONTEXT_NOTES,
  V_HOME,
} = await import("../src/podman")
const {
  LOOPAT_HOME,
  WORKSPACE,
  loopWorkdir,
  loopClaudeDir,
  loopContextKnowledge,
  loopContextNotes,
  loopHomeUpper,
  personalDir,
  LOOPAT_INSTALL_DIR,
} = await import("../src/paths")
const TEST_HOME = LOOPAT_HOME
const HOST_HOME = homedir()

const LOOP_ID = "11111111-2222-3333-4444-555555555555"
const USER = "alice"

async function setupFixture() {
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

beforeAll(setupFixture)
afterAll(() => rm(TEST_HOME, { recursive: true, force: true }))

describe("buildVolumeMounts — core loop visibility", () => {
  test("loops/<id>/.claude is bound at V_LOOP_CLAUDE (rw)", async () => {
    const mounts = await buildVolumeMounts({ loopId: LOOP_ID, createdBy: USER })
    const m = mounts.find((m) => m.src === loopClaudeDir(LOOP_ID) && m.dst === V_LOOP_CLAUDE(LOOP_ID))
    expect(m).toBeDefined()
    expect(m!.ro).toBeFalsy()
  })

  test("loops/<id>/workdir is bound at V_LOOP_WORKDIR (rw)", async () => {
    const mounts = await buildVolumeMounts({ loopId: LOOP_ID, createdBy: USER })
    const m = mounts.find((m) => m.src === loopWorkdir(LOOP_ID) && m.dst === V_LOOP_WORKDIR(LOOP_ID))
    expect(m).toBeDefined()
    expect(m!.ro).toBeFalsy()
  })

  test("personal/<user>/ is bound at BOTH virtual path AND host-absolute path", async () => {
    const mounts = await buildVolumeMounts({ loopId: LOOP_ID, createdBy: USER })
    const dsts = mounts.filter((m) => m.src === personalDir(USER)).map((m) => m.dst)
    expect(dsts).toContain(V_CONTEXT_PERSONAL)
    expect(dsts).toContain(personalDir(USER))
  })

  test("LOOPAT_INSTALL_DIR is ro-bound at host-absolute path", async () => {
    const mounts = await buildVolumeMounts({ loopId: LOOP_ID, createdBy: USER })
    const m = mounts.find((m) => m.src === LOOPAT_INSTALL_DIR && m.dst === LOOPAT_INSTALL_DIR)
    expect(m).toBeDefined()
    expect(m!.ro).toBe(true)
  })

  test("$HOME is bound at V_HOME (= image passwd home, not host's homedir — see V_HOME comment)", async () => {
    const mounts = await buildVolumeMounts({ loopId: LOOP_ID, createdBy: USER })
    const m = mounts.find((m) => m.dst === V_HOME(USER))
    expect(m).toBeDefined()
    expect(m!.src).toBe(loopHomeUpper(LOOP_ID))
    // And NOT at host home — the whole point.
    expect(mounts.find((m) => m.dst === HOST_HOME)).toBeUndefined()
  })

  test("knowledge is ro by default", async () => {
    const mounts = await buildVolumeMounts({ loopId: LOOP_ID, createdBy: USER })
    const m = mounts.find((m) => m.dst === V_CONTEXT_KNOWLEDGE)
    expect(m).toBeDefined()
    expect(m!.ro).toBe(true)
  })

  test("knowledge becomes rw when knowledgeRw=true", async () => {
    const mounts = await buildVolumeMounts({ loopId: LOOP_ID, createdBy: USER, knowledgeRw: true })
    const m = mounts.find((m) => m.dst === V_CONTEXT_KNOWLEDGE)
    expect(m).toBeDefined()
    expect(m!.ro).toBeFalsy()
  })

  test("notes is always rw", async () => {
    const mounts = await buildVolumeMounts({ loopId: LOOP_ID, createdBy: USER })
    const m = mounts.find((m) => m.dst === V_CONTEXT_NOTES)
    expect(m).toBeDefined()
    expect(m!.ro).toBeFalsy()
  })
})

describe("buildVolumeMounts — plugin visibility via ~/.claude/plugins/", () => {
  test("when host's ~/.claude/plugins/ exists, it's ro-bound under the sandbox $HOME", async () => {
    const hostPluginsDir = join(HOST_HOME, ".claude", "plugins")
    const sandboxPluginsDir = join(V_HOME(USER), ".claude", "plugins")
    await mkdir(hostPluginsDir, { recursive: true })
    const mounts = await buildVolumeMounts({ loopId: LOOP_ID, createdBy: USER })
    const m = mounts.find((mt) => mt.src === hostPluginsDir && mt.dst === sandboxPluginsDir)
    expect(m).toBeDefined()
    expect(m!.ro).toBe(true)
  })

  test("when loop has a snapshot installed_plugins.json, it's bound OVER the sandbox's", async () => {
    const loopIp = join(loopClaudeDir(LOOP_ID), "plugins", "installed_plugins.json")
    await mkdir(join(loopClaudeDir(LOOP_ID), "plugins"), { recursive: true })
    await writeFile(loopIp, JSON.stringify({ version: 1, plugins: {} }))

    const mounts = await buildVolumeMounts({ loopId: LOOP_ID, createdBy: USER })
    const sandboxIp = join(V_HOME(USER), ".claude", "plugins", "installed_plugins.json")
    const m = mounts.find((mt) => mt.src === loopIp && mt.dst === sandboxIp)
    expect(m).toBeDefined()
    expect(m!.ro).toBe(true)
  })

  test("when loop has NO snapshot, no file-level bind is added", async () => {
    const loopIp = join(loopClaudeDir(LOOP_ID), "plugins", "installed_plugins.json")
    await rm(loopIp, { force: true })

    const mounts = await buildVolumeMounts({ loopId: LOOP_ID, createdBy: USER })
    const m = mounts.find((mt) => mt.src === loopIp)
    expect(m).toBeUndefined()
  })
})

describe("buildPodmanCreateArgs — container shape", () => {
  test("container is named loopat-<workspace>-<loopId>", async () => {
    const args = await buildPodmanCreateArgs({ loopId: LOOP_ID, createdBy: USER })
    const nameIdx = args.indexOf("--name")
    expect(nameIdx).toBeGreaterThanOrEqual(0)
    expect(args[nameIdx + 1]).toBe(`loopat-${WORKSPACE}-${LOOP_ID}`)
    expect(containerName(LOOP_ID)).toBe(`loopat-${WORKSPACE}-${LOOP_ID}`)
  })

  test("uses the content-hash loopat-sandbox image (locally built, no docker hub at runtime)", async () => {
    const args = await buildPodmanCreateArgs({ loopId: LOOP_ID, createdBy: USER })
    // Content-addressed (no workspace prefix) so images are reused across
    // workspaces instead of rebuilt per workspace; see podman.ts.
    expect(args).toContain(`loopat-sandbox:latest`)
  })

  test("includes --userns keep-id:uid=2000,gid=2000, --init, --network loopat-<ws>", async () => {
    const args = await buildPodmanCreateArgs({ loopId: LOOP_ID, createdBy: USER })
    const usernsIdx = args.indexOf("--userns")
    // Fixed loopat user at uid 2000 inside; see Containerfile + podman.ts.
    expect(args[usernsIdx + 1]).toBe("keep-id:uid=2000,gid=2000")
    expect(args).toContain("--init")
    const netIdx = args.indexOf("--network")
    expect(args[netIdx + 1]).toBe(`loopat-${WORKSPACE}`)
  })

  test("workdir defaults to V_LOOP_WORKDIR", async () => {
    const args = await buildPodmanCreateArgs({ loopId: LOOP_ID, createdBy: USER })
    const idx = args.indexOf("--workdir")
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe(V_LOOP_WORKDIR(LOOP_ID))
  })

  test("ends with <image> /bin/sleep infinity as the entrypoint", async () => {
    const args = await buildPodmanCreateArgs({ loopId: LOOP_ID, createdBy: USER })
    expect(args.slice(-3)).toEqual([`loopat-sandbox:latest`, "/bin/sleep", "infinity"])
  })

  test("each volume mount becomes a --volume src:dst[:ro] arg", async () => {
    const args = await buildPodmanCreateArgs({ loopId: LOOP_ID, createdBy: USER })
    // Find at least one rw and one ro volume.
    const volumes = args
      .map((a, i) => (a === "--volume" ? args[i + 1] : null))
      .filter((s): s is string => s !== null)
    expect(volumes.length).toBeGreaterThan(0)
    expect(volumes.some((v) => v === `${loopWorkdir(LOOP_ID)}:${V_LOOP_WORKDIR(LOOP_ID)}`)).toBe(true)
    expect(volumes.some((v) => v === `${LOOPAT_INSTALL_DIR}:${LOOPAT_INSTALL_DIR}:ro`)).toBe(true)
  })

  test("each env var becomes a --env K=V arg", async () => {
    const args = await buildPodmanCreateArgs({
      loopId: LOOP_ID,
      createdBy: USER,
      extraEnv: { ANTHROPIC_API_KEY: "sk-test", MY_VAR: "v" },
    })
    const envs = args
      .map((a, i) => (a === "--env" ? args[i + 1] : null))
      .filter((s): s is string => s !== null)
    expect(envs).toContain("ANTHROPIC_API_KEY=sk-test")
    expect(envs).toContain("MY_VAR=v")
  })

  test("includes a config-hash label so we can detect spec drift on restart", async () => {
    const args = await buildPodmanCreateArgs({ loopId: LOOP_ID, createdBy: USER })
    const labels = args
      .map((a, i) => (a === "--label" ? args[i + 1] : null))
      .filter((s): s is string => s !== null)
    expect(labels.some((l) => l.startsWith("loopat.config-hash="))).toBe(true)
    expect(labels.some((l) => l === `loopat.loop-id=${LOOP_ID}`)).toBe(true)
  })

  test("config-hash changes when vault changes", async () => {
    const a = await buildPodmanCreateArgs({ loopId: LOOP_ID, createdBy: USER, vaultName: "default" })
    const b = await buildPodmanCreateArgs({ loopId: LOOP_ID, createdBy: USER, vaultName: "prod" })
    const hashA = a.find((s) => s.startsWith("loopat.config-hash="))
    const hashB = b.find((s) => s.startsWith("loopat.config-hash="))
    expect(hashA).toBeDefined()
    expect(hashB).toBeDefined()
    expect(hashA).not.toBe(hashB)
  })

  test("config-hash does NOT change when only extraEnv differs (regression: PTY exit-137 bug)", async () => {
    // term.ts and session.ts call ensureContainer with the same loop opts
    // but DIFFERENT extraEnv (PTY only needs vault envs; SDK adds
    // ANTHROPIC_API_KEY / CLAUDE_CONFIG_DIR / etc.). If env were part of
    // the hash, the second caller would force-recreate the container,
    // SIGKILL'ing the first caller's exec'd process (the actual bug
    // behind "PTY exits 137 when chat starts").
    const ptyLike = await buildPodmanCreateArgs({
      loopId: LOOP_ID,
      createdBy: USER,
      extraEnv: { VAULT_KEY: "v" },
    })
    const sdkLike = await buildPodmanCreateArgs({
      loopId: LOOP_ID,
      createdBy: USER,
      extraEnv: {
        VAULT_KEY: "v",
        ANTHROPIC_API_KEY: "sk-test",
        ANTHROPIC_BASE_URL: "https://example",
        CLAUDE_CONFIG_DIR: "/loopat/loop/.../.claude",
      },
    })
    const hashPty = ptyLike.find((s) => s.startsWith("loopat.config-hash="))
    const hashSdk = sdkLike.find((s) => s.startsWith("loopat.config-hash="))
    expect(hashPty).toBe(hashSdk)
  })
})

describe("buildPodmanExecArgs — shape", () => {
  test("exec into the right container with the right command", () => {
    const args = buildPodmanExecArgs({
      loopId: LOOP_ID,
      command: "/bin/bash",
      args: ["-c", "echo hi"],
    })
    expect(args[0]).toBe("exec")
    expect(args).toContain(containerName(LOOP_ID))
    // command + arg tail
    const tail = args.slice(-3)
    expect(tail).toEqual(["/bin/bash", "-c", "echo hi"])
  })

  test("--tty / --interactive flags wire through", () => {
    const args = buildPodmanExecArgs({
      loopId: LOOP_ID,
      command: "/bin/bash",
      args: [],
      tty: true,
      interactive: true,
    })
    expect(args).toContain("--tty")
    expect(args).toContain("--interactive")
  })

  test("env vars become --env K=V before container name", () => {
    const args = buildPodmanExecArgs({
      loopId: LOOP_ID,
      command: "/bin/true",
      args: [],
      env: { FOO: "bar" },
    })
    const idx = args.indexOf("--env")
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe("FOO=bar")
    // env arg comes before container name
    expect(idx).toBeLessThan(args.indexOf(containerName(LOOP_ID)))
  })

  test("--workdir option wires to -w", () => {
    const args = buildPodmanExecArgs({
      loopId: LOOP_ID,
      command: "/bin/pwd",
      args: [],
      workdir: "/loopat/loop/abc/workdir",
    })
    const idx = args.indexOf("--workdir")
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe("/loopat/loop/abc/workdir")
  })
})

describe("buildContainerEnv — caller env wins", () => {
  test("extraEnv entries land in the resulting env map", async () => {
    const env = await buildContainerEnv({
      loopId: LOOP_ID,
      createdBy: USER,
      extraEnv: { ANTHROPIC_API_KEY: "sk-test", VAULT_KEY: "v" },
    })
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test")
    expect(env.VAULT_KEY).toBe("v")
  })
})
