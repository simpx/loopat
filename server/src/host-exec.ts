/**
 * host-cli proxy (POC). Some CLIs can only run on the host — macOS-only tools,
 * or company tools bound to a specific machine. The sandbox can't run them, so
 * we run them on the host *on behalf of* a loop:
 *
 *   sandbox:  `aone foo`  →  shim  →  loopat-host (forwarder)  →
 *   server :  POST /api/host-exec  →  execFile("aone", ["foo"]) on the host
 *
 * Trust model (deliberately simple): mounting the socket into a sandbox IS the
 * trust decision — a host that turns on host-cli for a loop already trusts that
 * loop, so there is NO whitelist. The loop may run any host cli (it can call the
 * forwarder directly with a hand-built command).
 *
 * The mise-generated shims aren't a whitelist either — they're the declarative
 * ENTRY POINT. "Which clis did the loop declare in `[host].clis`" shows up as
 * "which shim binaries exist on PATH"; that's a UX convention (what the AI can
 * conveniently reach), not a security boundary. The only boundary is whether
 * the socket is mounted at all.
 *
 *   - runs with HOST user permissions
 *   - cwd is a per-loop host workdir (mirrors the loop's workdir); the cli
 *     cannot see inside the sandbox
 *   - execFile, never a shell — argv is an array
 */
import { execFile } from "node:child_process"
import { mkdir, writeFile, chmod } from "node:fs/promises"
import { existsSync, rmSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { loopDir, LOOPAT_HOME } from "./paths"

/** A per-loop host workdir — the host-side mirror of the loop's own workdir. */
export function hostWorkdir(loopId: string): string {
  return join(loopDir(loopId), "host-workdir")
}

/** The dir that holds the host-exec unix socket. We mount the DIR (not the
 *  socket file) into sandboxes so a server restart — which recreates the
 *  socket inode — stays visible to already-running containers. */
export function hostExecDir(): string {
  return join(LOOPAT_HOME, "host-exec")
}
export function hostExecSocketPath(): string {
  return join(hostExecDir(), "host-exec.sock")
}

export type HostExecResult =
  | { ok: true; exitCode: number; stdout: string; stderr: string }
  | { ok: false; error: string }

/** Run a host-cli in the loop's host workdir, with host permissions. No
 *  whitelist — mounting the socket into the sandbox is the trust decision. */
export async function runHostCli(opts: {
  cli: string
  args: string[]
  cwd: string
  stdin?: string
  timeoutMs?: number
}): Promise<HostExecResult> {
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
  // The `loopat-host` forwarder is baked into the sandbox image; here we only
  // emit the per-cli shims — each just hands off to it.
  for (const cli of clis) {
    const p = join(binDir, cli)
    await writeFile(p, `#!/bin/sh\n# loopat host-cli shim — forwards "${cli}" to the host\nexec loopat-host "${cli}" "$@"\n`)
    await chmod(p, 0o755)
  }
}

/**
 * Unix-socket server that runs host-clis for loops. The sandbox's
 * forwarder connects over the *mounted* socket — no TCP, no exposed port, and
 * only a container that has the socket mounted can reach it (the mount itself
 * is a layer of isolation). Reuses runHostCli. stdout/stderr come back base64
 * so the sh forwarder can pull them out of the JSON without escaping pain.
 */
export function serveHostExec(socketPath: string, deps: { loopExists: (id: string) => Promise<boolean> }) {
  try { mkdirSync(hostExecDir(), { recursive: true }) } catch {}
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
      const r = await runHostCli({
        cli, args, cwd: hostWorkdir(loopId),
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
