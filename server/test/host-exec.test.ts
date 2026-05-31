/**
 * host-cli proxy POC: a whitelisted cli runs on the host, in a per-loop host
 * workdir, with the exit code propagated; non-whitelisted is refused; a shim is
 * generated per declared cli.
 */
import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let home: string
let hostExec: any
let cwd: string

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "loopat-hostexec-"))
  process.env.LOOPAT_HOME = home
  hostExec = await import("../src/host-exec.ts")
  cwd = join(home, "host-workdir")
})

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

test("whitelisted cli runs on the host and returns stdout", async () => {
  const r = await hostExec.runHostCli({ cli: "echo", args: ["hello", "world"], cwd, allowed: ["echo"] })
  expect(r.ok).toBe(true)
  expect(r.stdout.trim()).toBe("hello world")
  expect(r.exitCode).toBe(0)
})

test("non-whitelisted cli is refused (never reaches the host)", async () => {
  const r = await hostExec.runHostCli({ cli: "rm", args: ["-rf", "/"], cwd, allowed: ["echo"] })
  expect(r.ok).toBe(false)
  expect(r.error).toContain("not allowed")
})

test("runs in the per-loop host workdir", async () => {
  const r = await hostExec.runHostCli({ cli: "touch", args: ["marker"], cwd, allowed: ["touch"] })
  expect(r.ok).toBe(true)
  expect(existsSync(join(cwd, "marker"))).toBe(true) // file landed in the loop's host workdir
})

test("missing host cli reports clearly", async () => {
  const r = await hostExec.runHostCli({ cli: "no-such-cli-xyz", args: [], cwd, allowed: ["no-such-cli-xyz"] })
  expect(r.ok).toBe(false)
  expect(r.error).toContain("host has no")
})

test("exit code propagates", async () => {
  const r = await hostExec.runHostCli({ cli: "sh", args: ["-c", "exit 3"], cwd, allowed: ["sh"] })
  expect(r.ok).toBe(true)
  expect(r.exitCode).toBe(3)
})

test("stdin is forwarded", async () => {
  const r = await hostExec.runHostCli({ cli: "cat", args: [], cwd, allowed: ["cat"], stdin: "piped-in\n" })
  expect(r.ok).toBe(true)
  expect(r.stdout.trim()).toBe("piped-in")
})

test("writeHostShims writes an executable shim per declared cli", async () => {
  const binDir = join(home, "bin")
  await hostExec.writeHostShims(binDir, ["aone", "company-cli"])
  for (const cli of ["aone", "company-cli"]) {
    const p = join(binDir, cli)
    expect(existsSync(p)).toBe(true)
    expect(await readFile(p, "utf8")).toContain(`exec loopat-host "${cli}"`)
    expect((await stat(p)).mode & 0o111).toBeGreaterThan(0) // executable
  }
})
