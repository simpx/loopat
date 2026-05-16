/**
 * env catalog: each env is a SUBDIRECTORY under `knowledge/.loopat/envs/`
 * containing a `mise.toml` (the runtime declaration mise reads) plus an
 * optional `mise.lock` (version pinning).
 *
 * Why dir-per-env rather than `<name>.toml` files: mise's lockfile generation
 * is tightly coupled to cwd-discovered configs named `mise.toml`. Trying to
 * use `MISE_OVERRIDE_CONFIG_FILENAMES` with `<name>.toml` quietly skips
 * lockfile writes. Giving each env its own dir lets mise work natively and
 * leaves room for future siblings (mcp.json, AGENTS.md).
 *
 * UI / API surface still treats each env as a single name (e.g. "default");
 * the dir + `mise.toml` filename are implementation detail.
 *
 * Personal env catalog (`personal/<user>/.loopat/envs/`) is intentionally
 * deferred — see the plan's "future extension anchors".
 */
import { execFile } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import {
  workspaceKnowledgeDir,
  workspaceLoopatEnvDir,
  workspaceLoopatEnvPath,
  workspaceLoopatEnvLockPath,
  workspaceLoopatEnvMetaPath,
  workspaceLoopatEnvsDir,
} from "./paths"

const execFileP = promisify(execFile)

export type EnvEntry = {
  name: string
}

/**
 * Loopat-side env metadata, lives in `env.json` alongside mise.toml.
 * Kept separate so mise.toml stays purely about runtime/tools.
 *
 * - `shell`: term spawn shell — bare name (PATH lookup against mise installs)
 *   or absolute path. Falls back to /bin/bash when undefined.
 *
 * Future: autostart services, hook scripts, etc.
 */
export type EnvMeta = {
  shell?: string
}

/** Read env.json for the named env. Returns null if missing or malformed. */
export async function readEnvMeta(name: string): Promise<EnvMeta | null> {
  if (!isValidEnvName(name)) return null
  const p = workspaceLoopatEnvMetaPath(name)
  if (!existsSync(p)) return null
  try {
    const raw = await readFile(p, "utf8")
    return JSON.parse(raw) as EnvMeta
  } catch {
    return null
  }
}

/**
 * Read env.json from a per-loop snapshot path (resolved by caller). Tiny
 * helper since term.ts also needs this without going through the catalog.
 */
export async function readEnvMetaFromPath(path: string): Promise<EnvMeta | null> {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(await readFile(path, "utf8")) as EnvMeta
  } catch {
    return null
  }
}

/** Strict env-name format: filename-safe, no path traversal. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
export function isValidEnvName(name: string): boolean {
  return NAME_RE.test(name)
}

/** List all envs (subdirs containing a mise.toml). */
export async function listEnvs(): Promise<EnvEntry[]> {
  const root = workspaceLoopatEnvsDir()
  if (!existsSync(root)) return []
  const entries: EnvEntry[] = []
  for (const name of await readdir(root)) {
    if (!isValidEnvName(name)) continue
    let st
    try {
      st = statSync(`${root}/${name}`)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    if (!existsSync(workspaceLoopatEnvPath(name))) continue
    entries.push({ name })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries
}

/** Resolve env name to its mise.toml path. Returns null if missing. */
export function resolveEnvFile(name: string): string | null {
  const p = workspaceLoopatEnvPath(name)
  return existsSync(p) ? p : null
}

/**
 * Files inside an env dir that the editor UI can read/write. Whitelist so a
 * malicious `?file=../../../etc/passwd` can't escape — only these basenames
 * resolve to a path inside the env dir.
 */
export type EnvFile = "mise.toml" | "env.json"
const ENV_FILES: readonly EnvFile[] = ["mise.toml", "env.json"]
export function isValidEnvFile(file: string): file is EnvFile {
  return (ENV_FILES as readonly string[]).includes(file)
}

function envFilePath(name: string, file: EnvFile): string {
  return `${workspaceLoopatEnvDir(name)}/${file}`
}

/** Read one file from an env. Returns null if missing. */
export async function readEnvFile(name: string, file: EnvFile): Promise<string | null> {
  const p = envFilePath(name, file)
  if (!existsSync(p)) return null
  return await readFile(p, "utf8")
}

/** Write one file into an env, creating the env dir if needed. */
export async function writeEnvFile(name: string, file: EnvFile, content: string): Promise<void> {
  const dir = workspaceLoopatEnvDir(name)
  await mkdir(dir, { recursive: true })
  await writeFile(envFilePath(name, file), content)
}

/**
 * Remove an env from the catalog. Per-loop snapshots already copied are
 * untouched — they continue to work standalone (decoupling is the whole
 * point of the snapshot model). Caller has already validated the name.
 */
export async function deleteEnv(name: string): Promise<void> {
  await rm(workspaceLoopatEnvDir(name), { recursive: true, force: true })
}

/**
 * Short commit id of the most recent commit in the knowledge repo that
 * touched this env's directory. Used as the env's "version" — convenient
 * because it gives a clickable audit trail straight to the git diff.
 *
 * Returns null when: env dir missing, knowledge dir isn't a git repo, or
 * the env was never committed (uncommitted edits via UI). Caller decides
 * how to render those cases.
 *
 * git log on a small repo is sub-100ms — no cache needed.
 */
export async function getEnvVersion(name: string): Promise<string | null> {
  if (!isValidEnvName(name)) return null
  if (!existsSync(workspaceLoopatEnvDir(name))) return null
  const repoRoot = workspaceKnowledgeDir()
  if (!existsSync(`${repoRoot}/.git`)) return null
  try {
    const r = await execFileP(
      "git",
      ["-C", repoRoot, "log", "-1", "--format=%h", "--", `.loopat/envs/${name}`],
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
 * by running `mise install` in the env's dir with lockfile enabled. Writes to
 * `<env-dir>/mise.lock`. Idempotent — fast when nothing to install.
 *
 * mise's lockfile write requires (a) cwd-discovered config named `mise.toml`
 * and (b) the lockfile already existing. We satisfy both: cwd = env dir, and
 * we `touch mise.lock` first. `MISE_TRUSTED_CONFIG_PATHS` skips the
 * interactive trust prompt for our managed dir.
 */
export async function lockEnv(name: string): Promise<{ ok: boolean; error?: string }> {
  const tomlPath = resolveEnvFile(name)
  if (!tomlPath) return { ok: false, error: `env "${name}" not found` }
  const envDir = workspaceLoopatEnvDir(name)
  const lockPath = workspaceLoopatEnvLockPath(name)
  // touch — mise won't write to a lockfile that doesn't exist yet.
  if (!existsSync(lockPath)) {
    await writeFile(lockPath, "")
  }
  const env = {
    ...process.env,
    MISE_TRUSTED_CONFIG_PATHS: envDir,
    MISE_LOCKFILE: "true",
  }
  try {
    await execFileP("mise", ["install"], { env, cwd: envDir })
    return { ok: true }
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      return { ok: false, error: "mise not found on host" }
    }
    const msg = (e?.stderr ?? e?.message ?? String(e)).toString().trim()
    return { ok: false, error: msg.split("\n").slice(-5).join("\n") }
  }
}
