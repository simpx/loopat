import { existsSync, mkdirSync } from "node:fs"
import { execSync, execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { dirname, resolve, join } from "node:path"
import { createRequire } from "node:module"

const execFileP = promisify(execFile)

function detectIsMusl(): boolean {
  if (process.platform !== "linux") return false
  try {
    const lddOut = execSync("ldd --version 2>&1", { encoding: "utf8" }) as string
    return /musl/i.test(lddOut)
  } catch {}
  return false
}

function findWorkspaceRoot(start: string): string[] {
  const roots: string[] = []
  let cur = start
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(cur, "node_modules"))) roots.push(cur)
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  if (roots.length === 0) throw new Error("could not locate node_modules from " + start)
  return roots
}

export function resolveClaudeBinary(): string {
  const platform = process.platform
  const arch = process.arch
  const ext = platform === "win32" ? ".exe" : ""

  const pkgs: string[] = []
  if (platform === "linux") {
    if (detectIsMusl()) {
      pkgs.push(`claude-agent-sdk-linux-${arch}-musl`, `claude-agent-sdk-linux-${arch}`)
    } else {
      pkgs.push(`claude-agent-sdk-linux-${arch}`, `claude-agent-sdk-linux-${arch}-musl`)
    }
  } else {
    pkgs.push(`claude-agent-sdk-${platform}-${arch}`)
  }

  const here = fileURLToPath(import.meta.url)
  const roots = findWorkspaceRoot(dirname(here))
  const candidates: string[] = []
  for (const root of roots) {
    for (const pkg of pkgs) {
      candidates.push(join(root, "node_modules", "@anthropic-ai", pkg, `claude${ext}`))
      const bunDir = join(root, "node_modules", ".bun")
      if (existsSync(bunDir)) {
        try {
          const entries = execSync(`ls "${bunDir}"`, { encoding: "utf8" }).split("\n").filter(Boolean)
          for (const entry of entries) {
            if (entry.startsWith(`@anthropic-ai+${pkg}@`)) {
              candidates.push(join(bunDir, entry, "node_modules", "@anthropic-ai", pkg, `claude${ext}`))
            }
          }
        } catch {}
      }
    }
  }

  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error(`claude binary not found; tried:\n${candidates.join("\n")}`)
}

/** Where the fetched linux claude lives on a non-linux host. */
function sandboxClaudeDir(): string {
  const installDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
  return join(installDir, "sandbox-claude")
}
function sandboxClaudeBinaryPath(): string {
  return join(sandboxClaudeDir(), "node_modules", "@anthropic-ai", `claude-agent-sdk-linux-${process.arch}`, "claude")
}

/**
 * The claude binary the SANDBOX runs (the AI executes inside a linux podman
 * container). On a linux host that's just the host claude. On a non-linux host
 * npm only installed the host (e.g. darwin) binary, so we fetch the linux-<arch>
 * one into <loopat>/sandbox-claude — bind THAT into the sandbox, not the host
 * binary (otherwise: "Exec format error").
 */
export function resolveSandboxClaudeBinary(): string {
  if (process.platform === "linux") return resolveClaudeBinary()
  const candidate = sandboxClaudeBinaryPath()
  if (existsSync(candidate)) return candidate
  throw new Error(`sandbox (linux) claude not found at ${candidate}; run ensureSandboxClaudeBinary() (loopat fetches it on first boot)`)
}

/**
 * Make sure the sandbox's linux claude exists, fetching it if not. No-op on a
 * linux host (host claude IS the sandbox claude). On a non-linux host this runs
 * `npm install --force` (the platform binary has os=linux, so --os/--cpu hit
 * EBADPLATFORM; --force is what gets it). Pinned to the SDK version. Best-effort
 * and idempotent: once fetched, returns immediately. npx does NOT run package
 * postinstall scripts, so this boot-time fetch is what actually covers
 * `npx loopat`.
 */
export async function ensureSandboxClaudeBinary(onLog?: (m: string) => void): Promise<void> {
  if (process.platform === "linux") return
  if (existsSync(sandboxClaudeBinaryPath())) return
  const arch = process.arch
  let version = ""
  try { version = createRequire(import.meta.url)("@anthropic-ai/claude-agent-sdk/package.json").version } catch {}
  const spec = `@anthropic-ai/claude-agent-sdk-linux-${arch}${version ? `@${version}` : ""}`
  const dest = sandboxClaudeDir()
  mkdirSync(dest, { recursive: true })
  onLog?.(`host is ${process.platform}/${arch}; fetching linux claude for the sandbox (${spec})…`)
  await execFileP("npm", ["install", "--prefix", dest, "--no-save", "--force", spec], { timeout: 180_000 })
  if (!existsSync(sandboxClaudeBinaryPath())) throw new Error(`fetch finished but ${sandboxClaudeBinaryPath()} missing`)
  onLog?.(`sandbox claude ready`)
}
