import { existsSync } from "node:fs"
import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, resolve, join } from "node:path"

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

/**
 * The claude binary the SANDBOX runs (the AI executes inside a linux podman
 * container). On a linux host that's just the host claude. On a non-linux host
 * npm only installed the host (e.g. darwin) binary, so postinstall fetched the
 * linux-<arch> one into <loopat>/sandbox-claude — bind THAT into the sandbox,
 * not the host binary (otherwise: "Exec format error").
 */
export function resolveSandboxClaudeBinary(): string {
  if (process.platform === "linux") return resolveClaudeBinary()
  const arch = process.arch
  const installDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
  const candidate = join(installDir, "sandbox-claude", "node_modules", "@anthropic-ai", `claude-agent-sdk-linux-${arch}`, "claude")
  if (existsSync(candidate)) return candidate
  throw new Error(
    `sandbox (linux) claude not found at ${candidate}; postinstall may have failed. Fix: ` +
      `npm install --prefix "${join(installDir, "sandbox-claude")}" --no-save --os=linux --cpu=${arch} @anthropic-ai/claude-agent-sdk-linux-${arch}`,
  )
}
