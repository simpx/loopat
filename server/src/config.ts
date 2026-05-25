import { existsSync, statSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  personalLoopatConfigPath,
  personalLoopatDir,
  personalTokenUsagePath,
  personalVaultDir,
  personalVaultEnvPath,
  personalVaultEnvsDir,
  workspaceDir,
  personalSettingsPath,
} from "./paths"
import { DEFAULT_VAULT, loadVaultEnvs } from "./vaults"

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

/** A model entry within a provider's model list. */
export type ModelEntry = {
  id: string
  enabled?: boolean
  /** Per-model context-window override (takes precedence over provider-level). */
  maxContextTokens?: number
}

/**
 * On-disk shape of a provider. `apiKey` is a plain string that may contain
 * `${VAR}` references resolved against vault envs at load time. Empty / unset
 * means no key (provider effectively disabled).
 */
export type ProviderConfigDisk = {
  model?: string          // legacy single-model; migrated to models[] on read
  models?: ModelEntry[]   // canonical multi-model format
  baseUrl: string
  apiKey?: string
  maxContextTokens?: number
  enabled?: boolean       // provider-level toggle, default true
}

/** Runtime/resolved shape — apiKey is the actual string after resolution. */
export type ProviderConfig = {
  /** Canonical model list (at least one entry after migration). */
  models: ModelEntry[]
  baseUrl: string
  /** Resolved at load time: `${VAR}` references in the disk apiKey are
   *  expanded against the active vault's envs/. Empty string if the
   *  referenced env doesn't exist (provider effectively disabled). */
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

/** Operator-side mount (workspace config). src is always a literal host path.
 *  Operator owns the host, so any path under `~/...`, `$HOME/...`, or `/...`
 *  is allowed (modulo `..` traversal). Used for cross-user shared caches
 *  (e.g. /etc/pki/ca-trust). */
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
 *   - `apiKey` is a plain string that may contain `${VAR}` references. At
 *     load time, each `${VAR}` is resolved against the active vault's
 *     `envs/<VAR>` file. Unset → empty string (provider effectively off).
 *   - Sandbox env vars and CLI config mounts are conventional, not declared:
 *     anything in `vault/envs/*` is auto-injected, anything in
 *     `vault/mounts/home/<rel>/...` is auto-bound at $HOME/<rel>/...
 *     There is no `envs` or `mounts` field — filesystem layout IS the spec.
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
  /** PTY shell override (highest precedence). */
  shell?: string
  /** Optional. Missing = "fresh" (user hasn't started or dismissed yet). */
  onboarding?: OnboardingState
}

export type PersonalConfig = {
  /** Active provider name. On disk this lives at `providers.default`. */
  default: string
  providers: Record<string, ProviderConfig>
  /**
   * Resolved env vars from the active vault's `envs/` dir. Filename → value.
   * Used to (a) inject into spawn env so spawned binary's `${VAR}` substitution
   * in mcpServers works, and (b) substitute `${VAR}` in provider.apiKey.
   */
  vaultEnvs: Record<string, string>
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
import { PROVIDER_PRESETS } from "./presets"

function buildPresetProviders(): Record<string, ProviderConfig> {
  return Object.fromEntries(
    PROVIDER_PRESETS.map(p => [
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
  default: PROVIDER_PRESETS[0] ? `${PROVIDER_PRESETS[0].name}/${PROVIDER_PRESETS[0].models[0]}` : "",
  providers: buildPresetProviders(),
  vaultEnvs: {},
}

/** On-disk shape used when a config.json is missing or malformed. Seeded
 *  with presets so the user has a populated model list immediately. */
const PERSONAL_DISK_TEMPLATE: PersonalConfigDisk = {
  providers: (() => {
    const providers: Record<string, ProviderConfigDisk | string> = {
      default: PROVIDER_PRESETS[0] ? `${PROVIDER_PRESETS[0].name}/${PROVIDER_PRESETS[0].models[0]}` : "",
    }
    for (const p of PROVIDER_PRESETS) {
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
  /** Snapshot of the vault envs dir mtime; if the dir changes (file added /
   *  removed / value edited) we re-resolve. We don't track per-file mtimes
   *  because vault envs are small enough to re-walk cheaply on miss. */
  envsDirMtimeMs: number
}>()

export function clearPersonalCache(user: string): void {
  for (const k of personalCache.keys()) {
    if (k === user || k.startsWith(`${user}|`)) personalCache.delete(k)
  }
}

const VAR_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** Substitute every `${VAR}` in a template against the env map. Unknown
 *  vars resolve to empty string. Literal strings (no $) pass through. */
export function expandVars(template: string, envs: Record<string, string>): string {
  if (!template || !template.includes("${")) return template
  return template.replace(VAR_REF_RE, (_, name) => envs[name] ?? "")
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
  const envsDir = personalVaultEnvsDir(user, vault)
  const envsDirMtimeMs = existsSync(envsDir) ? statSync(envsDir).mtimeMs : 0
  const cacheKey = `${user}|${vault}`
  const cached = personalCache.get(cacheKey)
  if (
    cached &&
    cached.configMtimeMs === configMtimeMs &&
    cached.envsDirMtimeMs === envsDirMtimeMs
  ) {
    return cached.cfg
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

  // Vault envs feed both the spawn env and ${VAR} substitution in apiKey.
  const vaultEnvs = await loadVaultEnvs(user, vault)

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

  const providers: Record<string, ProviderConfig> = {}
  for (const [name, p] of providerEntries) {
    let apiKey = ""
    if (typeof p.apiKey === "string") {
      apiKey = expandVars(p.apiKey, vaultEnvs)
    } else if (p.apiKey && typeof (p.apiKey as any).vault === "string") {
      // Resolve { vault: "provider-keys/DeepSeek" } format
      const vaultPath = join(personalVaultDir(user, vault), (p.apiKey as any).vault as string)
      try { apiKey = (await readFile(vaultPath, "utf8")).trim() } catch {}
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

  const cfg: PersonalConfig = {
    default: defaultProviderName && providers[defaultProviderName] ? rawDefault : "",
    providers,
    vaultEnvs,
    ...(disk.shell ? { shell: disk.shell } : {}),
    ...(disk.onboarding ? { onboarding: disk.onboarding } : {}),
  }
  personalCache.set(cacheKey, { cfg, configMtimeMs, envsDirMtimeMs })
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
 * Per-user Claude config. Same JSON shape as workspace claude.json. Personal
 * `mcpServers[<name>]` entries shadow workspace entries by name (user-tier
 * wins over admin-tier — consistent with the skill/plugin compose model).
 */
export async function loadPersonalClaudeJson(user: string): Promise<WorkspaceClaudeJson> {
  const p = personalSettingsPath(user)
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
 * For an apiKey string that may contain `${VAR}` references, describe the
 * shape so the Settings UI can render "✓ exists / ✗ missing" indicators
 * without leaking the value.
 *
 *   - "literal" : no `${VAR}` ref; value is the literal text (or empty)
 *   - "var"     : exactly one `${VAR}` ref; reports whether the vault env
 *                 file `envs/<VAR>` exists
 *   - "mixed"   : multiple refs or template+text; existence not surfaced
 */
export function describeApiKeyRef(
  apiKey: string | undefined,
  user: string,
  vault: string = DEFAULT_VAULT,
): { kind: "literal" | "var" | "mixed" | "empty"; varName?: string; path?: string; exists: boolean } {
  // Handle { vault: "..." } object format
  if (typeof apiKey !== "string") {
    if (apiKey && typeof (apiKey as any).vault === "string") {
      const vaultPath = join(personalVaultDir(user, vault), (apiKey as any).vault as string)
      return { kind: "var", varName: (apiKey as any).vault, path: vaultPath, exists: existsSync(vaultPath) }
    }
    return { kind: "empty", exists: false }
  }
  if (!apiKey) return { kind: "empty", exists: false }
  const matches = [...apiKey.matchAll(VAR_REF_RE)]
  if (matches.length === 0) return { kind: "literal", exists: true }
  if (matches.length === 1 && matches[0][0] === apiKey) {
    const name = matches[0][1]
    const path = personalVaultEnvPath(user, vault, name)
    return { kind: "var", varName: name, path, exists: existsSync(path) }
  }
  return { kind: "mixed", exists: false }
}

/**
 * Apply a structural patch to personal/<user>/.loopat/config.json. Accepts
 * partial fields from `PersonalConfigDisk`; only fields present on the
 * patch are touched. Does NOT write any secret values — apiKey values
 * referenced as `${VAR}` are managed via `writeVaultEnv()`.
 */
export async function savePersonalDisk(
  user: string,
  patch: Partial<PersonalConfigDisk>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const disk = await readPersonalDisk(user)
  if (patch.providers !== undefined) {
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
      if (p.apiKey !== undefined && typeof p.apiKey !== "string" && !(typeof p.apiKey === "object" && typeof (p.apiKey as any).vault === "string")) {
        return { ok: false, error: `provider "${name}" apiKey must be a string or { vault }` }
      }
    }
    const defName = patch.providers.default
    if (typeof defName === "string" && defName) {
      const { providerName } = parseDefault(defName)
      const exists = Object.entries(patch.providers).some(([n, v]) => n !== "default" && n === providerName && typeof v === "object")
      if (!exists) return { ok: false, error: `default "${defName}" provider "${providerName}" not in providers` }
    }
    // Force enabled: false for providers without an apiKey reference.
    for (const [name, val] of Object.entries(patch.providers)) {
      if (name === "default" || !val || typeof val !== "object") continue
      const p = val as ProviderConfigDisk
      if (p.enabled !== false) {
        const hasNewKey = (typeof p.apiKey === "string" && p.apiKey.length > 0) || (p.apiKey && typeof (p.apiKey as any).vault === "string")
        const existingEntry = disk.providers[name]
        const existingKey = (existingEntry && typeof existingEntry === "object") ? (existingEntry as ProviderConfigDisk).apiKey : undefined
        if (!hasNewKey && !existingKey) {
          p.enabled = false
        }
      }
    }
    disk.providers = patch.providers
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

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Write a value to the vault's `envs/<NAME>` file. Used when the Settings UI
 * stores a fresh apiKey / token value. Caller chooses the variable name; we
 * just validate and write. Re-reading the personal config picks up the value
 * automatically via `${VAR}` substitution.
 */
export async function writeVaultEnv(
  user: string,
  vault: string,
  name: string,
  value: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!ENV_NAME_RE.test(name)) return { ok: false, error: `invalid env name "${name}"` }
  const writeAt = personalVaultEnvPath(user, vault, name)
  await mkdir(dirname(writeAt), { recursive: true })
  await writeFile(writeAt, value.replace(/\r?\n+$/, "") + "\n")
  clearPersonalCache(user)
  return { ok: true, path: writeAt }
}

/** Delete a vault env file. No-op if missing. */
export async function deleteVaultEnv(user: string, vault: string, name: string): Promise<void> {
  if (!ENV_NAME_RE.test(name)) return
  const p = personalVaultEnvPath(user, vault, name)
  if (existsSync(p)) {
    const { rm } = await import("node:fs/promises")
    await rm(p, { force: true })
  }
  clearPersonalCache(user)
}

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
 * Save personal config to disk. Provider apiKey values are stored in vault
 * envs/<NAME>_API_KEY (NAME = uppercase provider name); config.json carries
 * a `${VAR}` reference. `default` lives at `providers.default` inside the
 * providers map.
 */
export async function savePersonalConfig(user: string, cfg: {
  default?: string
  providers?: Record<string, { model?: string; models?: ModelEntry[]; baseUrl: string; apiKey?: string; maxContextTokens?: number; enabled?: boolean }>
}): Promise<void> {
  const disk = await readPersonalDisk(user)
  const existingDefault = typeof disk.providers.default === "string" ? disk.providers.default : ""

  if (cfg.providers !== undefined) {
    const rebuilt: Record<string, ProviderConfigDisk | string> = {}
    const nextDefault = cfg.default !== undefined ? cfg.default : existingDefault
    if (nextDefault) rebuilt.default = nextDefault
    for (const [name, p] of Object.entries(cfg.providers)) {
      if (name === "default") {
        console.warn(`[loopat] savePersonalConfig: ignored provider named "default" (reserved key)`)
        continue
      }
      const existingEntry = disk.providers[name]
      const existingKey = (existingEntry && typeof existingEntry === "object") ? existingEntry.apiKey : undefined
      // Decide the apiKey field for disk:
      //   - If the user passed a new value, derive the env var name and stash
      //     the literal value into vault envs/<VAR>, then write a `${VAR}` ref.
      //   - Else keep whatever was there.
      const defaultVar = providerEnvVarName(name)
      let apiKeyField: string | undefined = existingKey
      const hasNewKey = p.apiKey !== undefined && p.apiKey.trim() !== ""
      if (hasNewKey) {
        // If existing ref is a `${VAR}` template, reuse its var name; otherwise
        // pick a deterministic default like ANTHROPIC_API_KEY for "Anthropic".
        const targetVar = (existingKey && extractSingleVarName(existingKey)) ?? defaultVar
        await writeVaultEnv(user, DEFAULT_VAULT, targetVar, p.apiKey!.trim())
        apiKeyField = `\${${targetVar}}`
      } else if (!apiKeyField) {
        // No new key, no existing key → leave field unset (provider disabled).
        apiKeyField = undefined
      }
      const models: ModelEntry[] = p.models && p.models.length > 0
        ? p.models.map(m => ({ id: m.id, ...(m.enabled === false ? { enabled: false } : {}) }))
        : (p.model ? [{ id: p.model, enabled: true }] : [])
      rebuilt[name] = {
        baseUrl: p.baseUrl,
        ...(apiKeyField !== undefined ? { apiKey: apiKeyField } : {}),
        ...(models.length > 0 ? { models } : {}),
        ...(p.maxContextTokens ? { maxContextTokens: p.maxContextTokens } : {}),
        ...(p.enabled === false ? { enabled: false } : {}),
      }
    }
    disk.providers = rebuilt
  } else if (cfg.default !== undefined) {
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

/** Derive a default vault env var name from a provider name.
 *  "Anthropic" → "ANTHROPIC_API_KEY"; "DeepSeek" → "DEEPSEEK_API_KEY". */
export function providerEnvVarName(providerName: string): string {
  const sanitized = providerName.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase()
  return `${sanitized || "PROVIDER"}_API_KEY`
}

/** If `template` is exactly `${X}` (one ref, nothing else), return X. Else null. */
function extractSingleVarName(template: string): string | null {
  const m = template.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
  return m ? m[1] : null
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
