import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { workspaceDir } from "./paths"

export type ProviderConfig = {
  model: string
  baseUrl: string
  apiKey: string
}

export type WorkspaceConfig = {
  default: string
  providers: Record<string, ProviderConfig>
}

const TEMPLATE: WorkspaceConfig = {
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
