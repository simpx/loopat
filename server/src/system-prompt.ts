/**
 * System prompt composition. Layers:
 *   L1 (preset)     Claude Code preset — built-in
 *   L2 (doctrine)   bundled platform doctrine (server/templates/CLAUDE.md):
 *                   sandbox layout, virtual paths, memory model. Always loaded.
 *                   Injected via `systemPrompt.append`.
 *   L2+ (workspace) optional workspace supplement at knowledge/.loopat/claude/CLAUDE.md.
 *                   Bound into CLAUDE_CONFIG_DIR/CLAUDE.md and auto-loaded by
 *                   Claude Code as user-tier (settingSources: ["user", ...]).
 *                   See bwrap.ts for the bind.
 *   L2++ (project)  optional <workdir>/CLAUDE.md auto-loaded by Claude Code
 *                   itself (enabled via `settingSources: [..., "project"]`).
 *   L3 (runtime)    per-loop dynamic info (title/id/branch/repo).
 *                   Injected via `systemPrompt.append`.
 *
 * Doctrine uses **virtual paths** (/loopat/loop/<id>/, /loopat/context/*) since
 * the loop runs inside the outer bwrap sandbox and that's what Claude sees.
 */
import { readFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { effectiveDriver, type LoopMeta } from "./loops"
import { bundledDoctrinePath, workspaceNotesDir, workspaceKnowledgeDir } from "./paths"

const execFileP = promisify(execFile)

let cachedBundled: string | null = null

async function loadBundled(): Promise<string> {
  if (cachedBundled !== null) return cachedBundled
  cachedBundled = await readFile(bundledDoctrinePath(), "utf8")
  return cachedBundled
}

export function invalidateDoctrineCache(): void {
  cachedBundled = null
}

async function detectTrunkBranch(repoDir: string): Promise<string> {
  try {
    const { stdout } = await execFileP("git", ["-C", repoDir, "symbolic-ref", "--short", "HEAD"])
    return stdout.trim() || "main"
  } catch {
    return "main"
  }
}

async function buildRuntimeBlock(loop: LoopMeta): Promise<string> {
  const repoLine = loop.repo ? `${loop.repo} (branch ${loop.branch ?? "main"})` : "(no repo bound — empty workdir)"
  const [notesTrunk, knowledgeTrunk] = await Promise.all([
    detectTrunkBranch(workspaceNotesDir()),
    detectTrunkBranch(workspaceKnowledgeDir()),
  ])
  return `## Runtime context (this loop)

- title: ${loop.title}
- id: ${loop.id}
- driver: ${effectiveDriver(loop)}
- workdir: /loopat/loop/${loop.id}/workdir
- repo: ${repoLine}
- context worktrees: notes on branch \`loop/${loop.id}\` (trunk \`${notesTrunk}\`), knowledge on branch \`loop/${loop.id}\` (trunk \`${knowledgeTrunk}\`)
- created: ${loop.createdAt}
`.trim()
}

export async function buildLoopatAppend(loop: LoopMeta): Promise<string> {
  const bundled = await loadBundled()
  const runtime = await buildRuntimeBlock(loop)
  return `${bundled}\n\n${runtime}\n`.trim()
}
