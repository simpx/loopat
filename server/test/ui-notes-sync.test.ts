/**
 * git-as-database stage 0: notes edited through a per-user UI-loop worktree
 * (opened from origin/main), saved back with the same ff-only + rebase +
 * held-back rule as personal. Local bare repo as origin + a second clone to
 * simulate a concurrent writer.
 */
import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { promisify } from "node:util"
import { execFile } from "node:child_process"

const run = promisify(execFile)
const g = (args: string[], cwd?: string) => run("git", cwd ? ["-C", cwd, ...args] : args)

let home: string
let loops: any
let paths: any
let wt: string
let other: string
const user = "uitest"

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "loopat-uinotes-"))
  process.env.LOOPAT_HOME = home
  loops = await import("../src/loops.ts")
  paths = await import("../src/paths.ts")

  const origin = join(home, "notes-origin.git")
  other = join(home, "other")
  await g(["init", "--bare", "-b", "main", origin])
  const ctx = paths.workspaceNotesDir()
  await mkdir(dirname(ctx), { recursive: true })
  await g(["clone", origin, ctx])
  await writeFile(join(ctx, "seed.md"), "seed\n")
  await g(["add", "-A"], ctx)
  await g(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], ctx)
  await g(["push", "origin", "HEAD:main"], ctx)
  await g(["clone", origin, other])

  await loops.ensureUiNotesWorktree(user)
  wt = paths.uiNotesDir(user)
})

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

async function remoteEdit(f: string, c: string, m: string) {
  await g(["fetch", "origin"], other)
  await g(["reset", "--hard", "origin/main"], other)
  await writeFile(join(other, f), c)
  await g(["add", "-A"], other)
  await g(["-c", "user.email=o@o", "-c", "user.name=o", "commit", "-m", m], other)
  await g(["push", "origin", "HEAD:main"], other)
}

test("UI-loop worktree opens from origin/main", () => {
  expect(existsSync(join(wt, ".git"))).toBe(true)
  expect(existsSync(join(wt, "seed.md"))).toBe(true)
})

test("saving a note ff-pushes to origin", async () => {
  await writeFile(join(wt, "note1.md"), "n1\n")
  const r = await loops.syncUiNotes(user)
  expect(r.ok).toBe(true)
  await g(["fetch", "origin"], other)
  await g(["reset", "--hard", "origin/main"], other)
  expect(existsSync(join(other, "note1.md"))).toBe(true)
})

test("remote moved elsewhere → rebase keeps local note AND pulls remote", async () => {
  await remoteEdit("remote.md", "r\n", "remote change")
  await writeFile(join(wt, "note2.md"), "n2\n")
  const r = await loops.syncUiNotes(user)
  expect(r.ok).toBe(true)
  expect(existsSync(join(wt, "note2.md"))).toBe(true)
  expect(existsSync(join(wt, "remote.md"))).toBe(true)
})

test("notesBehind detects a remote update", async () => {
  await remoteEdit("hint.md", "h\n", "remote update for behind")
  expect(await loops.notesBehind(user)).toBeGreaterThan(0)
})

test("refresh (ffUpdateUiNotes) ff-pulls and clears behind", async () => {
  const r = await loops.ffUpdateUiNotes(user)
  expect(r.ok).toBe(true)
  expect(existsSync(join(wt, "hint.md"))).toBe(true)
  expect(await loops.notesBehind(user)).toBe(0)
})

test("kanban writes land in the user's worktree and push to origin", async () => {
  const kanban = await import("../src/kanban.ts")
  await kanban.kanbanUserCtx.run(user, async () => {
    await kanban.addCard("default", "todo.md", { text: "hello-kanban" })
  })
  // written into the per-user notes worktree, under focus/boards/
  expect(existsSync(join(wt, "focus", "boards", "default", "todo.md"))).toBe(true)
  // pushed by the explicit notes save, like any edit
  const r = await loops.syncUiNotes(user)
  expect(r.ok).toBe(true)
  await g(["fetch", "origin"], other)
  await g(["reset", "--hard", "origin/main"], other)
  expect(existsSync(join(other, "focus", "boards", "default", "todo.md"))).toBe(true)
})

test("real conflict held back; the local edit is NOT lost", async () => {
  await remoteEdit("seed.md", "seed-remote\n", "remote edits seed")
  await writeFile(join(wt, "seed.md"), "seed-local\n")
  const r = await loops.syncUiNotes(user)
  expect(r.ok).toBe(false)
  expect(r.conflict).toBe(true)
  expect(r.files).toContain("seed.md")
  expect((await readFile(join(wt, "seed.md"), "utf8")).trim()).toBe("seed-local")
})
