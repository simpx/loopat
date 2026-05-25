export const PROVIDER_PRESETS: Array<{ name: string; baseUrl: string; models: string[] }> = [
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
