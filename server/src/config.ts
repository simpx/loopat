import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { workspaceDir } from "./paths"

export type ProviderConfig = {
  model: string
  baseUrl: string
  apiKey: string
}

export type RemoteSpec = {
  /** clone URL; empty string or omitted = local-only, don't clone */
  git?: string
}

/** A repo registered for spawn-loop use, cloned to context/repos/<name>/. */
export type RepoSpec = {
  name: string
  git: string
}

/**
 * config.json is the workspace's self-describing manifest. Hand this file
 * (with apiKey + git URLs filled in) to a clean machine and bootstrap can
 * reconstruct the workspace: clone knowledge/notes/repos from remotes,
 * seed doctrine, set up personal/.
 */
export type WorkspaceConfig = {
  knowledge?: RemoteSpec
  notes?: RemoteSpec
  repos?: RepoSpec[]
  default: string
  providers: Record<string, ProviderConfig>
}

const TEMPLATE: WorkspaceConfig = {
  knowledge: { git: "https://github.com/simpx/loopat-knowledge.git" },
  notes: { git: "https://github.com/simpx/loopat-notes.git" },
  repos: [
    { name: "loopat", git: "https://github.com/simpx/loopat.git" },
  ],
  default: "bailian",
  providers: {
    bailian: {
      model: "glm-5",
      baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
      apiKey: "",
    },
    anthropic: {
      model: "claude-opus-4-7",
      baseUrl: "https://api.anthropic.com",
      apiKey: "",
    },
  },
}

export const configPath = () => join(workspaceDir(), "config.json")

let cached: WorkspaceConfig | null = null

export async function loadConfig(): Promise<WorkspaceConfig> {
  if (cached) return cached
  const path = configPath()
  if (!existsSync(path)) {
    await mkdir(workspaceDir(), { recursive: true })
    await writeFile(path, JSON.stringify(TEMPLATE, null, 2) + "\n")
    console.warn(`[loopat] config: created template at ${path} — fill in apiKey then restart`)
    cached = TEMPLATE
    return cached
  }
  const raw = await readFile(path, "utf8")
  const parsed = JSON.parse(raw) as WorkspaceConfig
  if (!parsed.providers || typeof parsed.providers !== "object") {
    throw new Error(`config.json malformed: missing providers`)
  }
  if (!parsed.default || !parsed.providers[parsed.default]) {
    throw new Error(`config.json: default "${parsed.default}" not in providers`)
  }
  cached = parsed
  return cached
}

export function getActiveProvider(cfg: WorkspaceConfig): { name: string; provider: ProviderConfig } {
  return { name: cfg.default, provider: cfg.providers[cfg.default] }
}
