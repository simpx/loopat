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
  personalClaudeJsonPath,
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

/** CC-native marketplace source. We support local + git + github in step 3. */
export type MarketplaceSource =
  | { source: "local"; path: string }
  | { source: "git"; url: string }
  | { source: "github"; repo: string }

export type WorkspaceClaudeJson = {
  mcpServers?: Record<string, McpServerConfig>
  /** Marketplaces to register. CC-native shape: keyed by marketplace name. */
  extraKnownMarketplaces?: Record<string, { source: MarketplaceSource }>
  /** Plugins to enable. CC-native shape: { "name@market": true }. */
  enabledPlugins?: Record<string, boolean>
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

/** A model entry within a provider's model list. */
export type ModelEntry = {
  id: string
  enabled?: boolean
  /** Per-model context-window override (takes precedence over provider-level). */
  maxContextTokens?: number
}

/** On-disk shape of a provider — apiKey is a ConfigValue (or absent). */
export type ProviderConfigDisk = {
  model?: string          // legacy single-model; migrated to models[] on read
  models?: ModelEntry[]   // canonical multi-model format
  baseUrl: string
  apiKey?: ConfigValue
  maxContextTokens?: number
  enabled?: boolean       // provider-level toggle, default true
}

/** Runtime/resolved shape — apiKey is the actual string after resolution. */
export type ProviderConfig = {
  /** Canonical model list (at least one entry after migration). */
  models: ModelEntry[]
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
  enabled: boolean
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
 * Reference to a host path. Sister to `ConfigValue` but for paths:
 *   - string             → personal-relative (existing behavior)
 *   - { vault: "x/y" }   → active-vault-relative (rebinds per loop)
 *
 * Asymmetric with ConfigValue on purpose: a path's bare-string form has
 * always meant "personal-relative", so there's no `{file}` variant.
 */
export type PathRef = string | { vault: string }

/**
 * Sandbox bind. `dst` is the sandbox-side path; must be rooted
 * (`$HOME/...`, `~/...`, or absolute `/...`). `src` semantics depend on
 * which config holds it:
 *
 * - **Operator** (`~/.loopat/config.json` `mounts`): `src` is any host
 *   path (`~/...`, `$HOME/...`, or absolute `/...`). Operator owns the
 *   host, so we don't restrict scope. (Always a string — no PathRef.)
 * - **Member** (`personal/<user>/.loopat/config.json` `mounts`): `src` is
 *   a `PathRef`. Bare string → relative under `personal/<user>/`.
 *   `{ vault: "..." }` → relative under the loop's active vault root.
 *
 * `rw` defaults to false (RO bind). Missing source is silently skipped.
 */
export type Mount = {
  src: PathRef
  dst: string
  rw?: boolean
}

/** Operator-side mount (workspace config). src is always a literal host path. */
export type OperatorMount = {
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
  mounts?: OperatorMount[]
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
 * On-disk layout:
 *   - `providers` is a heterogeneous map: a special key `"default"` carries
 *     a string (the active provider name); all other keys map to
 *     `ProviderConfigDisk`. We accept the slight type wobble in exchange
 *     for keeping every provider-related field under one section, which
 *     matches how the Settings UI groups them. No provider is allowed to
 *     be literally named "default".
 *   - `apiKey` / `envs` values are `ConfigValue` references; resolved on
 *     load and exposed as plain strings via the runtime `PersonalConfig`.
 *   - `mounts[].src` is `PathRef` (string = personal-relative,
 *     `{vault}` = active-vault-relative).
 */
/**
 * Onboarding state per user. Used by the Welcome card on Loops list to
 * decide whether to show "start onboarding" / "continue" / nothing.
 *
 *   - `started`: a loop was spawned, but the user hasn't marked finished
 *     (`loopId` points at the in-progress onboarding loop).
 *   - `done`: user clicked skip/complete OR finished naturally. Card hides.
 */
export type OnboardingState = {
  status: "started" | "done"
  loopId?: string
  at: string
}

export type PersonalConfigDisk = {
  /** Mixed: "default" key is a string, all other keys are providers. */
  providers: Record<string, ProviderConfigDisk | string>
  /** Environment variables to inject into the sandbox / process env. */
  envs?: Record<string, ConfigValue>
  /** Member-level mounts — src is `PathRef`. See Mount JSDoc. */
  mounts?: Mount[]
  /** PTY shell override (highest precedence; beats sandbox.json's shell). */
  shell?: string
  /** Optional. Missing = "fresh" (user hasn't started or dismissed yet). */
  onboarding?: OnboardingState
}

export type PersonalConfig = {
  /** Active provider name. On disk this lives at `providers.default`. */
  default: string
  providers: Record<string, ProviderConfig>
  /** Resolved envs (ConfigValue → string). Missing files drop the entry. */
  envs?: Record<string, string>
  mounts?: Mount[]
  shell?: string
  onboarding?: OnboardingState
}

/**
 * Parse a default selector string. Supports two formats:
 *   - "providerName/modelId" (new) → { providerName, modelId }
 *   - "providerName" (legacy)    → { providerName }
 * Backward-compatible: if no "/" is present, the whole string is the provider name.
 */
export function parseDefault(raw: string): { providerName: string; modelId?: string } {
  if (!raw) return { providerName: "" }
  const slashIdx = raw.indexOf("/")
  if (slashIdx <= 0) return { providerName: raw }
  return {
    providerName: raw.slice(0, slashIdx),
    modelId: raw.slice(slashIdx + 1) || undefined,
  }
}

/** Preset providers with Anthropic-compatible endpoints. loopat uses the
 *  Claude Agent SDK which speaks the Anthropic Messages API — only providers
 *  that expose an Anthropic-compatible endpoint work directly.
 *  Each provider is disabled by default; the user supplies an API key. */
const PRESET_PROVIDERS: Array<{ name: string; baseUrl: string; models: string[] }> = [
  { name: "Anthropic", baseUrl: "https://api.anthropic.com",
    models: ["claude-sonnet-4-20250514", "claude-opus-4-7-20251101"] },
  { name: "DeepSeek",  baseUrl: "https://api.deepseek.com/anthropic",
    models: ["deepseek-v4-pro", "deepseek-v4-flash"] },
  { name: "Kimi",      baseUrl: "https://api.moonshot.cn/anthropic",
    models: ["kimi-k2.6"] },
  { name: "MiniMax",   baseUrl: "https://api.minimaxi.com/anthropic",
    models: ["MiniMax-M2.7"] },
]

function buildPresetProviders(): Record<string, ProviderConfig> {
  return Object.fromEntries(
    PRESET_PROVIDERS.map(p => [
      p.name,
      {
        models: p.models.map(id => ({ id, enabled: true })),
        baseUrl: p.baseUrl,
        apiKey: "",
        enabled: false,
      } satisfies ProviderConfig,
    ]),
  )
}

const WORKSPACE_TEMPLATE: WorkspaceConfig = {
  knowledge: { git: "" },
  notes: { git: "" },
  repos: [
    { name: "loopat", git: "git@github.com:simpx/loopat.git" },
  ],
  providers: buildPresetProviders(),
}

const PERSONAL_TEMPLATE: PersonalConfig = {
  default: PRESET_PROVIDERS[0] ? `${PRESET_PROVIDERS[0].name}/${PRESET_PROVIDERS[0].models[0]}` : "",
  providers: buildPresetProviders(),
}

/** On-disk shape used when a config.json is missing or malformed. Seeded
 *  with presets so the user has a populated model list immediately. */
const PERSONAL_DISK_TEMPLATE: PersonalConfigDisk = {
  providers: (() => {
    const providers: Record<string, ProviderConfigDisk | string> = {
      default: PRESET_PROVIDERS[0] ? `${PRESET_PROVIDERS[0].name}/${PRESET_PROVIDERS[0].models[0]}` : "",
    }
    for (const p of PRESET_PROVIDERS) {
      providers[p.name] = {
        models: p.models.map(id => ({ id, enabled: true })),
        baseUrl: p.baseUrl,
        enabled: false,
      }
    }
    return providers
  })(),
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
  // Normalize legacy single-model providers to canonical models[] format.
  if (parsed.providers) {
    for (const [name, p] of Object.entries(parsed.providers)) {
      const disk = p as any
      if (!disk.models && disk.model) {
        ;(p as any).models = [{ id: disk.model, enabled: true }]
      }
      if (p.enabled === undefined) (p as any).enabled = true
    }
  }
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
  } catch (e: any) {
    console.warn(`[loopat] personal config: ${path} is malformed (${e?.message ?? e}), rewriting template`)
    await writeFile(path, JSON.stringify(PERSONAL_DISK_TEMPLATE, null, 2) + "\n")
    disk = JSON.parse(JSON.stringify(PERSONAL_DISK_TEMPLATE)) as PersonalConfigDisk
  }

  // Split the heterogeneous providers map: pull out the special "default"
  // string key, leave the rest as provider entries.
  const rawDefault = typeof disk.providers.default === "string" ? disk.providers.default : ""
  const { providerName: defaultProviderName } = parseDefault(rawDefault)
  const providerEntries: Array<[string, ProviderConfigDisk]> = []
  for (const [name, val] of Object.entries(disk.providers)) {
    if (name === "default") continue
    if (val && typeof val === "object") providerEntries.push([name, val as ProviderConfigDisk])
  }
  if (defaultProviderName && !providerEntries.some(([n]) => n === defaultProviderName)) {
    console.warn(`[loopat] personal config: default "${rawDefault}" provider "${defaultProviderName}" not in providers (ignored)`)
  }

  const refMtimes: Record<string, number> = {}
  const providers: Record<string, ProviderConfig> = {}
  for (const [name, p] of providerEntries) {
    let apiKey = ""
    if (p.apiKey !== undefined) {
      const r = await resolveConfigValue(p.apiKey, user, vault)
      apiKey = r.value
      if (r.path) refMtimes[r.path] = r.mtimeMs
    }
    // Normalize legacy single-model to canonical models[] format.
    const models: ModelEntry[] = p.models && p.models.length > 0
      ? p.models.map(m => ({ id: m.id, enabled: m.enabled !== false }))
      : (p.model ? [{ id: p.model, enabled: true }] : [])
    providers[name] = {
      models,
      baseUrl: p.baseUrl,
      apiKey,
      enabled: p.enabled !== false,
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
    default: defaultProviderName && providers[defaultProviderName] ? rawDefault : "",
    providers,
    ...(envs ? { envs } : {}),
    ...(disk.mounts ? { mounts: disk.mounts } : {}),
    ...(disk.shell ? { shell: disk.shell } : {}),
    ...(disk.onboarding ? { onboarding: disk.onboarding } : {}),
  }
  personalCache.set(cacheKey, { cfg, configMtimeMs, refMtimes })
  return cfg
}

export function getActiveProvider(cfg: PersonalConfig): { name: string; provider: ProviderConfig } | null {
  const raw = cfg.default
  if (!raw) return null
  const { providerName } = parseDefault(raw)
  if (!providerName || !cfg.providers[providerName]) return null
  return { name: providerName, provider: cfg.providers[providerName] }
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

/**
 * Per-user Claude config. Same JSON shape as workspace claude.json. Personal
 * `mcpServers[<name>]` entries shadow workspace entries by name (user-tier
 * wins over admin-tier — consistent with the skill/plugin compose model).
 */
export async function loadPersonalClaudeJson(user: string): Promise<WorkspaceClaudeJson> {
  const p = personalClaudeJsonPath(user)
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(await readFile(p, "utf8")) as WorkspaceClaudeJson
  } catch (e: any) {
    console.warn(`[loopat] personal claude.json malformed at ${p}: ${e?.message ?? e}`)
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
export async function readPersonalDiskRaw(user: string): Promise<PersonalConfigDisk> {
  return readPersonalDisk(user)
}

/**
 * For a ConfigValue ref, return the absolute path it points to (or null for
 * literals) plus whether that path exists on disk. Used by the Settings API
 * to surface "ref ✓ exists / ✗ missing" indicators WITHOUT leaking the
 * resolved value to the client.
 */
export function describeConfigValue(v: ConfigValue, user: string, vault: string = DEFAULT_VAULT): { kind: "literal" | "vault" | "file" | "invalid"; path: string | null; exists: boolean } {
  if (typeof v === "string") return { kind: "literal", path: null, exists: true }
  if (v && typeof v === "object" && "vault" in v && typeof v.vault === "string") {
    const root = resolveVaultRoot(user, vault) ?? personalVaultDir(user, vault)
    const abs = safeUnder(root, v.vault)
    if (!abs) return { kind: "invalid", path: null, exists: false }
    return { kind: "vault", path: abs, exists: existsSync(abs) }
  }
  if (v && typeof v === "object" && "file" in v && typeof v.file === "string") {
    const abs = safeUnder(personalDir(user), v.file)
    if (!abs) return { kind: "invalid", path: null, exists: false }
    return { kind: "file", path: abs, exists: existsSync(abs) }
  }
  return { kind: "invalid", path: null, exists: false }
}

/**
 * Apply a structural patch to personal/<user>/.loopat/config.json. Accepts
 * partial fields from `PersonalConfigDisk`; only fields present on the
 * patch are touched. Does NOT write any secret values — apiKey/env file
 * contents are managed through separate value-write endpoints.
 *
 * Validation:
 *   - No provider entry may be named "default" (reserved selector key).
 *   - If `providers.default` is set, it must point to an existing provider.
 *   - Each mount's `dst` and `src` (PathRef) must validate.
 *   - Each env value must be a valid ConfigValue shape.
 */
export async function savePersonalDisk(
  user: string,
  patch: Partial<PersonalConfigDisk>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const disk = await readPersonalDisk(user)
  if (patch.providers !== undefined) {
    // Validate providers map shape: "default" → string, others → object with model/baseUrl.
    for (const [name, val] of Object.entries(patch.providers)) {
      if (name === "default") {
        if (typeof val !== "string") return { ok: false, error: `providers.default must be a string` }
        continue
      }
      if (!val || typeof val !== "object" || Array.isArray(val)) {
        return { ok: false, error: `provider "${name}" must be an object` }
      }
      const p = val as ProviderConfigDisk
      const hasModels = Array.isArray(p.models) && p.models.length > 0
      const hasModel = typeof p.model === "string"
      if (!hasModels && !hasModel) {
        return { ok: false, error: `provider "${name}" missing models (or legacy model)` }
      }
      if (typeof p.baseUrl !== "string") {
        return { ok: false, error: `provider "${name}" missing baseUrl` }
      }
      if (p.apiKey !== undefined && !isValidConfigValueShape(p.apiKey)) {
        return { ok: false, error: `provider "${name}" apiKey has invalid shape` }
      }
    }
    // Default must point to a real provider (if set).
    const defName = patch.providers.default
    if (typeof defName === "string" && defName) {
      const { providerName } = parseDefault(defName)
      const exists = Object.entries(patch.providers).some(([n, v]) => n !== "default" && n === providerName && typeof v === "object")
      if (!exists) return { ok: false, error: `default "${defName}" provider "${providerName}" not in providers` }
    }
    // Force enabled: false for providers without an API key.
    for (const [name, val] of Object.entries(patch.providers)) {
      if (name === "default" || !val || typeof val !== "object") continue
      const p = val as ProviderConfigDisk
      if (p.enabled !== false) {
        const hasNewKey = p.apiKey !== undefined && isValidConfigValueShape(p.apiKey)
        const existingEntry = disk.providers[name]
        const existingRef = (existingEntry && typeof existingEntry === "object") ? (existingEntry as ProviderConfigDisk).apiKey : undefined
        if (!hasNewKey && !existingRef) {
          p.enabled = false
        }
      }
    }
    disk.providers = patch.providers
  }
  if (patch.envs !== undefined) {
    if (patch.envs && typeof patch.envs === "object") {
      for (const [k, v] of Object.entries(patch.envs)) {
        if (!isValidEnvKey(k)) return { ok: false, error: `invalid env key "${k}"` }
        if (!isValidConfigValueShape(v)) return { ok: false, error: `env "${k}" has invalid value shape` }
      }
    }
    disk.envs = patch.envs
  }
  if (patch.mounts !== undefined) {
    if (!Array.isArray(patch.mounts)) return { ok: false, error: `mounts must be an array` }
    for (const m of patch.mounts) {
      if (!m || typeof m !== "object") return { ok: false, error: `mounts entry must be an object` }
      if (typeof m.dst !== "string" || !isValidMountDstShape(m.dst)) return { ok: false, error: `invalid mount dst: ${JSON.stringify(m.dst)}` }
      if (!isValidPathRefShape(m.src)) return { ok: false, error: `invalid mount src: ${JSON.stringify(m.src)}` }
    }
    disk.mounts = patch.mounts
  }
  if (patch.shell !== undefined) {
    if (typeof patch.shell !== "string") return { ok: false, error: `shell must be a string` }
    disk.shell = patch.shell || undefined
  }

  await mkdir(personalLoopatDir(user), { recursive: true })
  await writeFile(personalLoopatConfigPath(user), JSON.stringify(disk, null, 2) + "\n")
  clearPersonalCache(user)
  return { ok: true }
}

/**
 * Write a literal value to the target a ConfigValue ref points to. Useful
 * for "user typed a new apiKey/env value, route it to wherever the ref
 * says". Literal-string refs aren't writable (the value IS the ref); the
 * caller is expected to update config.json directly via savePersonalDisk.
 */
export async function writeConfigValueTarget(
  ref: ConfigValue,
  user: string,
  value: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (typeof ref === "string") return { ok: false, error: "literal ref has no writable target" }
  const writeAt = resolveWritablePath(ref, user)
  if (!writeAt) return { ok: false, error: "invalid ref path" }
  await mkdir(dirname(writeAt), { recursive: true })
  // Match the file-final newline convention so the trim-only-trailing-newline
  // read path produces the value verbatim.
  await writeFile(writeAt, value.replace(/\r?\n+$/, "") + "\n")
  clearPersonalCache(user)
  return { ok: true, path: writeAt }
}

function isValidConfigValueShape(v: unknown): v is ConfigValue {
  if (typeof v === "string") return true
  if (!v || typeof v !== "object") return false
  if ("vault" in v && typeof (v as any).vault === "string") return true
  if ("file"  in v && typeof (v as any).file  === "string") return true
  return false
}

function isValidPathRefShape(v: unknown): v is PathRef {
  if (typeof v === "string") return v.length > 0 && !v.startsWith("/")
  if (!v || typeof v !== "object") return false
  if ("vault" in v && typeof (v as any).vault === "string") return (v as any).vault.length > 0
  return false
}

function isValidMountDstShape(s: string): boolean {
  if (!s) return false
  return s === "~" || s === "$HOME" || s.startsWith("~/") || s.startsWith("$HOME/") || s.startsWith("/")
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
function isValidEnvKey(k: string): boolean { return typeof k === "string" && ENV_KEY_RE.test(k) }

async function readPersonalDisk(user: string): Promise<PersonalConfigDisk> {
  const path = personalLoopatConfigPath(user)
  if (!existsSync(path)) {
    return JSON.parse(JSON.stringify(PERSONAL_DISK_TEMPLATE)) as PersonalConfigDisk
  }
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as PersonalConfigDisk
    if (!parsed.providers || typeof parsed.providers !== "object") parsed.providers = {}
    return parsed
  } catch {
    return JSON.parse(JSON.stringify(PERSONAL_DISK_TEMPLATE)) as PersonalConfigDisk
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
 * refs are updated in-place in config.json. `default` is now stored at
 * `providers.default` inside the providers map.
 */
export async function savePersonalConfig(user: string, cfg: {
  default?: string
  providers?: Record<string, { model?: string; models?: ModelEntry[]; baseUrl: string; apiKey?: string; maxContextTokens?: number; enabled?: boolean }>
}): Promise<void> {
  const disk = await readPersonalDisk(user)

  // Read existing default (string at providers.default) and existing provider
  // entries (everything else under providers) — they round-trip when only one
  // of {default, providers} is being updated.
  const existingDefault = typeof disk.providers.default === "string" ? disk.providers.default : ""

  if (cfg.providers !== undefined) {
    const rebuilt: Record<string, ProviderConfigDisk | string> = {}
    const nextDefault = cfg.default !== undefined ? cfg.default : existingDefault
    if (nextDefault) rebuilt.default = nextDefault   // emit FIRST for readability
    for (const [name, p] of Object.entries(cfg.providers)) {
      if (name === "default") {
        // Defensive: a literal provider named "default" collides with the
        // selector key. Refuse and warn — UI should already prevent this.
        console.warn(`[loopat] savePersonalConfig: ignored provider named "default" (reserved key)`)
        continue
      }
      const existingEntry = disk.providers[name]
      const existingRef = (existingEntry && typeof existingEntry === "object") ? existingEntry.apiKey : undefined
      let ref: ConfigValue = existingRef ?? { vault: `provider-keys/${name}` }
      const hasNewKey = p.apiKey !== undefined && p.apiKey.trim() !== ""
      if (hasNewKey) {
        if (typeof ref === "string") {
          ref = p.apiKey!.trim()
        } else {
          const writeAt = resolveWritablePath(ref, user)
          if (writeAt) {
            await mkdir(dirname(writeAt), { recursive: true })
            await writeFile(writeAt, p.apiKey!.trim() + "\n")
          }
        }
      }
      // Normalize to canonical models[] format.
      const models: ModelEntry[] = p.models && p.models.length > 0
        ? p.models.map(m => ({ id: m.id, ...(m.enabled === false ? { enabled: false } : {}) }))
        : (p.model ? [{ id: p.model, enabled: true }] : [])
      rebuilt[name] = {
        baseUrl: p.baseUrl,
        apiKey: ref,
        ...(models.length > 0 ? { models } : {}),
        ...(p.maxContextTokens ? { maxContextTokens: p.maxContextTokens } : {}),
        ...(p.enabled === false ? { enabled: false } : {}),
      }
    }
    disk.providers = rebuilt
  } else if (cfg.default !== undefined) {
    // Only updating the default selector — leave provider entries untouched
    // but rebuild the map so "default" stays first for readability.
    const rebuilt: Record<string, ProviderConfigDisk | string> = {}
    if (cfg.default) rebuilt.default = cfg.default
    for (const [name, val] of Object.entries(disk.providers)) {
      if (name === "default") continue
      rebuilt[name] = val
    }
    disk.providers = rebuilt
  }

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
      // Normalize to canonical models[] format.
      const models: ModelEntry[] = incoming.models?.length > 0
        ? incoming.models.map((m: any) => ({ id: m.id, ...(m.enabled === false ? { enabled: false } : {}) }))
        : existingProv?.models ?? (incoming.model ? [{ id: incoming.model, enabled: true }] : [])
      merged.providers[name] = {
        models,
        baseUrl: incoming.baseUrl ?? existingProv?.baseUrl ?? "",
        ...(incoming.maxContextTokens ? { maxContextTokens: incoming.maxContextTokens } : {}),
        apiKey: incoming.apiKey || existingProv?.apiKey || "",
        enabled: incoming.enabled !== undefined ? incoming.enabled : (existingProv?.enabled ?? true),
      } as any
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
