/**
 * System prompt composition.
 *
 * Two separate outputs:
 *   1. `buildLoopatAppend()` → static doctrine for systemPrompt.append.
 *      Changes only when the bundled CLAUDE.md template is updated.
 *      Does NOT contain per-loop dynamic info — that goes into a
 *      synthetic user message instead (see buildSessionContextBlock).
 *
 *   2. `buildSessionContextBlock()` → per-loop dynamic info injected
 *      as an isSynthetic user message. Never touches system prompt.
 *
 * Layers:
 *   L1 (preset)     Claude Code preset — built-in
 *   L2 (doctrine)   bundled platform doctrine — always loaded, POST-FREEZE.
 *                   Static content only; injected via `systemPrompt.append`.
 *   L2+ (workspace) optional workspace supplement at knowledge/.loopat/claude/CLAUDE.md.
 *                   Bound into CLAUDE_CONFIG_DIR/CLAUDE.md and auto-loaded by
 *                   Claude Code as user-tier (settingSources: ["user", ...]).
 *   L2++ (project)  optional <workdir>/CLAUDE.md auto-loaded by Claude Code
 *                   itself (enabled via `settingSources: [..., "project"]`).
 *   L3 (synthetic)  per-loop dynamic info injected as isSynthetic user message
 *                   on the first turn. Contains title/id/branch/repo etc.
 *
 * By keeping L2 purely static, the system prompt prefix is identical across
 * all loops using the same bundled doctrine, maximizing prompt cache hits
 * at the Anthropic API level.
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

/**
 * Build the static system-prompt append — only the bundled doctrine.
 * No per-loop dynamic info. Same content for every loop.
 */
export async function buildLoopatAppend(): Promise<string> {
  return (await loadBundled()).trim()
}

/**
 * Build the per-loop runtime context block, injected as a synthetic
 * (isSynthetic) user message on the first turn so it doesn't pollute
 * the system prompt cache prefix.
 *
 * The model sees this as the first "user" message in history:
 *
 *   [Session context]
 *   - title: ...
 *   - id: ...
 *   - driver: ...
 *   - workdir: ...
 *   - repo: ...
 *   - created: ...
 */
export function buildSessionContextBlock(loop: LoopMeta): string {
  const repoLine = loop.repo
    ? `${loop.repo} (branch ${loop.branch ?? "main"})`
    : "(no repo bound — empty workdir)"
  return [
    "[Session context]",
    `- title: ${loop.title}`,
    `- id: ${loop.id}`,
    `- driver: ${loop.createdBy}`,
    `- workdir: /loopat/loop/${loop.id}/workdir`,
    `- repo: ${repoLine}`,
    `- created: ${loop.createdAt}`,
  ].join("\n")
}
