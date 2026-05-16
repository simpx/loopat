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
import type { LoopMeta } from "./loops"
import { bundledDoctrinePath } from "./paths"

let cachedBundled: string | null = null

async function loadBundled(): Promise<string> {
  if (cachedBundled !== null) return cachedBundled
  cachedBundled = await readFile(bundledDoctrinePath(), "utf8")
  return cachedBundled
}

export function invalidateDoctrineCache(): void {
  cachedBundled = null
}

function buildRuntimeBlock(loop: LoopMeta): string {
  const repoLine = loop.repo ? `${loop.repo} (branch ${loop.branch ?? "main"})` : "(no repo bound — empty workdir)"
  return `## Runtime context (this loop)

- title: ${loop.title}
- id: ${loop.id}
- driver: ${loop.createdBy}
- workdir: /loopat/loop/${loop.id}/workdir
- repo: ${repoLine}
- created: ${loop.createdAt}
`.trim()
}

export async function buildLoopatAppend(loop: LoopMeta): Promise<string> {
  const bundled = await loadBundled()
  const runtime = buildRuntimeBlock(loop)
  return `${bundled}\n\n${runtime}\n`.trim()
}
