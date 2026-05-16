import { existsSync, statSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  personalLoopatConfigPath,
  personalLoopatDir,
  personalProviderKeyPath,
  personalTokenUsagePath,
  workspaceDir,
  workspaceClaudeJsonPath,
} from "./paths"

/**
 * MCP server config — shape matches Claude Agent SDK `McpServerConfig`.
 * - stdio: spawn a command (binary must be reachable in sandbox PATH)
 * - http/sse: connect to URL (network is shared with host, no extra bind needed)
 */
export type McpServerConfig =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> }

export type WorkspaceClaudeJson = {
  mcpServers?: Record<string, McpServerConfig>
}

export type ProviderConfig = {
  model: string
  baseUrl: string
  /** Filled in by loadPersonalConfig from secrets/provider-keys/<name>. */
  apiKey: string
  /**
   * Override cli's context-window detection for this model. cli has a
   * hardcoded list (DP / XV8 / coral_reef_sonnet predicates) of claude
   * models that get 1M; everything else falls back to DR1=200000. For
   * gateway-routed / non-claude models with larger windows, set this so
   * auto-compact (92% × window) fires at the right point. Activated via
   * env vars DISABLE_COMPACT=1 + CLAUDE_CODE_MAX_CONTEXT_TOKENS=<value>.
   */
  maxContextTokens?: number
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
 * Host -> sandbox bind, docker -v style. `~` and `$VAR` expand in both fields.
 * `dst` defaults to expanded `src`. `rw` defaults to false (ro-bind). Missing
 * source is silently skipped (uses bwrap *-bind-try).
 */
export type SandboxMount = {
  src: string
  dst?: string
  rw?: boolean
}

export type SandboxConfig = {
  /** Shell for PTY sessions (e.g. /usr/bin/fish). Falls back to SHELL env var then /bin/bash. */
  shell?: string
  /** Extra binds from host into sandbox. */
  mounts?: SandboxMount[]
  /** Dirs prepended to PATH inside sandbox (after `~`/`$VAR` expansion). */
  path?: string[]
}

/**
 * Workspace config (~/.loopat/config.json): workspace-shared, no per-user content.
 * Hand this file to a clean machine and bootstrap can reconstruct the
 * workspace: clone knowledge/notes/repos from remotes, seed doctrine.
 *
 * Per-user pieces (sandbox, providers, default provider) live in
 * personal/<user>/.loopat/config.json — see PersonalConfig.
 */
export type WorkspaceConfig = {
  knowledge?: RemoteSpec
  notes?: RemoteSpec
  repos?: RepoSpec[]
  providers?: Record<string, ProviderConfig>
  default?: string
  /** Domain suffix for workspace serve (e.g. "nip.io"). Defaults to "nip.io". */
  serveDomain?: string
  /** Whether to include port in the share URL. */
  serveWithPort?: boolean
  /** Whether to use HTTPS for share URLs. */
  serveHttps?: boolean
  /** Custom port to show in share URL (does not affect actual server listen port). */
  serveDisplayPort?: number
}

/**
 * Personal config (personal/<user>/.loopat/config.json): per-user, kept in
 * each driver's personal/ tree. Carries sandbox mounts (what host paths the
 * loop sandbox can see) + model providers + default provider choice.
 *
 * apiKey is NOT stored here — for each provider, loadPersonalConfig reads
 * personal/<user>/.loopat/secrets/provider-keys/<name> and fills the
 * `apiKey` field at load time. The secrets/ subtree is git-crypt encrypted;
 * config.json itself stays plain text so diffs / blame remain useful.
 */
export type PersonalConfig = {
  default: string
  providers: Record<string, ProviderConfig>
  sandbox?: SandboxConfig
  /** IM webhook URL for user notifications (e.g. WeCom, DingTalk, Feishu). */
  webhookUrl?: string
}

const WORKSPACE_TEMPLATE: WorkspaceConfig = {
  knowledge: { git: "git@github.com:simpx/loopat-knowledge.git" },
  notes: { git: "git@github.com:simpx/loopat-notes.git" },
  repos: [
    { name: "loopat", git: "git@github.com:simpx/loopat.git" },
  ],
}

const PERSONAL_TEMPLATE: PersonalConfig = {
  default: "",
  providers: {},
}

export const configPath = () => join(workspaceDir(), "config.json")

let cachedWorkspace: WorkspaceConfig | null = null
let cachedWorkspaceMtimeMs = 0

export async function loadConfig(): Promise<WorkspaceConfig> {
  const path = configPath()
  if (!existsSync(path)) {
    await mkdir(workspaceDir(), { recursive: true })
    await writeFile(path, JSON.stringify(WORKSPACE_TEMPLATE, null, 2) + "\n")
    console.warn(`[loopat] config: created template at ${path}`)
    cachedWorkspace = WORKSPACE_TEMPLATE
    cachedWorkspaceMtimeMs = statSync(path).mtimeMs
    return cachedWorkspace
  }
  // Re-read on mtime change so edits take effect on next attach without a
  // server restart.
  const mtimeMs = statSync(path).mtimeMs
  if (cachedWorkspace && mtimeMs === cachedWorkspaceMtimeMs) return cachedWorkspace
  const raw = await readFile(path, "utf8")
  const parsed = JSON.parse(raw) as WorkspaceConfig
  cachedWorkspace = parsed
  cachedWorkspaceMtimeMs = mtimeMs
  return cachedWorkspace
}

const personalCache = new Map<string, { cfg: PersonalConfig; mtimeMs: number; keyMtimes: Record<string, number> }>()

async function readApiKey(user: string, providerName: string): Promise<{ key: string; mtimeMs: number }> {
  const p = personalProviderKeyPath(user, providerName)
  if (!existsSync(p)) return { key: "", mtimeMs: 0 }
  try {
    const k = (await readFile(p, "utf8")).trim()
    return { key: k, mtimeMs: statSync(p).mtimeMs }
  } catch {
    return { key: "", mtimeMs: 0 }
  }
}

/**
 * Load personal config from personal/<user>/.loopat/config.json. Fills each
 * provider's apiKey from personal/<user>/.loopat/secrets/provider-keys/<name>.
 *
 * Creates a stub config + .loopat dir on first call for a user that has none
 * yet (so the file exists for the user to edit). Stub has empty providers map
 * — caller decides how to surface "not configured" to the UI / banner.
 */
export async function loadPersonalConfig(user: string): Promise<PersonalConfig> {
  const path = personalLoopatConfigPath(user)
  if (!existsSync(path)) {
    await mkdir(personalLoopatDir(user), { recursive: true })
    await writeFile(path, JSON.stringify(PERSONAL_TEMPLATE, null, 2) + "\n")
    console.warn(`[loopat] personal config: created template at ${path}`)
  }
  const mtimeMs = statSync(path).mtimeMs
  const cached = personalCache.get(user)
  // Reuse cache only if config.json AND every apiKey file's mtime are unchanged.
  if (cached && cached.mtimeMs === mtimeMs) {
    let stale = false
    for (const name of Object.keys(cached.cfg.providers)) {
      const p = personalProviderKeyPath(user, name)
      const m = existsSync(p) ? statSync(p).mtimeMs : 0
      if ((cached.keyMtimes[name] ?? 0) !== m) {
        stale = true
        break
      }
    }
    if (!stale) return cached.cfg
  }

  const raw = await readFile(path, "utf8")
  let parsed: PersonalConfig
  try {
    parsed = JSON.parse(raw) as PersonalConfig
    if (!parsed.providers || typeof parsed.providers !== "object") {
      throw new Error(`missing providers`)
    }
    if (parsed.default && !parsed.providers[parsed.default]) {
      throw new Error(`default "${parsed.default}" not in providers`)
    }
  } catch (e: any) {
    console.warn(`[loopat] personal config: ${path} is malformed (${e?.message ?? e}), rewriting template`)
    await writeFile(path, JSON.stringify(PERSONAL_TEMPLATE, null, 2) + "\n")
    parsed = JSON.parse(JSON.stringify(PERSONAL_TEMPLATE)) as PersonalConfig
  }
  const keyMtimes: Record<string, number> = {}
  for (const [name, p] of Object.entries(parsed.providers)) {
    const { key, mtimeMs: km } = await readApiKey(user, name)
    p.apiKey = key
    keyMtimes[name] = km
  }
  personalCache.set(user, { cfg: parsed, mtimeMs, keyMtimes })
  return parsed
}

export function getActiveProvider(cfg: PersonalConfig): { name: string; provider: ProviderConfig } | null {
  const name = cfg.default
  if (!name || !cfg.providers[name]) return null
  return { name, provider: cfg.providers[name] }
}

/**
 * Read workspace-shared Claude Code config from knowledge/.loopat/claude/claude.json.
 * Currently used only for mcpServers (passed through to SDK query options).
 * Missing / malformed → {} (so loops still start without workspace MCP servers).
 */
export async function loadWorkspaceClaudeJson(): Promise<WorkspaceClaudeJson> {
  const p = workspaceClaudeJsonPath()
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(await readFile(p, "utf8")) as WorkspaceClaudeJson
  } catch (e: any) {
    console.warn(`[loopat] workspace claude.json malformed at ${p}: ${e?.message ?? e}`)
    return {}
  }
}

// ── token usage ──

export type TokenUsage = Record<string, { inputTokens: number; outputTokens: number }>

export async function loadTokenUsage(user: string): Promise<TokenUsage> {
  const p = personalTokenUsagePath(user)
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(await readFile(p, "utf8")) as TokenUsage
  } catch {
    return {}
  }
}

export async function saveTokenUsage(user: string, usage: TokenUsage): Promise<void> {
  await mkdir(personalLoopatDir(user), { recursive: true })
  await writeFile(personalTokenUsagePath(user), JSON.stringify(usage, null, 2) + "\n")
}

export async function addTokenUsage(user: string, model: string, inputTokens: number, outputTokens: number): Promise<void> {
  if (!model || (inputTokens === 0 && outputTokens === 0)) return
  const usage = await loadTokenUsage(user)
  const entry = usage[model] ?? { inputTokens: 0, outputTokens: 0 }
  entry.inputTokens += inputTokens
  entry.outputTokens += outputTokens
  usage[model] = entry
  await saveTokenUsage(user, usage)
}

// ── config persistence ──

/** Save personal config to disk. apiKeys are written separately to secrets files
 *  only when non-empty values are provided (otherwise existing keys are kept). */
export async function savePersonalConfig(user: string, cfg: {
  default?: string
  providers?: Record<string, { model: string; baseUrl: string; apiKey?: string; maxContextTokens?: number }>
  webhookUrl?: string
}): Promise<void> {
  // Load existing config to merge
  const existing = await loadPersonalConfig(user)
  // Build the config.json content (no apiKeys)
  const providers: Record<string, Omit<ProviderConfig, "apiKey">> = {}
  if (cfg.providers) {
    for (const [name, p] of Object.entries(cfg.providers)) {
      providers[name] = {
        model: p.model,
        baseUrl: p.baseUrl,
        ...(p.maxContextTokens ? { maxContextTokens: p.maxContextTokens } : {}),
      }
      // Write apiKey to secrets file only if a non-empty value was provided
      if (p.apiKey !== undefined && p.apiKey.trim()) {
        const keyDir = dirname(personalProviderKeyPath(user, name))
        await mkdir(keyDir, { recursive: true })
        await writeFile(personalProviderKeyPath(user, name), p.apiKey.trim() + "\n")
      }
    }
  }
  const out: PersonalConfig = {
    default: cfg.default ?? existing.default,
    providers: cfg.providers !== undefined ? providers as any : existing.providers,
    ...(existing.sandbox ? { sandbox: existing.sandbox } : {}),
    webhookUrl: cfg.webhookUrl !== undefined ? cfg.webhookUrl : existing.webhookUrl,
  }
  await mkdir(personalLoopatDir(user), { recursive: true })
  await writeFile(personalLoopatConfigPath(user), JSON.stringify(out, null, 2) + "\n")
  // Clear cache for this user so next load picks up changes
  personalCache.delete(user)
}

/** Save workspace config to disk. Only provided fields are overwritten.
 *  Preserves existing apiKeys unless explicitly replaced. */
export async function saveWorkspaceConfig(cfg: Partial<WorkspaceConfig>): Promise<void> {
  const existing = await loadConfig()
  const merged: WorkspaceConfig = { ...existing }
  if (cfg.providers !== undefined) {
    merged.providers = merged.providers ?? {}
    for (const [name, p] of Object.entries(cfg.providers)) {
      const existingProv = merged.providers[name]
      const incoming = p as any
      merged.providers[name] = {
        model: incoming.model ?? existingProv?.model ?? "",
        baseUrl: incoming.baseUrl ?? existingProv?.baseUrl ?? "",
        ...(incoming.maxContextTokens ? { maxContextTokens: incoming.maxContextTokens } : {}),
        apiKey: incoming.apiKey || existingProv?.apiKey || "",
      }
    }
  }
  if (cfg.default !== undefined) merged.default = cfg.default
  if (cfg.knowledge !== undefined) merged.knowledge = cfg.knowledge
  if (cfg.notes !== undefined) merged.notes = cfg.notes
  if (cfg.repos !== undefined) merged.repos = cfg.repos
  if (cfg.serveDomain !== undefined) merged.serveDomain = cfg.serveDomain
  if (cfg.serveWithPort !== undefined) merged.serveWithPort = cfg.serveWithPort
  if (cfg.serveHttps !== undefined) merged.serveHttps = cfg.serveHttps
  if (cfg.serveDisplayPort !== undefined) merged.serveDisplayPort = cfg.serveDisplayPort
  await writeFile(configPath(), JSON.stringify(merged, null, 2) + "\n")
  cachedWorkspace = null
}
