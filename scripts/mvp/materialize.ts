/**
 * MVP loop sandbox materializer.
 *
 * Takes a ResolvePlan, performs the side effects loopat owns:
 *   1. Ensure the workspace's local marketplace is registered with CC
 *   2. Orchestrate `claude plugin install` for each plugin (cross-marketplace works)
 *   3. Concat all CLAUDE.md fragments → loop/CLAUDE.md
 *   4. Symlink each profile's knowledge/ into loop/knowledge/<source>/
 *
 * Vault env injection is deferred — that's a later milestone.
 * No bwrap / isolation yet — the loop dir is just a host dir with concat'd content.
 */

import { existsSync } from "node:fs"
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { execSync } from "node:child_process"
import { basename, join } from "node:path"
import type { ResolvePlan } from "./profiles"

export type MaterializeOpts = {
  workspaceDir: string
  loopDir: string
  /** Marketplace name the workspace's plugins/ dir should be registered as. Read from marketplace.json. */
  ensureLocalMarketplace?: boolean
  /** Print verbose orchestration steps. */
  verbose?: boolean
}

export type MaterializeResult = {
  loopDir: string
  claudeMdPath: string
  installedPlugins: string[]
  failedPlugins: Array<{ plugin: string; error: string }>
  knowledgeSymlinks: Array<{ source: string; to: string }>
}

/** Read the local marketplace.json `name` so we know how to register it. */
async function readLocalMarketplaceName(workspaceDir: string): Promise<string | null> {
  const path = join(workspaceDir, "plugins", ".claude-plugin", "marketplace.json")
  if (!existsSync(path)) return null
  try {
    const raw = await readFile(path, "utf8")
    return JSON.parse(raw).name ?? null
  } catch {
    return null
  }
}

/** Quick CLI invocation helper. Returns stdout. Throws on non-zero exit. */
function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

function shSoft(cmd: string): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }
  } catch (e: any) {
    return { ok: false, out: e?.stdout?.toString?.() ?? e?.message ?? String(e) }
  }
}

function log(verbose: boolean, msg: string) {
  if (verbose) console.log(msg)
}

/**
 * Ensure the workspace's local marketplace is registered with CC. Idempotent.
 * Reads the marketplace name from the workspace's marketplace.json, checks
 * `claude plugin marketplace list`, adds if missing.
 */
async function ensureLocalMarketplace(workspaceDir: string, verbose: boolean): Promise<string | null> {
  const name = await readLocalMarketplaceName(workspaceDir)
  if (!name) {
    log(verbose, `[materialize] no local marketplace in ${workspaceDir}/plugins/ — skipping`)
    return null
  }
  const mpDir = join(workspaceDir, "plugins")
  const list = sh("claude plugin marketplace list")
  if (list.includes(name)) {
    log(verbose, `[materialize] local marketplace "${name}" already registered`)
    return name
  }
  log(verbose, `[materialize] registering local marketplace "${name}" at ${mpDir}`)
  sh(`claude plugin marketplace add ${mpDir}`)
  return name
}

/**
 * For each plugin spec in the plan, run `claude plugin install`. Cross-marketplace
 * deps (`name@other-mp`) just work because we drive each install explicitly.
 * Already-installed plugins are detected by `claude plugin list` and skipped.
 */
async function installPlugins(
  specs: string[],
  verbose: boolean,
): Promise<{ installed: string[]; failed: Array<{ plugin: string; error: string }> }> {
  const installed: string[] = []
  const failed: Array<{ plugin: string; error: string }> = []
  const listed = sh("claude plugin list")
  for (const spec of specs) {
    if (listed.includes(spec.split("@")[0])) {
      // Roughly check by plugin name (without marketplace). Good enough for MVP.
      log(verbose, `[install] ${spec} — already installed, skip`)
      installed.push(spec)
      continue
    }
    log(verbose, `[install] ${spec} …`)
    const r = shSoft(`claude plugin install ${spec} --scope=user`)
    if (r.ok) {
      installed.push(spec)
    } else {
      failed.push({ plugin: spec, error: r.out.trim().split("\n").pop() ?? "unknown" })
    }
  }
  return { installed, failed }
}

/** Concat all CLAUDE.md fragments with source markers, write to loop/CLAUDE.md. */
async function concatClaudeMd(plan: ResolvePlan, loopDir: string): Promise<string> {
  const dst = join(loopDir, "CLAUDE.md")
  if (plan.claudeMdChain.length === 0) {
    if (existsSync(dst)) await rm(dst)
    return dst
  }
  let body = ""
  for (const frag of plan.claudeMdChain) {
    const content = (await readFile(frag.path, "utf8")).trim()
    body += `\n<!-- ========== ${frag.source} ========== -->\n`
    body += `<!-- from: ${frag.path} -->\n`
    body += content
    body += "\n"
  }
  await writeFile(dst, body)
  return dst
}

/**
 * Symlink each profile's knowledge/ subdir into loop/knowledge/<profile-name>/.
 * Different profiles' knowledge stays separated by source — easy to trace
 * which profile contributed what.
 */
async function mountKnowledge(plan: ResolvePlan, loopDir: string): Promise<Array<{ source: string; to: string }>> {
  const knowledgeRoot = join(loopDir, "knowledge")
  await mkdir(knowledgeRoot, { recursive: true })
  const links: Array<{ source: string; to: string }> = []
  for (const p of plan.profiles) {
    if (!p.knowledgeDir) continue
    const target = join(knowledgeRoot, p.name)
    if (existsSync(target)) await rm(target, { recursive: true, force: true })
    await symlink(p.knowledgeDir, target, "dir")
    links.push({ source: p.name, to: target })
  }
  return links
}

/**
 * Materialize a loop sandbox from the plan. Idempotent at the loopDir level
 * (caller passes a fresh dir per loop spawn).
 */
export async function materialize(plan: ResolvePlan, opts: MaterializeOpts): Promise<MaterializeResult> {
  const { workspaceDir, loopDir, verbose = false } = opts

  await mkdir(loopDir, { recursive: true })

  if (opts.ensureLocalMarketplace !== false) {
    await ensureLocalMarketplace(workspaceDir, verbose)
  }

  const { installed, failed } = await installPlugins(plan.plugins, verbose)
  const claudeMdPath = await concatClaudeMd(plan, loopDir)
  const knowledgeSymlinks = await mountKnowledge(plan, loopDir)

  return {
    loopDir,
    claudeMdPath,
    installedPlugins: installed,
    failedPlugins: failed,
    knowledgeSymlinks,
  }
}
