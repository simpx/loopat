/**
 * e2e scenario #2 — basic context flow.
 *
 * Proves the core loop⇄context contract from docs/context-flow.md: edits made
 * and PROMOTED inside one loop become visible to the NEXT loop, across all
 * three shared layers (notes, knowledge, personal). This is what "working in a
 * loop updates the shared context" means concretely.
 *
 *   init contexts (each a git repo with a local bare origin, seeded)
 *     → loop A writes + promotes to each layer
 *     → loop B opens fresh worktrees from origin/main
 *     → loop B sees A's edits
 *
 * Self-contained + safe: throwaway LOOPAT_HOME under /tmp, removed on exit.
 * Pure git/fs — no podman. Run:  bun run scripts/e2e/context-flow.ts
 */
const HOME = process.env.LOOPAT_HOME ?? `/tmp/loopat-e2e-cf-${process.pid}`
process.env.LOOPAT_HOME = HOME

// Dynamic imports so LOOPAT_HOME is set BEFORE paths.ts captures it.
const { rm, writeFile, readFile } = await import("node:fs/promises")
const { existsSync } = await import("node:fs")
const { execFile } = await import("node:child_process")
const { promisify } = await import("node:util")
const { join } = await import("node:path")
const execFileP = promisify(execFile)

const { ensureWorkspaceDirs, createLoop, provisionUserPersonal } = await import("../../server/src/loops")
const { createUser } = await import("../../server/src/auth")
const { loopContextNotes, loopContextKnowledge, loopContextPersonal,
        workspaceNotesDir, workspaceKnowledgeDir, personalDir } = await import("../../server/src/paths")

const G = (cwd: string, ...args: string[]) => execFileP("git", ["-C", cwd, ...args])
const AUTHOR = ["-c", "user.email=e2e@loopat", "-c", "user.name=e2e"]

async function hasCommit(dir: string): Promise<boolean> {
  return G(dir, "rev-parse", "--verify", "-q", "HEAD").then(() => true).catch(() => false)
}

/** Seed an empty context repo with an initial commit on origin/main, so the
 *  first loop has a consensus to branch from (mimics an already-set-up team
 *  context; solo backend just starts from a fresh local bare origin). */
async function seed(dir: string, name: string) {
  if (await hasCommit(dir)) return
  await writeFile(join(dir, "README.md"), `# ${name}\n`)
  await G(dir, "add", "-A")
  await G(dir, ...AUTHOR, "commit", "-q", "-m", "seed")
  await G(dir, "push", "-q", "origin", "HEAD:main")
}

/** promote (ungated edge, docs/context-flow.md §②): commit local edits and push
 *  HEAD onto origin/main — the same git the /promote skill runs in a loop. */
async function promote(wt: string, msg: string) {
  await G(wt, "add", "-A")
  await G(wt, ...AUTHOR, "commit", "-q", "-m", msg)
  await G(wt, "push", "-q", "origin", "HEAD:main")
}

async function main(): Promise<boolean> {
  await ensureWorkspaceDirs()
  await createUser({ id: "e2e", password: "test1234" })
  await provisionUserPersonal("e2e")

  // "指定 kn / notes / personal" — each is a git repo on a local bare origin;
  // seed an initial consensus commit.
  await seed(workspaceNotesDir(), "notes")
  await seed(workspaceKnowledgeDir(), "knowledge")
  await seed(personalDir("e2e"), "personal")

  const marker = `e2e-cf-${process.pid}`
  const layers = [
    { name: "notes",     wt: loopContextNotes,     file: "e2e-note.md" },
    { name: "knowledge", wt: loopContextKnowledge, file: "e2e-kn.md" },
    { name: "personal",  wt: loopContextPersonal,  file: "e2e-personal.md" },
  ]

  // loop A — write to each layer, then promote.
  const a = await createLoop({ title: "writer", createdBy: "e2e", knowledgeRw: true })
  console.log(`loop A = ${a.id.slice(0, 8)} — write + promote`)
  for (const L of layers) {
    await writeFile(join(L.wt(a.id), L.file), `${L.name} ${marker}\n`)
    await promote(L.wt(a.id), `e2e ${L.name}`)
  }
  // negative control: an edit written AFTER the promotes and never pushed —
  // it must NOT reach loop B (proves visibility comes from promote, not from a
  // shared directory).
  await writeFile(join(loopContextNotes(a.id), "e2e-unpromoted.md"), `should-not-flow ${marker}\n`)

  // loop B — fresh worktrees opened from origin/main (① pull).
  const b = await createLoop({ title: "reader", createdBy: "e2e", knowledgeRw: true })
  console.log(`loop B = ${b.id.slice(0, 8)} — check visibility`)
  let allOk = true
  for (const L of layers) {
    const p = join(L.wt(b.id), L.file)
    const ok = existsSync(p) && (await readFile(p, "utf8")).includes(marker)
    console.log(`  ${ok ? "✓" : "✗"} ${L.name}: ${ok ? "loop A's edit visible in loop B" : "MISSING"}`)
    if (!ok) allOk = false
  }
  const leaked = existsSync(join(loopContextNotes(b.id), "e2e-unpromoted.md"))
  console.log(`  ${!leaked ? "✓" : "✗"} un-promoted edit ${leaked ? "LEAKED into" : "correctly absent from"} loop B`)
  if (leaked) allOk = false
  return allOk
}

let ok = false
try { ok = await main() }
finally { await rm(HOME, { recursive: true, force: true }).catch(() => {}) }
if (ok) { console.log("PASS — promoted context flows from one loop to the next.") }
else { console.log("FAIL"); process.exit(1) }
