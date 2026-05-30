/**
 * Personal sync = the loop-outside (no-AI) rule from docs/context-flow.md:
 * ff-only, rebase local onto origin when it moved, hold back a real same-spot
 * conflict (never lose the local edit), and `force` = take remote.
 *
 * Uses a local bare repo as `origin` + a second clone (`other`) to simulate a
 * concurrent writer. No platform/network needed.
 */
import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { execFile } from "node:child_process"

const run = promisify(execFile)
const g = (args: string[], cwd?: string) => run("git", cwd ? ["-C", cwd, ...args] : args)

let home: string
let loops: any
const user = "synctest"
let pdir: string
let origin: string
let other: string

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "loopat-personal-sync-"))
  process.env.LOOPAT_HOME = home
  loops = await import("../src/loops.ts")
  pdir = join(home, "personal", user)
  origin = join(home, "origin.git")
  other = join(home, "other")

  await g(["init", "--bare", "-b", "main", origin])
  await g(["clone", origin, pdir])
  await writeFile(join(pdir, "a.txt"), "a1\n")
  await g(["add", "-A"], pdir)
  await g(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], pdir)
  await g(["push", "origin", "HEAD:main"], pdir)
  await g(["clone", origin, other])
})

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

/** Simulate a concurrent writer landing a commit on origin/main. */
async function remoteEdit(file: string, content: string, msg: string) {
  await g(["fetch", "origin"], other)
  await g(["reset", "--hard", "origin/main"], other)
  await writeFile(join(other, file), content)
  await g(["add", "-A"], other)
  await g(["-c", "user.email=o@o", "-c", "user.name=o", "commit", "-m", msg], other)
  await g(["push", "origin", "HEAD:main"], other)
}

// Ordered: each test builds on the previous one's state, like a real session.

test("clean push fast-forwards", async () => {
  await writeFile(join(pdir, "b.txt"), "b1\n")
  const r = await loops.pushPersonalToRemote(user)
  expect(r.ok).toBe(true)
})

test("remote moved elsewhere → rebase keeps local AND pulls remote", async () => {
  await remoteEdit("remote.txt", "r1\n", "remote change")
  await writeFile(join(pdir, "c.txt"), "c1\n")
  const r = await loops.pushPersonalToRemote(user)
  expect(r.ok).toBe(true)
  expect(existsSync(join(pdir, "c.txt"))).toBe(true) // local edit kept
  expect(existsSync(join(pdir, "remote.txt"))).toBe(true) // remote folded in
})

test("real same-spot conflict is held back; local edit is NOT lost", async () => {
  await remoteEdit("a.txt", "a-remote\n", "remote edits a")
  await writeFile(join(pdir, "a.txt"), "a-local\n")
  const r = await loops.pushPersonalToRemote(user)
  expect(r.ok).toBe(false)
  expect(r.conflict).toBe(true)
  expect(r.files).toContain("a.txt")
  // the whole point: the local edit survives the held-back push
  expect((await readFile(join(pdir, "a.txt"), "utf8")).trim()).toBe("a-local")
})

test("force pull = take remote (discards local edit)", async () => {
  const r = await loops.pullPersonalFromRemote(user, { force: true })
  expect(r.ok).toBe(true)
  expect((await readFile(join(pdir, "a.txt"), "utf8")).trim()).toBe("a-remote")
})
