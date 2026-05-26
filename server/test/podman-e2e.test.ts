/**
 * L4 E2E: actually spawn a podman container and exercise the full
 * ensureContainer → podman exec → namespace-sharing flow. This is the
 * test that proves the architectural goal of the refactor — SDK and PTY
 * sharing one PID namespace via container exec.
 *
 * Skipped automatically if `podman` is not installed on the host.
 *
 * The fixture builds a minimal loop dir tree then drives the lifecycle.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

const execFileP = promisify(execFile)

process.env.LOOPAT_HOME ??= `/tmp/loopat-e2e-podman-${process.pid}`
// Aggressive idle timeout so the test doesn't hang on cleanup.
process.env.LOOPAT_CONTAINER_IDLE_MS = "1000"

const {
  ensureContainer,
  stopContainer,
  removeContainer,
  buildPodmanExecArgs,
  containerName,
  containerExists,
  containerRunning,
  probePodman,
  V_LOOP_WORKDIR,
  markActive,
  markInactive,
  _resetActivityRegistryForTests,
} = await import("../src/podman")
const {
  LOOPAT_HOME,
  loopWorkdir,
  loopClaudeDir,
  loopContextKnowledge,
  loopContextNotes,
  loopHomeUpper,
  personalDir,
} = await import("../src/paths")
const TEST_HOME = LOOPAT_HOME
const LOOP_ID = "e2e1111-2222-3333-4444-555566667777"
const USER = "alice"

// Probe podman at module load so describe.skipIf sees the right value.
const podmanAvailable = (await probePodman()).ok
const podmanBin = process.env.LOOPAT_PODMAN_BIN || "podman"

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

async function cleanup() {
  if (podmanAvailable) {
    await removeContainer(LOOP_ID).catch(() => {})
  }
  await rm(TEST_HOME, { recursive: true, force: true })
}

beforeAll(setupFixture)
afterAll(cleanup)

describe.skipIf(!podmanAvailable)("podman E2E lifecycle", () => {
  test("ensureContainer creates+starts a container the first time", async () => {
    await removeContainer(LOOP_ID).catch(() => {})
    expect(await containerExists(LOOP_ID)).toBe(false)
    await ensureContainer({ loopId: LOOP_ID, createdBy: USER })
    expect(await containerRunning(LOOP_ID)).toBe(true)
  })

  test("ensureContainer is idempotent when args are unchanged", async () => {
    await ensureContainer({ loopId: LOOP_ID, createdBy: USER })
    await ensureContainer({ loopId: LOOP_ID, createdBy: USER })
    expect(await containerRunning(LOOP_ID)).toBe(true)
  })

  test("different extraEnv between callers does NOT recreate the container (regression: PTY exit-137 bug)", async () => {
    // term.ts passes vault envs only; session.ts adds ANTHROPIC_* + others.
    // If env participated in the config hash, the second call would tear
    // down the container, killing any process exec'd by the first caller
    // with SIGKILL — exactly the bug the user reported. Verify the
    // container's id is preserved across the two calls.
    await removeContainer(LOOP_ID).catch(() => {})
    await ensureContainer({
      loopId: LOOP_ID,
      createdBy: USER,
      extraEnv: { VAULT_KEY: "v" },
    })
    const { stdout: id1 } = await execFileP(podmanBin, ["inspect", "--format", "{{.Id}}", containerName(LOOP_ID)])
    await ensureContainer({
      loopId: LOOP_ID,
      createdBy: USER,
      extraEnv: {
        VAULT_KEY: "v",
        ANTHROPIC_API_KEY: "sk-test",
        ANTHROPIC_BASE_URL: "https://example",
        CLAUDE_CONFIG_DIR: "/loopat/loop/foo/.claude",
      },
    })
    const { stdout: id2 } = await execFileP(podmanBin, ["inspect", "--format", "{{.Id}}", containerName(LOOP_ID)])
    expect(id1.trim()).toBe(id2.trim())
    expect(await containerRunning(LOOP_ID)).toBe(true)
  })

  test("podman exec -i forwards stdin into the container (regression: chat-sends-but-never-responds bug)", async () => {
    // SDK pumps user messages as line-delimited stream-json on the claude
    // binary's stdin. Without `-i` on `podman exec`, that stdin is NOT
    // forwarded to the inner process — claude reads EOF, exits clean with
    // code 0, no output, and the chat appears frozen.
    await ensureContainer({ loopId: LOOP_ID, createdBy: USER })
    const args = buildPodmanExecArgs({
      loopId: LOOP_ID,
      command: "/bin/bash",
      args: ["-c", "read line && echo got=$line"],
      interactive: true,
    })
    const child = (await import("node:child_process")).spawn(podmanBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
    })
    child.stdin.write("hello-stdin\n")
    child.stdin.end()
    let out = ""
    child.stdout.on("data", (b) => (out += b.toString()))
    const code = await new Promise<number>((res) => child.on("exit", (c) => res(c ?? -1)))
    expect(code).toBe(0)
    expect(out.trim()).toBe("got=hello-stdin")
  }, 15_000)

  test("podman exec into the running container yields the right uid+host fs view", async () => {
    await ensureContainer({ loopId: LOOP_ID, createdBy: USER })
    const args = buildPodmanExecArgs({
      loopId: LOOP_ID,
      command: "/bin/bash",
      args: ["-c", "echo $(id -u):$(pwd)"],
      workdir: V_LOOP_WORKDIR(LOOP_ID),
    })
    const { stdout } = await execFileP(podmanBin, args)
    const out = stdout.trim()
    const [uid, pwd] = out.split(":")
    expect(Number(uid)).toBe(process.getuid?.() ?? -1)
    expect(pwd).toBe(V_LOOP_WORKDIR(LOOP_ID))
  })

  test("two execs share the same PID namespace (the whole point of the refactor)", async () => {
    await ensureContainer({ loopId: LOOP_ID, createdBy: USER })
    // Exec A: spawn a background sentinel that sleeps; record its PID.
    const sentinelArgs = buildPodmanExecArgs({
      loopId: LOOP_ID,
      command: "/bin/bash",
      args: [
        "-c",
        // background sleep, print its pid, exit (sleep keeps running as
        // container's PID 1 reaps later — we use --detach to make it survive)
        "sleep 30 & echo $!",
      ],
    })
    const { stdout: pid } = await execFileP(podmanBin, ["exec", "--detach-keys", "ctrl-q,ctrl-q", ...sentinelArgs.slice(1)])
    // The detach-keys flag is irrelevant for non-interactive; we just want
    // to read the printed PID. (Strip leading "exec" because we pass it
    // again in the slice.)
    const sentinelPid = Number(pid.trim().split("\n").pop())
    expect(Number.isFinite(sentinelPid)).toBe(true)

    // Exec B: a new exec, ask `ps` whether the sentinel PID is alive.
    const psArgs = buildPodmanExecArgs({
      loopId: LOOP_ID,
      command: "/bin/bash",
      args: ["-c", `ps -p ${sentinelPid} -o pid= 2>/dev/null | tr -d ' '`],
    })
    const { stdout: psOut } = await execFileP(podmanBin, psArgs)
    expect(psOut.trim()).toBe(String(sentinelPid))
    // Kill the sentinel before next test.
    const killArgs = buildPodmanExecArgs({
      loopId: LOOP_ID,
      command: "/bin/sh",
      args: ["-c", `kill ${sentinelPid} 2>/dev/null; true`],
    })
    await execFileP(podmanBin, killArgs).catch(() => {})
  }, 30_000)

  test("stopContainer brings the container down; subsequent ensureContainer restarts it", async () => {
    await ensureContainer({ loopId: LOOP_ID, createdBy: USER })
    await stopContainer(LOOP_ID)
    expect(await containerRunning(LOOP_ID)).toBe(false)
    // Container record persists; the upper-layer overlay is intact.
    expect(await containerExists(LOOP_ID)).toBe(true)
    await ensureContainer({ loopId: LOOP_ID, createdBy: USER })
    expect(await containerRunning(LOOP_ID)).toBe(true)
  })

  test("idle scheduler: container stops shortly after the last source goes inactive", async () => {
    _resetActivityRegistryForTests()
    await ensureContainer({ loopId: LOOP_ID, createdBy: USER })
    expect(await containerRunning(LOOP_ID)).toBe(true)
    // Simulate one active source (e.g. a chat session). Container stays up.
    markActive(LOOP_ID, "sdk")
    markActive(LOOP_ID, "pty")
    // Releasing one of two sources keeps container up.
    markInactive(LOOP_ID, "sdk")
    // Wait less than the idle window — container is still running because pty
    // source is still active.
    await new Promise((r) => setTimeout(r, 400))
    expect(await containerRunning(LOOP_ID)).toBe(true)
    // Now release the second source — the idle timer fires after 1s.
    markInactive(LOOP_ID, "pty")
    await new Promise((r) => setTimeout(r, 2500))
    expect(await containerRunning(LOOP_ID)).toBe(false)
  }, 20_000)
})
