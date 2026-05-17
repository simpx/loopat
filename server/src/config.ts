import { existsSync, statSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, normalize, relative } from "node:path"
import {
  personalDir,
  personalLoopatConfigPath,
  personalLoopatDir,
  personalTokenUsagePath,
  personalVaultDir,
  workspaceDir,
  workspaceClaudeJsonPath,
} from "./paths"
import { DEFAULT_VAULT, resolveVaultRoot } from "./vaults"

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

/**
 * Reference for a config value that gets resolved at load time:
 *   - string             → literal value
 *   - { vault: "x/y" }   → read `<active-vault-root>/x/y` (rebinds per loop)
 *   - { file:  "a/b" }   → read `personal/<user>/a/b` (vault-agnostic)
 *
 * Trailing whitespace (including the conventional file-final newline) is
 * stripped; leading/interior whitespace is preserved.
 */
export type ConfigValue =
  | string
  | { vault: string }
  | { file: string }

/** On-disk shape of a provider — apiKey is a ConfigValue (or absent). */
export type ProviderConfigDisk = {
  model: string
  baseUrl: string
  apiKey?: ConfigValue
  maxContextTokens?: number
}

/** Runtime/resolved shape — apiKey is the actual string after resolution. */
export type ProviderConfig = {
  model: string
  baseUrl: string
  /** Resolved at load time from `apiKey: ConfigValue` on disk. Empty string
   *  if the reference is missing or the target file doesn't exist. */
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
 * Sandbox bind. `dst` is the sandbox-side path; must be rooted
 * (`$HOME/...`, `~/...`, or absolute `/...`). `src` semantics depend on
 * which config holds it:
 *
 * - **Operator** (`~/.dashscope/config.json` `mounts`): `src` is any host
 *   path (`~/...`, `$HOME/...`, or absolute `/...`). Operator owns the
 *   host, so we don't restrict scope.
 * - **Member** (`personal/<user>/.loopat/config.json` `mounts`): `src` MUST
 *   be relative under `personal/<user>/` (no `..`, no absolute). Encrypted
 *   dotfiles live at `.loopat/vaults/<vault>/<...>` (git-crypt covers that
 *   subtree); reference them via mounts.
 *
 * `rw` defaults to false (RO bind). Missing source is silently skipped.
 */
export type Mount = {
  src: string
  dst: string
  rw?: boolean
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
  /** Operator-level mounts — any host path. Shared across all loops on this
   *  workspace. Only the operator (the host shell user) can edit. */
  mounts?: Mount[]
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
 * each driver's personal/ tree.
 *
 * The on-disk shape stores explicit `ConfigValue` references for apiKey and
 * envs (no name-based magic). Plain string = literal, `{vault}` = vault-
 * relative (rebinds per loop's active vault), `{file}` = personal-relative
 * (vault-agnostic). At load time, references are resolved against disk and
 * exposed as plain strings (`providers[].apiKey`, `envs[K]`).
 */
export type PersonalConfigDisk = {
  default: string
  providers: Record<string, ProviderConfigDisk>
  /** Environment variables to inject into the sandbox / process env. */
  envs?: Record<string, ConfigValue>
  /** Member-level mounts — src must be personal-relative. See Mount JSDoc. */
  mounts?: Mount[]
  /** PTY shell override (highest precedence; beats sandbox.json's shell). */
  shell?: string
}

export type PersonalConfig = {
  default: string
  providers: Record<string, ProviderConfig>
  /** Resolved envs (ConfigValue → string). Missing files drop the entry. */
  envs?: Record<string, string>
  mounts?: Mount[]
  shell?: string
}

const WORKSPACE_TEMPLATE: WorkspaceConfig = {
  knowledge: { git: "" },
  notes: { git: "" },
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

// Cache key = `${user}|${vault}` so per-vault apiKey/env resolutions don't
// clobber each other.
const personalCache = new Map<string, {
  cfg: PersonalConfig
  configMtimeMs: number
  /** mtime of every file referenced (resolved) by apiKey/envs. */
  refMtimes: Record<string, number>
}>()

function clearPersonalCache(user: string): void {
  for (const k of personalCache.keys()) {
    if (k === user || k.startsWith(`${user}|`)) personalCache.delete(k)
  }
}

/** Reject `..` / absolute / drive paths under `root`. Returns the absolute
 *  resolved path on success, null if the relpath escapes. */
function safeUnder(root: string, rel: string): string | null {
  if (typeof rel !== "string" || rel.length === 0) return null
  const candidate = normalize(join(root, rel))
  const insideRel = relative(root, candidate)
  if (insideRel === "" || insideRel.startsWith("..") || insideRel.startsWith("/")) return null
  return candidate
}

/** Read a file as utf8 and strip trailing newlines only (file-final \n is
 *  the convention; trailing spaces/tabs are taken as intentional content).
 *  Leading/interior whitespace is preserved. Missing/unreadable → empty. */
async function readTrimmedEnd(path: string): Promise<{ value: string; mtimeMs: number }> {
  if (!existsSync(path)) return { value: "", mtimeMs: 0 }
  try {
    const raw = await readFile(path, "utf8")
    return { value: raw.replace(/[\r\n]+$/, ""), mtimeMs: statSync(path).mtimeMs }
  } catch {
    return { value: "", mtimeMs: 0 }
  }
}

/**
 * Resolve one ConfigValue against the active vault / user root. Returns the
 * literal value plus the path read (for cache mtime tracking). The path is
 * empty when the value is a string literal (nothing to watch).
 */
async function resolveConfigValue(
  v: ConfigValue,
  user: string,
  vault: string,
): Promise<{ value: string; path: string; mtimeMs: number }> {
  if (typeof v === "string") return { value: v, path: "", mtimeMs: 0 }
  if (v && typeof v === "object" && "vault" in v && typeof v.vault === "string") {
    const root = resolveVaultRoot(user, vault) ?? personalVaultDir(user, vault)
    const abs = safeUnder(root, v.vault)
    if (!abs) return { value: "", path: "", mtimeMs: 0 }
    const r = await readTrimmedEnd(abs)
    return { value: r.value, path: abs, mtimeMs: r.mtimeMs }
  }
  if (v && typeof v === "object" && "file" in v && typeof v.file === "string") {
    const root = personalDir(user)
    const abs = safeUnder(root, v.file)
    if (!abs) return { value: "", path: "", mtimeMs: 0 }
    const r = await readTrimmedEnd(abs)
    return { value: r.value, path: abs, mtimeMs: r.mtimeMs }
  }
  return { value: "", path: "", mtimeMs: 0 }
}

/**
 * Load personal config from personal/<user>/.loopat/config.json. Resolves
 * each provider's apiKey + every env entry against the selected vault.
 *
 * Missing config.json → in-memory empty template (do NOT lazy-write it; the
 * vault may have been intentionally deleted).
 */
export async function loadPersonalConfig(
  user: string,
  vault: string = DEFAULT_VAULT,
): Promise<PersonalConfig> {
  const path = personalLoopatConfigPath(user)
  if (!existsSync(path)) {
    return JSON.parse(JSON.stringify(PERSONAL_TEMPLATE)) as PersonalConfig
  }
  const configMtimeMs = statSync(path).mtimeMs
  const cacheKey = `${user}|${vault}`
  const cached = personalCache.get(cacheKey)
  if (cached && cached.configMtimeMs === configMtimeMs) {
    let stale = false
    for (const [p, m] of Object.entries(cached.refMtimes)) {
      const cur = existsSync(p) ? statSync(p).mtimeMs : 0
      if (cur !== m) { stale = true; break }
    }
    if (!stale) return cached.cfg
  }

  const raw = await readFile(path, "utf8")
  let disk: PersonalConfigDisk
  try {
    disk = JSON.parse(raw) as PersonalConfigDisk
    if (!disk.providers || typeof disk.providers !== "object") {
      throw new Error(`missing providers`)
    }
    if (disk.default && !disk.providers[disk.default]) {
      throw new Error(`default "${disk.default}" not in providers`)
    }
  } catch (e: any) {
    console.warn(`[loopat] personal config: ${path} is malformed (${e?.message ?? e}), rewriting template`)
    await writeFile(path, JSON.stringify(PERSONAL_TEMPLATE, null, 2) + "\n")
    disk = JSON.parse(JSON.stringify(PERSONAL_TEMPLATE)) as PersonalConfigDisk
  }

  const refMtimes: Record<string, number> = {}
  const providers: Record<string, ProviderConfig> = {}
  for (const [name, p] of Object.entries(disk.providers)) {
    let apiKey = ""
    if (p.apiKey !== undefined) {
      const r = await resolveConfigValue(p.apiKey, user, vault)
      apiKey = r.value
      if (r.path) refMtimes[r.path] = r.mtimeMs
    }
    providers[name] = {
      model: p.model,
      baseUrl: p.baseUrl,
      apiKey,
      ...(p.maxContextTokens ? { maxContextTokens: p.maxContextTokens } : {}),
    }
  }

  let envs: Record<string, string> | undefined
  if (disk.envs && typeof disk.envs === "object") {
    envs = {}
    for (const [k, v] of Object.entries(disk.envs)) {
      const r = await resolveConfigValue(v, user, vault)
      if (r.path) refMtimes[r.path] = r.mtimeMs
      // Drop empty resolutions for non-literal refs (missing file). Literal
      // empty strings, conversely, are kept — that's user intent.
      const isLiteral = typeof v === "string"
      if (isLiteral || r.value !== "") envs[k] = r.value
    }
  }

  const cfg: PersonalConfig = {
    default: disk.default ?? "",
    providers,
    ...(envs ? { envs } : {}),
    ...(disk.mounts ? { mounts: disk.mounts } : {}),
    ...(disk.shell ? { shell: disk.shell } : {}),
  }
  personalCache.set(cacheKey, { cfg, configMtimeMs, refMtimes })
  return cfg
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

/**
 * Read the raw on-disk shape (without resolving any references). Used by
 * savers that need to preserve existing apiKey/env reference structure.
 */
async function readPersonalDisk(user: string): Promise<PersonalConfigDisk> {
  const path = personalLoopatConfigPath(user)
  if (!existsSync(path)) {
    return JSON.parse(JSON.stringify(PERSONAL_TEMPLATE)) as PersonalConfigDisk
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as PersonalConfigDisk
  } catch {
    return JSON.parse(JSON.stringify(PERSONAL_TEMPLATE)) as PersonalConfigDisk
  }
}

/**
 * Resolve where to physically write a new value for a ConfigValue reference.
 * `vault` uses the default vault (settings UI is per-user, not per-vault).
 * Returns null for string-literal refs (no file to write to).
 */
function resolveWritablePath(ref: ConfigValue, user: string): string | null {
  if (typeof ref === "string") return null
  if ("vault" in ref && typeof ref.vault === "string") {
    return safeUnder(personalVaultDir(user, DEFAULT_VAULT), ref.vault)
  }
  if ("file" in ref && typeof ref.file === "string") {
    return safeUnder(personalDir(user), ref.file)
  }
  return null
}

/**
 * Save personal config to disk. Provider apiKey values are written into
 * whatever path each provider's `apiKey` reference points to (with default
 * `{ vault: "provider-keys/<name>" }` if no ref exists yet). String-literal
 * refs are updated in-place in config.json.
 */
export async function savePersonalConfig(user: string, cfg: {
  default?: string
  providers?: Record<string, { model: string; baseUrl: string; apiKey?: string; maxContextTokens?: number }>
}): Promise<void> {
  const disk = await readPersonalDisk(user)

  if (cfg.providers !== undefined) {
    const newProviders: Record<string, ProviderConfigDisk> = {}
    for (const [name, p] of Object.entries(cfg.providers)) {
      const existingRef = disk.providers?.[name]?.apiKey
      // Preserve existing reference shape; default to vault-relative if absent.
      let ref: ConfigValue = existingRef ?? { vault: `provider-keys/${name}` }
      const hasNewKey = p.apiKey !== undefined && p.apiKey.trim() !== ""
      if (hasNewKey) {
        if (typeof ref === "string") {
          // Literal: store the new value directly in config.json.
          ref = p.apiKey!.trim()
        } else {
          const writeAt = resolveWritablePath(ref, user)
          if (writeAt) {
            await mkdir(dirname(writeAt), { recursive: true })
            await writeFile(writeAt, p.apiKey!.trim() + "\n")
          }
        }
      }
      newProviders[name] = {
        model: p.model,
        baseUrl: p.baseUrl,
        apiKey: ref,
        ...(p.maxContextTokens ? { maxContextTokens: p.maxContextTokens } : {}),
      }
    }
    disk.providers = newProviders
  }
  if (cfg.default !== undefined) disk.default = cfg.default

  await mkdir(personalLoopatDir(user), { recursive: true })
  await writeFile(personalLoopatConfigPath(user), JSON.stringify(disk, null, 2) + "\n")
  clearPersonalCache(user)
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
