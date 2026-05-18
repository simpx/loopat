import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

function binaryDir(): string {
  if (!process.execPath.endsWith("bun") && !process.execPath.endsWith("bun.exe")) {
    return dirname(process.execPath)
  }
  return dirname(fileURLToPath(import.meta.url))
}

/**
 * Resolve the sandbox binary path.
 *
 * Priority:
 *   1. LOOPAT_SANDBOX env var (explicit override)
 *   2. loopat-sandbox bundled next to the server binary (dist/)
 *   3. Dev mode: loopat-sandbox/target/release/ or target/debug/
 *   4. bwrap from system PATH (fallback)
 */
export function resolveSandboxBinary(): string {
  if (process.env.LOOPAT_SANDBOX) return process.env.LOOPAT_SANDBOX

  // Bundled next to compiled server binary (dist/loopat-sandbox or .exe)
  const ext = process.platform === "win32" ? ".exe" : ""
  const bundled = join(binaryDir(), `loopat-sandbox${ext}`)
  if (existsSync(bundled)) return bundled

  // Dev mode: check cargo build output
  const bundleDir = dirname(fileURLToPath(import.meta.url))
  const devProject = join(bundleDir, "..", "..", "loopat-sandbox", "target", "release", `loopat-sandbox${ext}`)
  if (existsSync(devProject)) return devProject
  const devDebug = join(bundleDir, "..", "..", "loopat-sandbox", "target", "debug", `loopat-sandbox${ext}`)
  if (existsSync(devDebug)) return devDebug

  // Fallback: system bwrap
  return "bwrap"
}

export function checkSandboxBinary(): { ok: boolean; label: string; hint?: string } {
  const name = resolveSandboxBinary()
  const isBwrap = name === "bwrap" || name.endsWith("/bwrap")

  // bwrap has --version, loopat-sandbox also has --version
  try {
    execFileSync(name, ["--version"], { stdio: "pipe" })
    if (isBwrap) {
      // bwrap is deprecated — we want users on loopat-sandbox
      return {
        ok: true,
        label: "sandbox: bwrap (system — deprecated)",
        hint: "switch to loopat-sandbox: cd loopat-sandbox && cargo build --release",
      }
    }
    return { ok: true, label: `sandbox: loopat-sandbox` }
  } catch {
    // loopat-sandbox not found / broken — check if bwrap exists as fallback
    try {
      execFileSync("bwrap", ["--version"], { stdio: "pipe" })
      return { ok: true, label: "sandbox: bwrap (system fallback)" }
    } catch {
      return {
        ok: false,
        label: "sandbox",
        hint: isBwrap
          ? "install bwrap: sudo apt install bubblewrap"
          : "build loopat-sandbox: cd loopat-sandbox && cargo build --release",
      }
    }
  }
}

export { resolveSandboxBinary as default }
