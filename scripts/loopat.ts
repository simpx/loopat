#!/usr/bin/env bun
/**
 * loopat CLI — end-to-end profile-driven loop runner (CC-native model).
 *
 * Uses server-track modules:
 *   - server/src/profiles.ts        — resolve plan
 *   - server/src/compose.ts         — materialize loop's .claude/
 *   - server/src/plugin-installer.ts — orchestrate plugin install
 *
 * Usage:
 *   LOOPAT_HOME=/tmp/loopat-experience bun scripts/loopat.ts run +mode-oncall --bwrap
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { listProfiles, resolveLoopPlan, type LoopPlan } from "../server/src/profiles"
import { composeFromPlan, type ComposeResult } from "../server/src/compose"
import { ensureLoopPluginsInstalled } from "../server/src/plugin-installer"
import {
  LOOPAT_HOME,
  loopDir,
  loopClaudeDir,
  personalVaultDir,
  workspaceKnowledgeDir,
} from "../server/src/paths"

type Args = {
  cmd: "run" | "list" | "help"
  user: string
  vault?: string
  cliAdded: string[]
  cliRemoved: string[]
  overrideProfiles?: string[]
  dryRun: boolean
  doSpawn: boolean
  useBwrap: boolean
  showEnv: boolean
  verbose: boolean
  claudeArgs: string[]
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    cmd: "help",
    user: process.env.LOOPAT_USER ?? "alice",
    cliAdded: [],
    cliRemoved: [],
    dryRun: false,
    doSpawn: false,
    useBwrap: false,
    showEnv: false,
    verbose: true,
    claudeArgs: [],
  }
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--") {
      out.claudeArgs = argv.slice(i + 1)
      break
    }
    if (a === "run" || a === "list" || a === "help") out.cmd = a
    else if (a === "--user") out.user = argv[++i]
    else if (a === "--vault") out.vault = argv[++i]
    else if (a === "--profiles") {
      out.overrideProfiles = argv[++i].split(",").map((s) => s.trim()).filter(Boolean)
    } else if (a === "--dry-run") out.dryRun = true
    else if (a === "--spawn") out.doSpawn = true
    else if (a === "--bwrap") {
      out.useBwrap = true
      out.doSpawn = true
    } else if (a === "--show-env") out.showEnv = true
    else if (a === "--quiet") out.verbose = false
    else if (a === "-h" || a === "--help") out.cmd = "help"
    else if (a.startsWith("+")) out.cliAdded.push(a.slice(1))
    else if (a.startsWith("-") && !a.startsWith("--")) out.cliRemoved.push(a.slice(1))
    i++
  }
  if (out.cmd === "help" && (out.cliAdded.length || out.cliRemoved.length || out.overrideProfiles)) {
    out.cmd = "run"
  }
  return out
}

function printHelp() {
  console.log(`
loopat — profile-driven loop runner (CC-native model)

LOOPAT_HOME=${LOOPAT_HOME}

USAGE:
  loopat run [opts] [+profile...] [-profile...] [-- claude-args...]
  loopat list
  loopat help

OPTIONS:
  --user <u>          Personal user (default: $LOOPAT_USER or "alice")
  --vault <v>         Override default_vault from personal config
  --profiles a,b,c    Replace default_profiles entirely
  --dry-run           Plan only, no side effects
  --spawn             Launch claude after materialize
  --bwrap             --spawn + bubblewrap isolation
  --show-env          Print vault env var names (not values)
  --quiet             Suppress orchestration logs
  --                  Pass remaining args to claude
`.trim())
}

/** Filename = env var name (validated). File content = value. */
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/
function loadVaultEnv(vaultDir: string | undefined): { env: Record<string, string>; source: string | null } {
  if (!vaultDir || !existsSync(vaultDir)) return { env: {}, source: null }
  const env: Record<string, string> = {}
  for (const name of readdirSync(vaultDir)) {
    if (name.startsWith(".") || !ENV_NAME_RE.test(name)) continue
    env[name] = readFileSync(join(vaultDir, name), "utf8").replace(/\n$/, "")
  }
  return { env, source: vaultDir }
}

function printPlan(plan: LoopPlan, vaultLoad: ReturnType<typeof loadVaultEnv>, showEnv: boolean) {
  console.log("─".repeat(60))
  console.log(`LOOPAT_HOME: ${LOOPAT_HOME}`)
  console.log(`USER:        ${plan.user}`)
  console.log(`VAULT:       ${plan.vault ?? "(none)"}${plan.vaultDir ? ` (${plan.vaultDir})` : ""}`)
  console.log("\nACTIVE PROFILES:")
  if (plan.profiles.length === 0) console.log("  (none — team + personal only)")
  for (const p of plan.profiles) console.log(`  · ${p}`)
  console.log("\n.claude/ SOURCES (merge order, later wins):")
  for (const s of plan.claudeSources) console.log(`  · ${s.source}  (${s.dir})`)

  console.log("\nVAULT ENV:")
  console.log(`  source: ${vaultLoad.source ?? "(not found)"}`)
  const names = Object.keys(vaultLoad.env).sort()
  console.log(`  vars:   ${names.length}`)
  if (showEnv) {
    for (const k of names) console.log(`    · ${k}=<${vaultLoad.env[k].length} bytes>`)
  } else if (names.length > 0) {
    console.log(`    · ${names.join(", ")}`)
  }
  console.log("─".repeat(60))
}

function printCompose(c: ComposeResult) {
  console.log("\n" + "─".repeat(60))
  console.log("MATERIALIZED:")
  console.log(`  settings.json:     ${c.settingsPath}`)
  console.log(`  CLAUDE.md:         ${c.claudeMdPath}`)
  console.log(`  sources merged:    ${c.sources.join(" → ")}`)
  console.log(`  enabledPlugins:    ${c.enabledPlugins.length}`)
  for (const p of c.enabledPlugins) console.log(`    · ${p}`)
  console.log(`  extraMarketplaces: ${c.extraMarketplaces.length}`)
  for (const m of c.extraMarketplaces) console.log(`    · ${m}`)
}

function buildBwrapArgv(opts: {
  loopDir: string
  vaultDir?: string
  homeDir: string
  claudeArgs: string[]
}): string[] {
  const SYSTEM_RO = ["/usr", "/lib", "/lib64", "/lib32", "/bin", "/sbin", "/etc", "/opt", "/var"]
  const args: string[] = []
  for (const p of SYSTEM_RO) args.push("--ro-bind-try", p, p)
  args.push(
    "--proc", "/proc",
    "--dev", "/dev",
    "--bind", "/tmp", "/tmp",
    "--bind", opts.loopDir, "/loopat/loop",
    "--bind", opts.homeDir, opts.homeDir,
  )
  const knowledgeSrc = workspaceKnowledgeDir()
  if (existsSync(knowledgeSrc)) args.push("--ro-bind", knowledgeSrc, "/loopat/knowledge")
  if (opts.vaultDir) args.push("--ro-bind", opts.vaultDir, "/loopat/vault")
  args.push("--chdir", "/loopat/loop", "--unshare-pid", "--die-with-parent")
  args.push("claude", ...opts.claudeArgs)
  return args
}

async function spawnClaude(
  loopDirPath: string,
  vaultEnv: Record<string, string>,
  vaultDir: string | undefined,
  useBwrap: boolean,
  claudeArgs: string[],
): Promise<number> {
  const home = process.env.HOME ?? "/root"
  const env = { ...process.env, ...vaultEnv }
  console.log(`\n[loopat] launching claude (${useBwrap ? "bwrap" : "direct"})…`)
  return new Promise((resolve) => {
    let child
    if (useBwrap) {
      const args = buildBwrapArgv({ loopDir: loopDirPath, vaultDir, homeDir: home, claudeArgs })
      child = spawn("bwrap", args, { env, stdio: "inherit" })
    } else {
      child = spawn("claude", claudeArgs, { cwd: loopDirPath, env, stdio: "inherit" })
    }
    child.on("exit", (code, sig) => resolve(code ?? (sig ? 130 : 1)))
    child.on("error", (e) => {
      console.error(`[loopat] spawn failed: ${e.message}`)
      resolve(127)
    })
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.cmd === "help") {
    printHelp()
    return
  }

  if (!existsSync(LOOPAT_HOME)) {
    console.error(`LOOPAT_HOME does not exist: ${LOOPAT_HOME}`)
    console.error("Run scripts/setup-experience.sh first.")
    process.exit(2)
  }

  if (args.cmd === "list") {
    const profiles = await listProfiles()
    console.log(`Available profiles in ${LOOPAT_HOME}:`)
    if (profiles.length === 0) console.log("  (none)")
    for (const p of profiles) console.log(`  · ${p}`)
    return
  }

  // run
  const plan = await resolveLoopPlan({
    user: args.user,
    cliAdded: args.cliAdded,
    cliRemoved: args.cliRemoved,
    overrideProfiles: args.overrideProfiles,
    vaultOverride: args.vault,
  })
  const vaultLoad = loadVaultEnv(plan.vaultDir)
  printPlan(plan, vaultLoad, args.showEnv)

  if (args.dryRun) {
    console.log("\n[dry-run] skipping materialize + spawn")
    return
  }

  const loopId = `loop-${Date.now()}`
  const compose = await composeFromPlan(loopId, plan)
  printCompose(compose)

  // Ensure host CC has every marketplace registered + plugin installed.
  // The CLI claude reads enabledPlugins from settings.json natively (same as
  // the SDK does now post-2026-05).
  console.log("\n[loopat] installing plugins …")
  await ensureLoopPluginsInstalled(loopId)

  if (!args.doSpawn) {
    console.log("\n(materialize complete — pass --spawn or --bwrap to launch claude)")
    return
  }

  // CLI spawn: vault env via process env; bwrap for isolation; CC reads
  // CLAUDE.md as project-tier from loopDir (we materialize to loopDir, not
  // loopDir/.claude/, for the CLI-claude case — see compose.ts comment).
  // Wait: we DO materialize to loopDir/.claude/. For CLI claude to pick it
  // up as project-tier, we symlink loopDir/CLAUDE.md → .claude/CLAUDE.md.
  const symlinkProjectClaudeMd = async () => {
    const { symlink, rm } = await import("node:fs/promises")
    const link = join(loopDir(loopId), "CLAUDE.md")
    await rm(link, { force: true }).catch(() => {})
    if (existsSync(compose.claudeMdPath)) {
      await symlink(".claude/CLAUDE.md", link, "file").catch(() => {})
    }
  }
  await symlinkProjectClaudeMd()

  const exit = await spawnClaude(
    loopDir(loopId),
    vaultLoad.env,
    plan.vaultDir,
    args.useBwrap,
    args.claudeArgs,
  )
  console.log(`\n[loopat] claude exited with code ${exit}`)
  process.exit(exit)
}

main().catch((e) => {
  console.error("Error:", e.message ?? e)
  process.exit(1)
})
