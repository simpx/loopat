export const DEFAULT_PROVIDER_PRESETS: Array<{ name: string; baseUrl: string; models: string[] }> = [
  { name: "Anthropic", baseUrl: "https://api.anthropic.com",
    models: ["claude-sonnet-4-20250514", "claude-opus-4-7-20251101"] },
  { name: "DeepSeek",  baseUrl: "https://api.deepseek.com/anthropic",
    models: ["deepseek-v4-pro[1m]", "deepseek-v4-flash[1m]"] },
  { name: "Kimi",      baseUrl: "https://api.moonshot.cn/anthropic",
    models: ["kimi-k2.6"] },
  { name: "MiniMax",   baseUrl: "https://api.minimaxi.com/anthropic",
    models: ["MiniMax-M2.7"] },
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1",
    models: ["anthropic/claude-sonnet-4", "openai/gpt-4o", "google/gemini-2.5-flash"] },
]

export const DEFAULT_MISE_TOOL_PRESETS: Array<{ name: string; suggestedVersion: string; description?: string; backend?: string }> = [
  { name: "node",       suggestedVersion: "22",      description: "Node.js runtime" },
  { name: "python",     suggestedVersion: "3.12",    description: "Python runtime" },
  { name: "go",         suggestedVersion: "1.22",    description: "Go programming language" },
  { name: "rust",       suggestedVersion: "stable",  description: "Rust programming language" },
  { name: "bun",        suggestedVersion: "latest",  description: "Bun all-in-one runtime" },
  { name: "java",       suggestedVersion: "21",      description: "Java Development Kit" },
  { name: "terraform",  suggestedVersion: "1.9",     description: "Infrastructure as code", backend: "aqua:hashicorp/terraform" },
  { name: "lua",        suggestedVersion: "5.1",     description: "Lua scripting language" },
  { name: "zig",        suggestedVersion: "0.13",    description: "Zig general-purpose language" },
  { name: "ripgrep",    suggestedVersion: "14.1",    description: "Line-oriented search tool", backend: "aqua:BurntSushi/ripgrep" },
  { name: "fd",         suggestedVersion: "10.2",    description: "Fast file finder", backend: "aqua:sharkdp/fd" },
  { name: "jq",         suggestedVersion: "1.7",     description: "Command-line JSON processor", backend: "aqua:jqlang/jq" },
]

/** @deprecated — use DEFAULT_PROVIDER_PRESETS */
export const PROVIDER_PRESETS = DEFAULT_PROVIDER_PRESETS
