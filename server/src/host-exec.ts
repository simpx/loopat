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
import { join } from "node:path"
import { loopDir } from "./paths"

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
  for (const cli of clis) {
    const p = join(binDir, cli)
    await writeFile(p, `#!/bin/sh\n# loopat host-cli shim — forwards "${cli}" to the host\nexec loopat-host "${cli}" "$@"\n`)
    await chmod(p, 0o755)
  }
}

/**
 * The forwarder (`loopat-host`) that lives in the sandbox. POC version in POSIX
 * sh + curl: reads stdin, POSTs {loopId, cli, args} to the server, prints back
 * stdout, and exits with the cli's exit code. (A hardened version would stream
 * and separate stdout/stderr; this is enough to prove the path.)
 */
export const LOOPAT_HOST_FORWARDER = `#!/bin/sh
# loopat-host <cli> [args...] — run <cli> on the host via the loopat server.
# Env (injected into the sandbox): LOOPAT_SERVER, LOOPAT_LOOP_ID, LOOPAT_TOKEN
cli="$1"; shift
args_json=$(for a in "$@"; do printf '%s' "$a" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g; s/^/"/; s/$/",/'; done)
args_json="[$(printf '%s' "$args_json" | sed 's/,$//')]"
body=$(printf '{"loopId":"%s","cli":"%s","args":%s}' "$LOOPAT_LOOP_ID" "$cli" "$args_json")
resp=$(curl -fsS -X POST "$LOOPAT_SERVER/api/host-exec" \\
  -H "content-type: application/json" \\
  -H "authorization: Bearer $LOOPAT_TOKEN" \\
  -d "$body") || { echo "loopat-host: server error" >&2; exit 127; }
# resp is {ok, exitCode, stdout, stderr}; print and propagate exit code.
printf '%s' "$resp" | grep -o '"stdout":"[^"]*"' | sed 's/^"stdout":"//; s/"$//'
exit $(printf '%s' "$resp" | grep -o '"exitCode":[0-9]*' | grep -o '[0-9]*')
`
