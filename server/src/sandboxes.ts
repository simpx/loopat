/**
 * Sandbox catalog: each sandbox is a SUBDIRECTORY under
 * `knowledge/.loopat/sandboxes/` containing a `mise.toml` (the runtime
 * declaration mise reads) plus an optional `mise.lock` (version pinning).
 *
 * Why dir-per-sandbox rather than `<name>.toml` files: mise's lockfile
 * generation is tightly coupled to cwd-discovered configs named `mise.toml`.
 * Trying to use `MISE_OVERRIDE_CONFIG_FILENAMES` with `<name>.toml` quietly
 * skips lockfile writes. Giving each sandbox its own dir lets mise work
 * natively and leaves room for future siblings (mcp.json, AGENTS.md).
 *
 * UI / API surface still treats each sandbox as a single name (e.g.
 * "default"); the dir + `mise.toml` filename are implementation detail.
 *
 * Naming note: "sandbox" is the user-facing primitive (the runtime
 * environment a loop activates). Implementation-side "snapshot" refers to
 * the per-loop frozen copy, and "bwrap process" refers to the actual running
 * sandboxing container. See docs/sandbox.md.
 *
 * Personal sandbox catalog (`personal/<user>/.loopat/sandboxes/`) is
 * intentionally deferred — see the plan's "future extension anchors".
 */
import { execFile } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import {
  workspaceKnowledgeDir,
  workspaceLoopatSandboxDir,
  workspaceLoopatSandboxPath,
  workspaceLoopatSandboxLockPath,
  workspaceLoopatSandboxMetaPath,
  workspaceLoopatSandboxesDir,
} from "./paths"

const execFileP = promisify(execFile)

export type SandboxEntry = {
  name: string
}

/**
 * Loopat-side sandbox metadata, lives in `sandbox.json` alongside mise.toml.
 * Kept separate so mise.toml stays purely about runtime/tools.
 *
 * - `shell`: term spawn shell — bare name (PATH lookup against mise installs)
 *   or absolute path. Falls back to /bin/bash when undefined.
 *
 * Future: autostart services, hook scripts, etc.
 */
export type SandboxMeta = {
  shell?: string
}

/** Read sandbox.json for the named sandbox. Returns null if missing or malformed. */
export async function readSandboxMeta(name: string): Promise<SandboxMeta | null> {
  if (!isValidSandboxName(name)) return null
  const p = workspaceLoopatSandboxMetaPath(name)
  if (!existsSync(p)) return null
  try {
    const raw = await readFile(p, "utf8")
    return JSON.parse(raw) as SandboxMeta
  } catch {
    return null
  }
}

/**
 * Read sandbox.json from a per-loop snapshot path (resolved by caller). Tiny
 * helper since term.ts also needs this without going through the catalog.
 */
export async function readSandboxMetaFromPath(path: string): Promise<SandboxMeta | null> {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(await readFile(path, "utf8")) as SandboxMeta
  } catch {
    return null
  }
}

/** Strict sandbox-name format: filename-safe, no path traversal. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
export function isValidSandboxName(name: string): boolean {
  return NAME_RE.test(name)
}

/** List all sandboxes (subdirs containing a mise.toml). */
export async function listSandboxes(): Promise<SandboxEntry[]> {
  const root = workspaceLoopatSandboxesDir()
  if (!existsSync(root)) return []
  const entries: SandboxEntry[] = []
  for (const name of await readdir(root)) {
    if (!isValidSandboxName(name)) continue
    let st
    try {
      st = statSync(`${root}/${name}`)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    if (!existsSync(workspaceLoopatSandboxPath(name))) continue
    entries.push({ name })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries
}

/** Resolve sandbox name to its mise.toml path. Returns null if missing. */
export function resolveSandboxFile(name: string): string | null {
  const p = workspaceLoopatSandboxPath(name)
  return existsSync(p) ? p : null
}

/**
 * Files inside a sandbox dir that the editor UI can read/write. Whitelist
 * so a malicious `?file=../../../etc/passwd` can't escape — only these
 * basenames resolve to a path inside the sandbox dir.
 */
export type SandboxFile = "mise.toml" | "sandbox.json"
const SANDBOX_FILES: readonly SandboxFile[] = ["mise.toml", "sandbox.json"]
export function isValidSandboxFile(file: string): file is SandboxFile {
  return (SANDBOX_FILES as readonly string[]).includes(file)
}

function sandboxFilePath(name: string, file: SandboxFile): string {
  return `${workspaceLoopatSandboxDir(name)}/${file}`
}

/** Read one file from a sandbox. Returns null if missing. */
export async function readSandboxFile(name: string, file: SandboxFile): Promise<string | null> {
  const p = sandboxFilePath(name, file)
  if (!existsSync(p)) return null
  return await readFile(p, "utf8")
}

/** Write one file into a sandbox, creating the sandbox dir if needed. */
export async function writeSandboxFile(name: string, file: SandboxFile, content: string): Promise<void> {
  const dir = workspaceLoopatSandboxDir(name)
  await mkdir(dir, { recursive: true })
  await writeFile(sandboxFilePath(name, file), content)
}

/**
 * Remove a sandbox from the catalog. Per-loop snapshots already copied are
 * untouched — they continue to work standalone (decoupling is the whole
 * point of the snapshot model). Caller has already validated the name.
 */
export async function deleteSandbox(name: string): Promise<void> {
  await rm(workspaceLoopatSandboxDir(name), { recursive: true, force: true })
}

/**
 * Synthetic git identity for auto-commits the loopat system makes on the
 * user's behalf. The actor is "loopat" (the platform), not the logged-in
 * user — UI edits are policy decisions about the workspace's shared sandbox
 * catalog, not personal commits. Push (when wired) uses the per-user deploy
 * key separately; this just controls author/committer fields.
 */
const COMMIT_AUTHOR_NAME = "loopat"
const COMMIT_AUTHOR_EMAIL = "loopat@localhost"

/**
 * Auto-commit sandbox changes in the knowledge repo. Stages only the
 * sandbox's dir, commits as the loopat identity. Returns the new short sha
 * or null when skipped (no git, nothing to commit, or commit failed).
 *
 * Called after every write / delete from the UI so getSandboxVersion()
 * always has a fresh sha to compare against — that's what powers the
 * "→ <sha>" refresh link on the loop page.
 */
export async function commitSandboxChange(
  name: string,
  action: { kind: "update"; file: SandboxFile } | { kind: "delete" } | { kind: "create" },
): Promise<{ ok: boolean; sha?: string; error?: string }> {
  const repoRoot = workspaceKnowledgeDir()
  if (!existsSync(`${repoRoot}/.git`)) return { ok: false, error: "knowledge dir is not a git repo" }
  const sandboxPath = `.loopat/sandboxes/${name}`
  try {
    // -A picks up both modifications and deletions inside the sandbox dir.
    // Scoping to the sandbox path keeps unrelated dirty files in knowledge
    // out of this commit.
    await execFileP("git", ["-C", repoRoot, "add", "-A", "--", sandboxPath], { timeout: 5000 })
    // git diff --cached exit 0 = no staged changes → nothing to commit.
    const diffRes = await execFileP(
      "git",
      ["-C", repoRoot, "diff", "--cached", "--quiet", "--", sandboxPath],
      { timeout: 5000 },
    ).then(() => ({ code: 0 })).catch((e: any) => ({ code: e?.code ?? 1 }))
    if (diffRes.code === 0) return { ok: true } // no-op write (content unchanged)
    const msg =
      action.kind === "update" ? `sandboxes/${name}: update ${action.file}`
      : action.kind === "create" ? `sandboxes/${name}: create`
      : `sandboxes/${name}: delete`
    await execFileP(
      "git",
      [
        "-C", repoRoot,
        "-c", `user.name=${COMMIT_AUTHOR_NAME}`,
        "-c", `user.email=${COMMIT_AUTHOR_EMAIL}`,
        "commit", "-m", msg, "--", sandboxPath,
      ],
      { timeout: 10000 },
    )
    const r = await execFileP("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"], { timeout: 5000 })
    return { ok: true, sha: r.stdout.trim() }
  } catch (e: any) {
    const stderr = (e?.stderr ?? "").toString().trim()
    return { ok: false, error: stderr || e?.message || "git commit failed" }
  }
}

/**
 * Short commit id of the most recent commit in the knowledge repo that
 * touched this sandbox's directory. Used as the sandbox's "version" —
 * convenient because it gives a clickable audit trail straight to the git
 * diff.
 *
 * Returns null when: sandbox dir missing, knowledge dir isn't a git repo,
 * or the sandbox was never committed (uncommitted edits via UI).
 */
export async function getSandboxVersion(name: string): Promise<string | null> {
  if (!isValidSandboxName(name)) return null
  if (!existsSync(workspaceLoopatSandboxDir(name))) return null
  const repoRoot = workspaceKnowledgeDir()
  if (!existsSync(`${repoRoot}/.git`)) return null
  try {
    const r = await execFileP(
      "git",
      ["-C", repoRoot, "log", "-1", "--format=%h", "--", `.loopat/sandboxes/${name}`],
      { timeout: 5000 },
    )
    const sha = r.stdout.trim()
    return sha || null
  } catch {
    return null
  }
}

/**
 * Resolve loose version specs ("latest", "22", etc.) to exact pinned versions
 * by running `mise install` in the sandbox's dir with lockfile enabled.
 * Writes to `<sandbox-dir>/mise.lock`. Idempotent — fast when nothing to
 * install.
 *
 * mise's lockfile write requires (a) cwd-discovered config named `mise.toml`
 * and (b) the lockfile already existing. We satisfy both: cwd = sandbox dir,
 * and we `touch mise.lock` first. `MISE_TRUSTED_CONFIG_PATHS` skips the
 * interactive trust prompt for our managed dir.
 */
export async function lockSandbox(name: string): Promise<{ ok: boolean; error?: string }> {
  const tomlPath = resolveSandboxFile(name)
  if (!tomlPath) return { ok: false, error: `sandbox "${name}" not found` }
  const sandboxDir = workspaceLoopatSandboxDir(name)
  const lockPath = workspaceLoopatSandboxLockPath(name)
  // touch — mise won't write to a lockfile that doesn't exist yet.
  if (!existsSync(lockPath)) {
    await writeFile(lockPath, "")
  }
  const env = {
    ...process.env,
    MISE_TRUSTED_CONFIG_PATHS: sandboxDir,
    MISE_LOCKFILE: "true",
  }
  try {
    await execFileP("mise", ["install"], { env, cwd: sandboxDir })
    return { ok: true }
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      return { ok: false, error: "mise not found on host" }
    }
    const msg = (e?.stderr ?? e?.message ?? String(e)).toString().trim()
    return { ok: false, error: msg.split("\n").slice(-5).join("\n") }
  }
}
