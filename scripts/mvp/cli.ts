#!/usr/bin/env bun
/**
 * MVP loopat CLI.
 *
 * Usage:
 *   bun scripts/mvp/cli.ts run [--user <u>] [+profile ...] [-profile ...] [--dry-run]
 *
 * Defaults point at docs/design/sample-workspace/ so anyone can run it
 * without setting up a real LOOPAT_HOME.
 *
 * Examples:
 *   bun scripts/mvp/cli.ts run                                    # alice, defaults
 *   bun scripts/mvp/cli.ts run +mode-oncall                       # alice + oncall
 *   bun scripts/mvp/cli.ts run +mode-oncall -role-security        # add + remove
 *   bun scripts/mvp/cli.ts run --user alice --dry-run             # just plan
 *   bun scripts/mvp/cli.ts run --workspace /path --personal /path # custom paths
 */

import { join, resolve } from "node:path"
import { resolveLoopPlan } from "./profiles"
import { materialize } from "./materialize"
import { loadVaultEnv } from "./vaults"
import { spawnClaude } from "./spawn"

type Args = {
  cmd: "run" | "help"
  user: string
  workspace: string
  personal: string
  loopBase: string
  cliAdded: string[]
  cliRemoved: string[]
  overrideProfiles?: string[]
  dryRun: boolean
  verbose: boolean
  doSpawn: boolean
  useBwrap: boolean
  showEnv: boolean
  claudeArgs: string[]
}

function parseArgs(argv: string[]): Args {
  // Default sample workspace lives in the repo
  const REPO = resolve(__dirname, "../..")
  const defaults: Args = {
    cmd: "run",
    user: "alice",
    workspace: resolve(REPO, "docs/design/sample-workspace/workspace"),
    personal: resolve(REPO, "docs/design/sample-workspace/personal"),
    loopBase: "/tmp/loopat-mvp-loops",
    cliAdded: [],
    cliRemoved: [],
    dryRun: false,
    verbose: true,
    doSpawn: false,
    useBwrap: false,
    showEnv: false,
    claudeArgs: [],
  }

  const out = { ...defaults }
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === "--") {
      // Everything after `--` goes to claude
      out.claudeArgs = argv.slice(i + 1)
      break
    }
    if (a === "run" || a === "help") {
      out.cmd = a
    } else if (a === "--user") {
      out.user = argv[++i]
    } else if (a === "--workspace") {
      out.workspace = resolve(argv[++i])
    } else if (a === "--personal") {
      out.personal = resolve(argv[++i])
    } else if (a === "--loop-base") {
      out.loopBase = resolve(argv[++i])
    } else if (a === "--profiles") {
      out.overrideProfiles = argv[++i].split(",").map((s) => s.trim()).filter(Boolean)
    } else if (a === "--dry-run") {
      out.dryRun = true
    } else if (a === "--quiet") {
      out.verbose = false
    } else if (a === "--spawn") {
      out.doSpawn = true
    } else if (a === "--bwrap") {
      out.useBwrap = true
      out.doSpawn = true // bwrap implies spawn
    } else if (a === "--show-env") {
      out.showEnv = true
    } else if (a.startsWith("+")) {
      out.cliAdded.push(a.slice(1))
    } else if (a.startsWith("-") && !a.startsWith("--")) {
      out.cliRemoved.push(a.slice(1))
    } else if (a === "-h" || a === "--help") {
      out.cmd = "help"
    }
    i++
  }
  return out
}

function printHelp() {
  console.log(`
loopat MVP — profile-based loop materializer

USAGE:
  bun scripts/mvp/cli.ts run [opts] [+profile...] [-profile...]

OPTIONS:
  --user <u>            Personal user (default: alice)
  --workspace <path>    Workspace dir (default: docs/design/sample-workspace/workspace)
  --personal <path>     Personal root (default: docs/design/sample-workspace/personal)
  --loop-base <path>    Where to materialize loops (default: /tmp/loopat-mvp-loops)
  --profiles a,b,c      Override entire profile set (still keeps base)
  --dry-run             Show plan only — no CC plugin install, no sandbox writes
  --spawn               After materialize, launch claude in the loop dir
  --bwrap               --spawn + wrap claude in bubblewrap (minimal isolation)
  --show-env            Print loaded vault env var names (not values)
  --quiet               Suppress verbose orchestration logs
  -h, --help            This help

EXAMPLES:
  bun scripts/mvp/cli.ts run --dry-run
  bun scripts/mvp/cli.ts run +mode-oncall
  bun scripts/mvp/cli.ts run +mode-oncall -role-security
  bun scripts/mvp/cli.ts run --user alice --profiles mode-incident
  bun scripts/mvp/cli.ts run +mode-oncall --spawn       # actually launch CC
  bun scripts/mvp/cli.ts run +mode-oncall --bwrap       # CC in bubblewrap
`.trim())
}

type Plan = ReturnType<typeof resolveLoopPlan> extends Promise<infer R> ? R : never
type VaultLoad = ReturnType<typeof loadVaultEnv> extends Promise<infer R> ? R : never

function printPlan(plan: Plan) {
  console.log("─".repeat(60))
  console.log(`USER:        ${plan.user}`)
  console.log(`VAULT:       ${plan.vault ?? "(none)"}`)
  console.log("\nACTIVE PROFILES:")
  for (const p of plan.profiles) console.log(`  · ${p.name}`)
  console.log("\nPLUGINS to install (union, cross-marketplace):")
  if (plan.plugins.length === 0) console.log("  (none)")
  for (const s of plan.plugins) console.log(`  · ${s}`)
  console.log("\nCLAUDE.md fragments (concat order):")
  for (const c of plan.claudeMdChain) console.log(`  · ${c.source}`)
}

function printVault(plan: Plan, v: VaultLoad, showEnv: boolean) {
  console.log("\nVAULT ENV:")
  console.log(`  source:            ${v.source ?? "(not found)"}`)
  console.log(`  env vars loaded:   ${Object.keys(v.env).length}`)
  const names = Object.keys(v.env).sort()
  if (showEnv) {
    for (const k of names) console.log(`    · ${k}=<${v.env[k].length} bytes>`)
  } else if (names.length > 0) {
    console.log(`    · ${names.join(", ")}`)
  }
  if (v.skipped.length > 0) {
    console.log(`  skipped (bad name): ${v.skipped.join(", ")}`)
  }
  console.log("─".repeat(60))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.cmd === "help") {
    printHelp()
    return
  }

  const plan = await resolveLoopPlan({
    workspaceDir: args.workspace,
    personalDir: args.personal,
    user: args.user,
    cliAdded: args.cliAdded,
    cliRemoved: args.cliRemoved,
    overrideProfiles: args.overrideProfiles,
  })

  // Vault env loading is a pure read — load it before dry-run check so the plan is complete.
  const vaultLoad = await loadVaultEnv(args.personal, args.user, plan.vault)

  printPlan(plan)
  printVault(plan, vaultLoad, args.showEnv)

  if (args.dryRun) {
    console.log("\n[dry-run] skipping materialize + spawn")
    return
  }

  const loopId = `mvp-${Date.now()}`
  const result = await materialize(plan, {
    workspaceDir: args.workspace,
    loopDir: `${args.loopBase}/${loopId}`,
    verbose: args.verbose,
  })

  console.log("\n" + "─".repeat(60))
  console.log("MATERIALIZED:")
  console.log(`  loopDir:           ${result.loopDir}`)
  console.log(`  CLAUDE.md:         ${result.claudeMdPath}`)
  console.log(`  plugins installed: ${result.installedPlugins.length}`)
  for (const s of result.installedPlugins) console.log(`    ✓ ${s}`)
  if (result.failedPlugins.length > 0) {
    console.log(`  plugins FAILED:    ${result.failedPlugins.length}`)
    for (const f of result.failedPlugins) console.log(`    ✗ ${f.plugin} — ${f.error}`)
  }
  console.log(`  knowledge mounts:  ${result.knowledgeSymlinks.length}`)
  for (const k of result.knowledgeSymlinks) console.log(`    → ${k.source} → ${k.to}`)
  console.log("─".repeat(60))

  if (!args.doSpawn) {
    console.log("\n(materialize complete — pass --spawn or --bwrap to launch claude)")
    return
  }

  const vaultDir = plan.vault ? join(args.personal, args.user, "vaults", plan.vault) : null
  console.log(`\n[cli] launching claude (${args.useBwrap ? "bwrap" : "direct"})…`)
  const exit = await spawnClaude({
    loopDir: result.loopDir,
    workspaceDir: args.workspace,
    vaultDir,
    vaultEnv: vaultLoad.env,
    useBwrap: args.useBwrap,
    claudeArgs: args.claudeArgs,
  })
  console.log(`\n[cli] claude exited with code ${exit}`)
  process.exit(exit)
}

main().catch((e) => {
  console.error("Error:", e.message ?? e)
  process.exit(1)
})
