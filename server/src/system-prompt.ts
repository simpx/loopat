/**
 * System prompt composition. Layers stack as `systemPrompt.append`:
 *   L1 (preset)     Claude Code preset — built-in
 *   L2 (doctrine)   bundled platform doctrine (server/templates/CLAUDE.md):
 *                   sandbox layout, virtual paths, memory model. Always loaded.
 *   L2+ (team)      optional team supplement at knowledge/.loopat/claude/CLAUDE.md
 *                   workspace-specific conventions on top of the platform.
 *   L3 (runtime)    per-loop dynamic info (title/id/branch/repo)
 *
 * Doctrine uses **virtual paths** (/loop/<id>/, /context/*, /personal/*) since
 * the loop runs inside the outer bwrap sandbox and that's what Claude sees.
 */
import { readFile } from "node:fs/promises"
import type { LoopMeta } from "./loops"
import { bundledDoctrinePath, workspaceTeamClaudePath } from "./paths"

let cachedBundled: string | null = null
let cachedTeam: string | null = null

async function loadBundled(): Promise<string> {
  if (cachedBundled !== null) return cachedBundled
  cachedBundled = await readFile(bundledDoctrinePath(), "utf8")
  return cachedBundled
}

async function loadTeam(): Promise<string> {
  if (cachedTeam !== null) return cachedTeam
  try {
    cachedTeam = await readFile(workspaceTeamClaudePath(), "utf8")
  } catch {
    cachedTeam = ""
  }
  return cachedTeam
}

export function invalidateDoctrineCache(): void {
  cachedBundled = null
  cachedTeam = null
}

function buildRuntimeBlock(loop: LoopMeta): string {
  const repoLine = loop.repo ? `${loop.repo} (branch ${loop.branch ?? "main"})` : "(no repo bound — empty workdir)"
  return `## Runtime context (this loop)

- title: ${loop.title}
- id: ${loop.id}
- driver: ${loop.createdBy}
- workdir: /loop/${loop.id}
- repo: ${repoLine}
- created: ${loop.createdAt}
`.trim()
}

export async function buildLoopatAppend(loop: LoopMeta): Promise<string> {
  const bundled = await loadBundled()
  const team = await loadTeam()
  const runtime = buildRuntimeBlock(loop)
  const parts = [bundled, team, runtime].filter((s) => s.trim().length > 0)
  return parts.join("\n\n").trim()
}
