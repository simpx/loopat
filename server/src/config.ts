import { existsSync, statSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  personalLoopatConfigPath,
  personalLoopatDir,
  personalProviderKeyPath,
  workspaceDir,
  workspaceTeamClaudeJsonPath,
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

export type TeamClaudeJson = {
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
  /** Extra binds from host into sandbox. */
  mounts?: SandboxMount[]
  /** Dirs prepended to PATH inside sandbox (after `~`/`$VAR` expansion). */
  path?: string[]
}

/**
 * Workspace config (~/.loopat/config.json): team-shared, no per-user content.
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
}

const WORKSPACE_TEMPLATE: WorkspaceConfig = {
  knowledge: { git: "git@github.com:simpx/loopat-knowledge.git" },
  notes: { git: "git@github.com:simpx/loopat-notes.git" },
  repos: [
    { name: "loopat", git: "git@github.com:simpx/loopat.git" },
  ],
}

const PERSONAL_TEMPLATE: PersonalConfig = {
  default: "anthropic",
  providers: {
    anthropic: {
      model: "claude-opus-4-7",
      baseUrl: "https://api.anthropic.com",
      apiKey: "",
    },
  },
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
  const parsed = JSON.parse(raw) as PersonalConfig
  if (!parsed.providers || typeof parsed.providers !== "object") {
    throw new Error(`${path}: malformed, missing providers`)
  }
  if (!parsed.default || !parsed.providers[parsed.default]) {
    throw new Error(`${path}: default "${parsed.default}" not in providers`)
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

export function getActiveProvider(cfg: PersonalConfig): { name: string; provider: ProviderConfig } {
  return { name: cfg.default, provider: cfg.providers[cfg.default] }
}

/**
 * Read team-shared Claude Code config from knowledge/.loopat/claude/claude.json.
 * Currently used only for mcpServers (passed through to SDK query options).
 * Missing / malformed → {} (so loops still start without team MCP servers).
 */
export async function loadTeamClaudeJson(): Promise<TeamClaudeJson> {
  const p = workspaceTeamClaudeJsonPath()
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(await readFile(p, "utf8")) as TeamClaudeJson
  } catch (e: any) {
    console.warn(`[loopat] team claude.json malformed at ${p}: ${e?.message ?? e}`)
    return {}
  }
}
