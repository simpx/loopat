/**
 * host-cli proxy (POC). Some CLIs can only run on the host — macOS-only tools,
 * or company tools bound to a specific machine. The sandbox can't run them, so
 * we run them on the host *on behalf of* a loop:
 *
 *   sandbox:  `aone foo`  →  shim  →  loopat-host (forwarder)  →
 *   server :  POST /api/host-exec  →  execFile("aone", ["foo"]) on the host
 *
 * Boundaries (matches the "pure remote-talking CLI" assumption):
 *   - runs with HOST user permissions (intentionally relaxed)
 *   - cwd is a per-loop host workdir (mirrors the loop's own workdir); the cli
 *     cannot see anything inside the sandbox
 *   - whitelist: ONLY clis the loop declared (host-clis.json, later from mise)
 *   - execFile, never a shell — argv is an array, no injection
 */
import { execFile } from "node:child_process"
import { mkdir, writeFile, chmod, readFile } from "node:fs/promises"
import { existsSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { loopDir } from "./paths"

/** The forwarder script shipped in the package (sandbox-side `loopat-host`). */
const FORWARDER_TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "sandbox", "loopat-host")

/** A per-loop host workdir — the host-side mirror of the loop's own workdir. */
export function hostWorkdir(loopId: string): string {
  return join(loopDir(loopId), "host-workdir")
}

/** The loop's declared host-clis (the whitelist). POC reads a json file next to
 *  the loop; later this is generated from the loop's mise `host:` backend. */
export async function readDeclaredHostClis(loopId: string): Promise<string[]> {
  try {
    const raw = await readFile(join(loopDir(loopId), "host-clis.json"), "utf8")
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []
  } catch {
    return []
  }
}

export type HostExecResult =
  | { ok: true; exitCode: number; stdout: string; stderr: string }
  | { ok: false; error: string }

/**
 * Run a whitelisted host-cli in the loop's host workdir, with host permissions.
 * Pure function — the caller supplies the whitelist + cwd so it's easy to test.
 */
export async function runHostCli(opts: {
  cli: string
  args: string[]
  cwd: string
  allowed: string[]
  stdin?: string
  timeoutMs?: number
}): Promise<HostExecResult> {
  if (!opts.allowed.includes(opts.cli)) {
    return { ok: false, error: `host-cli not allowed: '${opts.cli}' — declare it in host-clis.json` }
  }
  await mkdir(opts.cwd, { recursive: true })
  return new Promise((resolve) => {
    const child = execFile(
      opts.cli,
      opts.args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024 },
      (err: any, stdout, stderr) => {
        if (err && err.code === "ENOENT") {
          resolve({ ok: false, error: `host has no '${opts.cli}'` })
          return
        }
        const exitCode = typeof err?.code === "number" ? err.code : err ? 1 : 0
        resolve({ ok: true, exitCode, stdout: String(stdout), stderr: String(stderr) })
      },
    )
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.write(opts.stdin)
      child.stdin.end()
    }
  })
}

/**
 * Write a shim per declared host-cli into `binDir` (which the sandbox puts on
 * PATH ahead of everything). Each shim just hands off to the forwarder.
 */
export async function writeHostShims(binDir: string, clis: string[]): Promise<void> {
  await mkdir(binDir, { recursive: true })
  // the forwarder the shims hand off to
  const forwarder = join(binDir, "loopat-host")
  await writeFile(forwarder, await readFile(FORWARDER_TEMPLATE, "utf8"))
  await chmod(forwarder, 0o755)
  for (const cli of clis) {
    const p = join(binDir, cli)
    await writeFile(p, `#!/bin/sh\n# loopat host-cli shim — forwards "${cli}" to the host\nexec loopat-host "${cli}" "$@"\n`)
    await chmod(p, 0o755)
  }
}

/**
 * Unix-socket server that runs whitelisted host-clis for loops. The sandbox's
 * forwarder connects over the *mounted* socket — no TCP, no exposed port, and
 * only a container that has the socket mounted can reach it (the mount itself
 * is a layer of isolation). Reuses runHostCli. stdout/stderr come back base64
 * so the sh forwarder can pull them out of the JSON without escaping pain.
 */
export function serveHostExec(socketPath: string, deps: { loopExists: (id: string) => Promise<boolean> }) {
  try { if (existsSync(socketPath)) rmSync(socketPath) } catch {}
  return Bun.serve({
    unix: socketPath,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== "/host-exec" || req.method !== "POST") return new Response("not found", { status: 404 })
      const b: any = await req.json().catch(() => ({}))
      const loopId = typeof b.loopId === "string" ? b.loopId : ""
      const cli = typeof b.cli === "string" ? b.cli : ""
      const args = Array.isArray(b.args) ? b.args.map(String) : []
      if (!loopId || !cli) return Response.json({ error: "loopId + cli required" })
      if (!(await deps.loopExists(loopId))) return Response.json({ error: "unknown loop" })
      const allowed = await readDeclaredHostClis(loopId)
      const r = await runHostCli({
        cli, args, cwd: hostWorkdir(loopId), allowed,
        stdin: typeof b.stdin === "string" ? b.stdin : undefined,
      })
      if (!r.ok) return Response.json({ error: r.error })
      return Response.json({
        exitCode: r.exitCode,
        stdout_b64: Buffer.from(r.stdout).toString("base64"),
        stderr_b64: Buffer.from(r.stderr).toString("base64"),
      })
    },
  })
}
