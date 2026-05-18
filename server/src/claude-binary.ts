import { existsSync, statSync } from "node:fs"
import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

/**
 * Get the directory containing the current binary.
 * For `bun build --compile` binaries, process.execPath gives the real path;
 * import.meta.url gives a virtual /$bunfs/root path that doesn't resolve
 * to the real filesystem where bundled tools (claude, loopat-sandbox) live.
 */
function binaryDir(): string {
  if (!process.execPath.endsWith("bun") && !process.execPath.endsWith("bun.exe")) {
    return dirname(process.execPath)
  }
  return dirname(fileURLToPath(import.meta.url))
}

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
  return roots
}

function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

export function resolveClaudeBinary(): string | null {
  if (process.env.LOOPAT_CLAUDE_BINARY) {
    const p = process.env.LOOPAT_CLAUDE_BINARY
    if (isRegularFile(p)) return p
    if (existsSync(p)) {
      console.warn(`[loopat] LOOPAT_CLAUDE_BINARY=${p} is not a regular file (directory?), falling back`)
    } else {
      console.warn(`[loopat] LOOPAT_CLAUDE_BINARY=${p} not found, falling back`)
    }
    return null
  }

  const platform = process.platform
  const ext = platform === "win32" ? ".exe" : ""
  const bundleDir = binaryDir()

  // Bundled alongside the compiled binary (dist/claude or claude.exe)
  const bundled = join(bundleDir, `claude${ext}`)
  if (isRegularFile(bundled)) return bundled

  const arch = process.arch
  const pkgs: string[] = platform === "linux"
    ? (detectIsMusl()
      ? [`claude-agent-sdk-linux-${arch}-musl`, `claude-agent-sdk-linux-${arch}`]
      : [`claude-agent-sdk-linux-${arch}`, `claude-agent-sdk-linux-${arch}-musl`])
    : [`claude-agent-sdk-${platform}-${arch}`]

  // Use binaryDir() instead of import.meta.url — import.meta.url is
  // /$bunfs/root/ in compiled mode, which doesn't exist on the real FS.
  const roots = findWorkspaceRoot(bundleDir)
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
    if (isRegularFile(c)) return c
  }
  return null
}
