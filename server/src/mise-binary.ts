import { existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"

function binaryDir(): string {
  if (!process.execPath.endsWith("bun") && !process.execPath.endsWith("bun.exe")) {
    return dirname(process.execPath)
  }
  return dirname(fileURLToPath(import.meta.url))
}

function whichMise(): string | null {
  try {
    return execSync("which mise 2>/dev/null", { encoding: "utf8" }).trim() || null
  } catch {
    return null
  }
}

export function resolveMiseBinary(): string {
  if (process.env.LOOPAT_MISE_BINARY) return process.env.LOOPAT_MISE_BINARY

  const bundled = join(binaryDir(), "mise")
  if (existsSync(bundled)) return bundled

  return whichMise() ?? "mise"
}
