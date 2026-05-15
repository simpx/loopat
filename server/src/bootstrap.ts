/**
 * Boot-time pre-flight: verify the host has what loopat needs (bwrap, claude
 * binary, apiKey) and print a checklist. Doesn't exit on failure — UI still
 * works, just chat won't function until the user fills in what's missing.
 */
import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { resolveClaudeBinary } from "./claude-binary"
import { configPath, type WorkspaceConfig } from "./config"
import {
  WORKSPACE,
  usersPath,
  workspaceDir,
  workspaceKnowledgeDir,
  workspaceNotesDir,
  workspaceRepoDir,
  workspaceClaudePath,
} from "./paths"
import { listUsers } from "./auth"

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


function describeRemote(dir: string, url: string | undefined): string {
  if (!existsSync(dir)) return "missing"
  const isRepo = existsSync(join(dir, ".git"))
  if (url && isRepo) return url
  if (url && !isRepo) return `${url}  (clone failed → local-only)`
  return "local-only (no remote)"
}

function describeRepos(cfg: WorkspaceConfig): Check {
  const specs = cfg.repos ?? []
  if (specs.length === 0) return { ok: true, label: `repos:     (none configured)` }
  const parts = specs.map((r) => {
    const present = existsSync(workspaceRepoDir(r.name))
    return `${present ? "" : "✗"}${r.name}`
  })
  const allOk = specs.every((r) => existsSync(workspaceRepoDir(r.name)))
  return { ok: allOk, label: `repos:     ${parts.join(", ")}` }
}

async function checkUsers(): Promise<Check> {
  const path = usersPath()
  if (!existsSync(path)) {
    return { ok: true, label: `users:     (none yet — register on first visit)` }
  }
  try {
    const users = await listUsers()
    const ids = users.map((u) => u.id).join(", ") || "(empty)"
    return { ok: true, label: `users:     ${users.length} (${ids})` }
  } catch (e: any) {
    return { ok: false, label: `users:     <unreadable>`, hint: `${path}: ${e?.message ?? e}` }
  }
}

export async function printBootstrapBanner(cfg: WorkspaceConfig) {
  const checks: Check[] = [
    { ok: true, label: `workspace: ${workspaceDir()}` },
    { ok: true, label: `workspace supplement: knowledge/.loopat/claude/CLAUDE.md (${existsSync(workspaceClaudePath()) ? "present" : "absent"})` },
    { ok: existsSync(workspaceKnowledgeDir()), label: `knowledge: ${describeRemote(workspaceKnowledgeDir(), cfg.knowledge?.git || undefined)}` },
    { ok: existsSync(workspaceNotesDir()), label: `notes:     ${describeRemote(workspaceNotesDir(), cfg.notes?.git || undefined)}` },
    describeRepos(cfg),
    await checkUsers(),
    { ok: existsSync(configPath()), label: `config: ${configPath()}` },
    checkBwrap(),
    checkClaudeBinary(),
  ]

  const bar = "─".repeat(60)
  console.log(`\n${bar}`)
  console.log(`  loopat bootstrap — ${WORKSPACE}`)
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
