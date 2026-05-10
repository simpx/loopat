/**
 * System prompt composition. Three layers stack as `systemPrompt.append`:
 *   L1 (preset)    Claude Code preset — built-in
 *   L2 (doctrine)  workspace-shared, file at workspaceDoctrinePath()
 *                  describes loopat sandbox, conventions, memory model
 *   L3 (runtime)   per-loop dynamic info (title/id/branch/repo)
 *
 * Doctrine uses **virtual paths** (/loop/<id>/, /context/*, /personal/*) since
 * the loop runs inside the outer bwrap sandbox and that's what Claude sees.
 */
import { readFile } from "node:fs/promises"
import type { LoopMeta } from "./loops"
import { workspaceDoctrinePath, ME } from "./paths"

let cachedDoctrine: string | null = null

async function loadDoctrine(): Promise<string> {
  if (cachedDoctrine !== null) return cachedDoctrine
  try {
    cachedDoctrine = await readFile(workspaceDoctrinePath(), "utf8")
  } catch {
    cachedDoctrine = ""
  }
  return cachedDoctrine
}

export function invalidateDoctrineCache(): void {
  cachedDoctrine = null
}

function buildRuntimeBlock(loop: LoopMeta): string {
  const repoLine = loop.repo ? `${loop.repo} (branch ${loop.branch ?? "main"})` : "(no repo bound — empty workdir)"
  return `## Runtime context (this loop)

- title: ${loop.title}
- id: ${loop.id}
- driver: ${ME}
- workdir: /loop/${loop.id}
- repo: ${repoLine}
- created: ${loop.createdAt}
`.trim()
}

export async function buildLoopatAppend(loop: LoopMeta): Promise<string> {
  const doctrine = await loadDoctrine()
  const runtime = buildRuntimeBlock(loop)
  return `${doctrine}\n\n${runtime}\n`.trim()
}
