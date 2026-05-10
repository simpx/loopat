/**
 * Boot-time pre-flight: verify the host has what loopat needs (bwrap, claude
 * binary, apiKey) and print a checklist. Doesn't exit on failure — UI still
 * works, just chat won't function until the user fills in what's missing.
 */
import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { resolveClaudeBinary } from "./claude-binary"
import { configPath, type WorkspaceConfig } from "./config"
import {
  LOOPAT_HOME,
  WORKSPACE,
  ME,
  workspaceDir,
  workspaceDoctrinePath,
} from "./paths"

type Check = { ok: boolean; label: string; hint?: string }

function checkBwrap(): Check {
  try {
    execFileSync("bwrap", ["--version"], { stdio: "pipe" })
    return { ok: true, label: "bwrap (sandbox)" }
  } catch {
    return {
      ok: false,
      label: "bwrap (sandbox)",
      hint: "install with: sudo apt install bubblewrap   (Linux only)",
    }
  }
}

function checkClaudeBinary(): Check {
  try {
    const p = resolveClaudeBinary()
    return { ok: true, label: `claude binary (${p.split("/").slice(-3).join("/")})` }
  } catch (e: any) {
    return {
      ok: false,
      label: "claude binary",
      hint: "run `bun install` in the loopat repo root — SDK ships the binary as a platform-specific package",
    }
  }
}

function checkApiKey(cfg: WorkspaceConfig): Check {
  const active = cfg.providers[cfg.default]
  if (active?.apiKey) {
    return { ok: true, label: `apiKey (${cfg.default})` }
  }
  return {
    ok: false,
    label: `apiKey (${cfg.default})`,
    hint: `edit ${configPath()}  →  set providers.${cfg.default}.apiKey`,
  }
}

export function printBootstrapBanner(cfg: WorkspaceConfig) {
  const checks: Check[] = [
    { ok: true, label: `workspace dir: ${workspaceDir()}` },
    { ok: existsSync(workspaceDoctrinePath()), label: `doctrine: ${workspaceDoctrinePath()}` },
    { ok: existsSync(configPath()), label: `config: ${configPath()}` },
    checkBwrap(),
    checkClaudeBinary(),
    checkApiKey(cfg),
  ]

  const bar = "─".repeat(60)
  console.log(`\n${bar}`)
  console.log(`  loopat bootstrap`)
  console.log(`  workspace=${WORKSPACE}  user=${ME}  home=${LOOPAT_HOME}`)
  console.log(bar)
  for (const c of checks) {
    const mark = c.ok ? "✓" : "✗"
    console.log(`  ${mark}  ${c.label}`)
    if (!c.ok && c.hint) console.log(`     → ${c.hint}`)
  }
  console.log(bar)
  const blockers = checks.filter((c) => !c.ok)
  if (blockers.length === 0) {
    console.log(`  ready. open http://localhost:${process.env.PORT ?? 7787}\n`)
  } else {
    console.log(`  ${blockers.length} thing(s) to fix before chat will work — see hints above.\n`)
  }
}
