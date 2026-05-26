/**
 * Full-screen Settings page — the UX-friendly editor for
 * `personal/<user>/.loopat/config.json`. Sections: Providers, Shell, MCP,
 * Personal Repo. Env vars and home mounts are no longer declared here —
 * they're conventional, derived from `vaults/<v>/envs/*` and
 * `vaults/<v>/mounts/home/*` filesystem layout.
 *
 * Gating: everything except Personal Repo is grayed out until the user
 * has both `personalRepo` set AND `imported: true` (per /api/personal/status).
 * The Personal Repo section embeds the existing PersonalRepoPanel so users
 * can complete setup in place.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react"
import { useNavigate, useParams } from "react-router-dom"
import {
  getPersonalStatus,
  getPersonalDisk,
  savePersonalDisk,
  writeVaultEnv,
  testProviderConnection,
  listApiTokens,
  createApiToken,
  revokeApiToken,
  listMyAccounts,
  createMyAccount,
  deleteMyAccount,
  type PersonalConfigDisk,
  type ProviderDisk,
  type RefExistsMap,
  type ModelEntry,
  type ApiTokenEntry,
  type PublicAccount,
} from "../api"
import { PersonalRepoPanel } from "../components/dialog/PersonalRepoPanel"
import { UsersPanel, WorkspacePanel as AdminWorkspacePanel, ServePanel } from "../components/dialog/AdminDialog"
import { ClaudeConfigPanel } from "../components/settings/ClaudeConfigPanel"
import { MiseConfigPanel } from "../components/settings/MiseConfigPanel"
import { TokenUsagePage } from "./TokenUsagePage"
import { useWorkspace } from "@/ctx"
import { ArrowLeft, Plus, Trash2, RefreshCw, Check, AlertCircle, Lock, FileCode2, Search, User, Cpu, Terminal, Layers, BarChart3, Users, Globe, Share2, KeyRound, Copy, Wrench } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

const inputClass = "w-full px-2.5 py-1.5 border border-gray-300 rounded text-[13px] outline-none bg-white focus:border-gray-900 focus:ring-1 focus:ring-gray-900 transition-colors disabled:bg-gray-50 disabled:text-gray-400"
const inputClassSm = "w-full px-2 py-1 border border-gray-300 rounded text-[11px] outline-none bg-white focus:border-gray-900 focus:ring-1 focus:ring-gray-900 transition-colors"

/** Mirror of server `providerEnvVarName` — keep the two in sync.
 *  "Anthropic" → "ANTHROPIC_API_KEY"; "DeepSeek" → "DEEPSEEK_API_KEY". */
function providerEnvVarName(providerName: string): string {
  const sanitized = providerName.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase()
  return `${sanitized || "PROVIDER"}_API_KEY`
}

type TabId = "personal-repo" | "providers" | "shell" | "claude-config" | "mise-config" | "token-usage" | "api-tokens" | "accounts" | "admin-users" | "admin-workspace" | "admin-serve"

const TABS: { id: TabId; label: string; gated: boolean; description: string; icon: typeof User }[] = [
  { id: "personal-repo", label: "Personal Repo",          gated: false, description: "Your private repo carrying credentials + dotfiles.", icon: User },
  { id: "providers",     label: "AI Providers",           gated: true,  description: "Models, base URLs, API keys. Pick a default.",     icon: Cpu },
  { id: "shell",         label: "Terminal Shell",         gated: true,  description: "PTY shell binary used in loop terminals.",         icon: Terminal },
  { id: "claude-config", label: "Claude Config",          gated: true,  description: "Compose your .claude/ tiers — plugins, MCP servers, settings per tier.", icon: Layers },
  { id: "mise-config",   label: "Mise Config",            gated: true,  description: "Configure mise toolchain tools per tier — mise.toml for each tier.", icon: Wrench },
  { id: "token-usage",   label: "Token Usage",            gated: false, description: "Token consumption across models, loops, and time.",icon: BarChart3 },
  { id: "api-tokens",     label: "API Tokens",            gated: false, description: "Bearer tokens for external programs to drive your loops via the Loop API. See API docs below.", icon: KeyRound },
  { id: "accounts",       label: "Accounts",              gated: false, description: "Additional accounts you own (API-only — no password login). Each one has its own vault, .claude config, loops, and tokens.", icon: User },
  { id: "admin-users",    label: "Users",                 gated: false, description: "Manage workspace members — activate, promote, remove.", icon: Users },
  { id: "admin-workspace",label: "Workspace AI Providers", gated: false, description: "Shared workspace provider configuration.", icon: Globe },
  { id: "admin-serve",    label: "Share Artifact Serve",   gated: false, description: "Public share domain and HTTPS settings.",   icon: Share2 },
]

// ────────────────────────────────────────────────────────────────────────────
// Page shell
// ────────────────────────────────────────────────────────────────────────────

export function SettingsPage() {
  const navigate = useNavigate()
  const ws = useWorkspace()
  const isAdmin = ws.currentUser?.role === "admin"
  const { tab } = useParams<{ tab: string }>()
  const active = (TABS.some((t) => t.id === tab) ? tab : "personal-repo") as TabId

  const [loading, setLoading] = useState(true)
  const [statusReady, setStatusReady] = useState(false)
  const [statusReason, setStatusReason] = useState<string>("")
  const [disk, setDisk] = useState<PersonalConfigDisk | null>(null)
  const [refExists, setRefExists] = useState<RefExistsMap>({})

  const refresh = useCallback(async () => {
    setLoading(true)
    const [status, diskRes] = await Promise.all([getPersonalStatus(), getPersonalDisk()])
    const ready = !!status && !!status.personalRepo && status.imported
    setStatusReady(ready)
    setStatusReason(
      !status || !status.personalRepo
        ? "no personal repo configured"
        : !status.imported
          ? "personal repo not imported yet"
          : "",
    )
    if (diskRes) {
      setDisk(diskRes.disk)
      setRefExists(diskRes.refExists)
    }
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // If the active tab is gated and personal repo isn't ready, bounce to the
  // personal-repo tab so users see the unlock path instead of a dead pane.
  useEffect(() => {
    if (!loading && !statusReady && TABS.find((t) => t.id === active)?.gated && !active.startsWith("admin-")) {
      navigate(`/settings/personal-repo`, { replace: true })
    }
  }, [loading, statusReady, active, navigate])

  const activeMeta = TABS.find((t) => t.id === active) ?? TABS[0]
  const isGatedAndLocked = activeMeta.gated && !statusReady && !active.startsWith("admin-")

  const [search, setSearch] = useState("")
  const visibleTabs = TABS.filter((t) => {
    if (t.id.startsWith("admin-") && !isAdmin) return false
    return true
  })
  const regularTabs = visibleTabs.filter((t) => !t.id.startsWith("admin-"))
  const adminTabs = visibleTabs.filter((t) => t.id.startsWith("admin-"))

  const filteredTabs = search.trim() === ""
    ? visibleTabs
    : visibleTabs.filter((t) =>
        t.label.toLowerCase().includes(search.toLowerCase()) ||
        t.description.toLowerCase().includes(search.toLowerCase()) ||
        t.id.toLowerCase().includes(search.toLowerCase()),
      )

  return (
    <div className="h-full overflow-hidden bg-gray-50 flex flex-col">
      <header className="shrink-0 border-b border-gray-200 bg-white px-4 sm:px-6 h-12 flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="w-8 h-8 flex items-center justify-center rounded text-gray-500 hover:text-gray-900 hover:bg-gray-100"
          title="back"
        >
          <ArrowLeft size={16} />
        </button>
        <h1 className="text-[15px] font-semibold text-gray-900">Settings</h1>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => navigate("/context/personal?file=.loopat/config.json&edit=1")}
          className="h-7 px-2.5 rounded text-xs border border-gray-200 hover:bg-gray-100 text-gray-700 flex items-center gap-1.5"
          title="open raw config.json in Context tab"
        >
          <FileCode2 size={12} />
          <span className="hidden sm:inline">edit raw config.json</span>
        </button>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="h-7 px-2.5 rounded text-xs border border-gray-200 hover:bg-gray-100 text-gray-700 flex items-center gap-1.5 disabled:opacity-50"
          title="reload"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          <span className="hidden sm:inline">reload</span>
        </button>
      </header>

      <div className="flex-1 min-h-0 flex flex-col sm:flex-row">
        {/* tab nav: horizontal on mobile, vertical sidebar on desktop */}
        <nav className="sm:w-56 shrink-0 sm:border-r border-b sm:border-b-0 border-gray-200 bg-white flex flex-col">
          {/* search */}
          <div className="hidden sm:block px-3 py-3 border-b border-gray-100">
            <div className="relative">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="search settings"
                className="w-full pl-7 pr-2 py-1.5 text-[12px] border border-gray-200 rounded outline-none focus:border-gray-400 bg-gray-50 focus:bg-white"
              />
            </div>
          </div>
          <ul className="flex sm:flex-col gap-0.5 sm:gap-0 p-2 sm:py-2 overflow-x-auto sm:overflow-x-visible">
            {search.trim()
              ? filteredTabs.map((t) => {
                  const isActive = t.id === active
                  const locked = t.gated && !loading && !statusReady
                  return (
                    <li key={t.id} className="shrink-0 sm:px-1">
                      <button
                        type="button"
                        onClick={() => navigate(`/settings/${t.id}`)}
                        className={
                          "w-full text-left px-2.5 py-1.5 rounded text-[13px] flex items-center gap-2 transition-colors whitespace-nowrap " +
                          (isActive ? "bg-gray-100 text-gray-900 font-medium" : "text-gray-600 hover:bg-gray-50 hover:text-gray-900")
                        }
                      >
                        <t.icon size={14} className={`shrink-0 ${isActive ? "text-gray-600" : "text-gray-400"}`} />
                        <span className="flex-1 truncate">{t.label}</span>
                        {locked && <span title="locked"><Lock size={11} className="text-gray-400 shrink-0" /></span>}
                      </button>
                    </li>
                  )
                })
              : (
                <>
                  {regularTabs.map((t) => {
                    const isActive = t.id === active
                    const locked = t.gated && !loading && !statusReady
                    return (
                      <li key={t.id} className="shrink-0 sm:px-1">
                        <button
                          type="button"
                          onClick={() => navigate(`/settings/${t.id}`)}
                          className={
                            "w-full text-left px-2.5 py-1.5 rounded text-[13px] flex items-center gap-2 transition-colors whitespace-nowrap " +
                            (isActive ? "bg-gray-100 text-gray-900 font-medium" : "text-gray-600 hover:bg-gray-50 hover:text-gray-900")
                          }
                        >
                          <t.icon size={14} className={`shrink-0 ${isActive ? "text-gray-600" : "text-gray-400"}`} />
                          <span className="flex-1 truncate">{t.label}</span>
                          {locked && <span title="locked"><Lock size={11} className="text-gray-400 shrink-0" /></span>}
                        </button>
                      </li>
                    )
                  })}
                  {adminTabs.length > 0 && (
                    <>
                      <li className="px-3 pt-3 pb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                        Admin Settings
                      </li>
                      {adminTabs.map((t) => {
                        const isActive = t.id === active
                        return (
                          <li key={t.id} className="shrink-0 sm:px-1">
                            <button
                              type="button"
                              onClick={() => navigate(`/settings/${t.id}`)}
                              className={
                                "w-full text-left px-2.5 py-1.5 rounded text-[13px] flex items-center gap-2 transition-colors whitespace-nowrap " +
                                (isActive ? "bg-gray-100 text-gray-900 font-medium" : "text-gray-600 hover:bg-gray-50 hover:text-gray-900")
                              }
                            >
                              <t.icon size={14} className={`shrink-0 ${isActive ? "text-gray-600" : "text-gray-400"}`} />
                              <span className="flex-1 truncate">{t.label}</span>
                            </button>
                          </li>
                        )
                      })}
                    </>
                  )}
                </>
              )
            }
            {filteredTabs.length === 0 && (
              <li className="px-3 py-2 text-[11px] text-gray-400 italic">no match</li>
            )}
          </ul>
        </nav>

        {/* tab content */}
        <main className="flex-1 min-w-0 min-h-0 overflow-auto">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 py-5">
            {loading && !disk ? (
              <div className="text-[13px] text-gray-400 italic py-12 text-center">loading…</div>
            ) : (
              <>
                <div className="mb-4">
                  <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                    <activeMeta.icon size={18} className="text-gray-400" />
                    {activeMeta.label}
                  </h2>
                  <p className="text-xs text-gray-500 mt-0.5">{activeMeta.description}</p>
                </div>

                {isGatedAndLocked && (
                  <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-2">
                    <AlertCircle size={16} className="text-amber-700 mt-0.5 shrink-0" />
                    <div className="text-[13px] text-amber-900 flex-1">
                      <div className="font-medium">Set up your personal repo first</div>
                      <div className="text-[12px] text-amber-800/90 mt-0.5">
                        These settings live in your personal repo. Complete setup in
                        the <button onClick={() => navigate("/settings/personal-repo")} className="underline">Personal Repo</button> tab; this section will unlock automatically.
                        <span className="text-amber-700/70"> ({statusReason})</span>
                      </div>
                    </div>
                  </div>
                )}

                <div className="relative">
                  {isGatedAndLocked && (
                    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-white/60 backdrop-blur-[1px] rounded-lg">
                      <Lock size={24} className="text-gray-300" />
                      <span className="text-[13px] text-gray-500 font-medium">Set up your personal repo first</span>
                    </div>
                  )}
                  <div className={isGatedAndLocked ? "opacity-30" : ""}>
                  {active === "personal-repo" && (
                    <div className="rounded-lg border border-gray-200 bg-white p-5"><PersonalRepoPanel onDone={refresh} /></div>
                  )}
                  {active === "providers" && (
                    <ProvidersSection disk={disk} refExists={refExists} onChanged={refresh} disabled={isGatedAndLocked} />
                  )}
                  {active === "shell" && (
                    <ShellSection disk={disk} onChanged={refresh} disabled={isGatedAndLocked} />
                  )}
                  {active === "claude-config" && (
                    <ClaudeConfigPanel disabled={isGatedAndLocked} />
                  )}
                  {active === "mise-config" && (
                    <MiseConfigPanel disabled={isGatedAndLocked} />
                  )}
                  {active === "token-usage" && (
                    <TokenUsagePage />
                  )}
                  {active === "api-tokens" && (
                    <ApiTokensSection />
                  )}
                  {active === "accounts" && (
                    <AccountsSection />
                  )}
                  {active === "admin-users" && (
                    <div className="rounded-lg border border-gray-200 bg-white p-5"><UsersPanel currentUserId={ws.currentUser?.id ?? ""} /></div>
                  )}
                  {active === "admin-workspace" && (
                    <AdminWorkspacePanel />
                  )}
                  {active === "admin-serve" && (
                    <div className="rounded-lg border border-gray-200 bg-white p-5"><ServePanel /></div>
                  )}
                </div>
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Providers
// ────────────────────────────────────────────────────────────────────────────

/** Preset providers with Anthropic-compatible endpoints.
 *  loopat uses the Claude Agent SDK which speaks the Anthropic Messages API.
 *  Only providers that expose an Anthropic-compatible endpoint work directly. */
import { PROVIDER_PRESETS as PRESETS } from "../../../server/src/presets"

type ProvidersDraft = {
  default: string
  providers: Record<string, {
    models: ModelEntry[]
    baseUrl: string
    maxContextTokens: string
    enabled: boolean
    apiKeyNewValue: string
    apiKeyStored: boolean
  }>
}

function ProvidersSection({ disk, refExists, onChanged, disabled }: {
  disk: PersonalConfigDisk | null
  refExists: RefExistsMap
  onChanged: () => void
  disabled?: boolean
}) {
  const [draft, setDraft] = useState<ProvidersDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [newName, setNewName] = useState("")
  const [adding, setAdding] = useState(false)
  const [newModelName, setNewModelName] = useState<Record<string, string>>({})
  const [addingModel, setAddingModel] = useState<Record<string, boolean>>({})
  const [editingProvName, setEditingProvName] = useState<string | null>(null)
  const [provRenameValue, setProvRenameValue] = useState("")
  const [editingModelKey, setEditingModelKey] = useState<string | null>(null)
  const [newModelIdValue, setNewModelIdValue] = useState("")
  const [testingModel, setTestingModel] = useState<Record<string, string>>({})
  const [testError, setTestError] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!disk) { setDraft(null); return }
    const next: ProvidersDraft = { default: "", providers: {} }
    for (const [name, val] of Object.entries(disk.providers)) {
      if (name === "default") {
        if (typeof val === "string") next.default = val
        continue
      }
      if (val && typeof val === "object") {
        const p = val as ProviderDisk
        const refInfo = refExists[`providers.${name}.apiKey`]
        next.providers[name] = {
          models: (p.models && p.models.length > 0)
            ? p.models.map(m => ({ id: m.id, enabled: m.enabled !== false }))
            : (p.model ? [{ id: p.model, enabled: true }] : []),
          baseUrl: p.baseUrl ?? "",
          maxContextTokens: p.maxContextTokens ? String(p.maxContextTokens) : "",
          enabled: p.enabled !== false,
          apiKeyNewValue: "",
          apiKeyStored: !!refInfo?.exists,
        }
      }
    }
    setDraft(next)
  }, [disk, refExists])

  const names = draft ? Object.keys(draft.providers) : []

  const updateProv = (name: string, patch: Partial<ProvidersDraft["providers"][string]>) => {
    setDraft((d) => {
      if (!d || !d.providers[name]) return d
      return { ...d, providers: { ...d.providers, [name]: { ...d.providers[name], ...patch } } }
    })
  }

  const remove = (name: string) => {
    setDraft((d) => {
      if (!d) return d
      const { [name]: _, ...rest } = d.providers
      const clearDefault = d.default === name || d.default.startsWith(`${name}/`)
      return { ...d, providers: rest, default: clearDefault ? "" : d.default }
    })
  }

  const updateModel = (provName: string, modelId: string, patch: Partial<ModelEntry>) => {
    setDraft((d) => {
      if (!d || !d.providers[provName]) return d
      const models = d.providers[provName].models.map(m =>
        m.id === modelId ? { ...m, ...patch } : m,
      )
      return { ...d, providers: { ...d.providers, [provName]: { ...d.providers[provName], models } } }
    })
  }

  const toggleModel = (provName: string, modelId: string) => {
    setDraft((d) => {
      if (!d || !d.providers[provName]) return d
      const models = d.providers[provName].models.map(m =>
        m.id === modelId ? { ...m, enabled: !m.enabled } : m,
      )
      return { ...d, providers: { ...d.providers, [provName]: { ...d.providers[provName], models } } }
    })
  }

  const removeModel = (provName: string, modelId: string) => {
    setDraft((d) => {
      if (!d || !d.providers[provName]) return d
      const models = d.providers[provName].models.filter(m => m.id !== modelId)
      const clearDefault = d.default === `${provName}/${modelId}`
      return { ...d, default: clearDefault ? "" : d.default, providers: { ...d.providers, [provName]: { ...d.providers[provName], models } } }
    })
  }

  const addModel = (provName: string) => {
    const id = (newModelName[provName] ?? "").trim()
    if (!id) return
    setDraft((d) => {
      if (!d || !d.providers[provName]) return d
      if (d.providers[provName].models.some(m => m.id === id)) return d
      return {
        ...d,
        providers: {
          ...d.providers,
          [provName]: {
            ...d.providers[provName],
            models: [...d.providers[provName].models, { id, enabled: true }],
          },
        },
      }
    })
    setNewModelName((p) => ({ ...p, [provName]: "" }))
    setAddingModel((p) => ({ ...p, [provName]: false }))
  }

  const renameModel = (provName: string, oldId: string) => {
    const newId = newModelIdValue.trim()
    if (!newId || newId === oldId) { setEditingModelKey(null); return }
    setDraft((d) => {
      if (!d || !d.providers[provName]) return d
      if (d.providers[provName].models.some(m => m.id === newId)) return d
      const models = d.providers[provName].models.map(m =>
        m.id === oldId ? { ...m, id: newId } : m,
      )
      const prevDefault = d.default === `${provName}/${oldId}` ? `${provName}/${newId}` : d.default
      return { ...d, default: prevDefault, providers: { ...d.providers, [provName]: { ...d.providers[provName], models } } }
    })
    setEditingModelKey(null)
  }

  const renameProvider = (oldName: string) => {
    const newName = provRenameValue.trim()
    if (!newName || newName === oldName || newName === "default") { setEditingProvName(null); return }
    setDraft((d) => {
      if (!d || !d.providers[oldName]) return d
      if (d.providers[newName]) return d
      const { [oldName]: prov, ...rest } = d.providers
      // Update default: if default starts with "oldName/" or equals oldName, rewrite to newName
      let newDefault = d.default
      if (d.default === oldName) {
        newDefault = newName
      } else if (d.default.startsWith(`${oldName}/`)) {
        newDefault = newName + d.default.slice(oldName.length)
      }
      return { ...d, default: newDefault, providers: { ...rest, [newName]: prov } }
    })
    setEditingProvName(null)
  }

  const addProvider = () => {
    const n = newName.trim()
    if (!n) return
    if (n === "default") { setErr("'default' is reserved"); return }
    setDraft((d) => {
      if (!d) return d
      if (d.providers[n]) return d
      return { ...d, providers: { ...d.providers, [n]: {
        models: [], baseUrl: "", maxContextTokens: "", enabled: false,
        apiKeyNewValue: "", apiKeyStored: false,
      } } }
    })
    setNewName("")
    setAdding(false)
    setErr(null)
  }

  const save = async () => {
    if (!draft) return
    setSaving(true)
    setErr(null)
    // Each provider derives a deterministic env var name: ANTHROPIC → ANTHROPIC_API_KEY etc.
    // If the user typed a new value, write it to vault envs/<VAR>; the apiKey
    // field becomes "${VAR}" so config.json never carries the literal value.
    for (const [name, p] of Object.entries(draft.providers)) {
      if (!p.apiKeyNewValue.trim()) continue
      const varName = providerEnvVarName(name)
      const r = await writeVaultEnv(varName, p.apiKeyNewValue.trim())
      if (!r.ok) { setErr(`apiKey write failed for "${name}": ${r.error}`); setSaving(false); return }
    }
    const providersOut: Record<string, ProviderDisk | string> = {}
    if (draft.default) providersOut.default = draft.default
    for (const [name, p] of Object.entries(draft.providers)) {
      const models: ModelEntry[] = p.models
        .filter(m => m.id.trim())
        .map(m => ({
          id: m.id.trim(),
          ...(m.enabled ? {} : { enabled: false }),
          ...(m.maxContextTokens && m.maxContextTokens > 0 ? { maxContextTokens: m.maxContextTokens } : {}),
        }))
      providersOut[name] = {
        baseUrl: p.baseUrl,
        apiKey: `\${${providerEnvVarName(name)}}`,
        ...(models.length > 0 ? { models } : {}),
        ...(p.maxContextTokens ? { maxContextTokens: Number(p.maxContextTokens) } : {}),
        ...(p.enabled ? {} : { enabled: false }),
      }
    }
    const r = await savePersonalDisk({ providers: providersOut })
    setSaving(false)
    if (!r.ok) { setErr(r.error ?? "save failed"); return }
    onChanged()
  }

  if (!draft) return <div className="text-[12px] text-gray-400 italic">no providers yet</div>

  return (
    <div className="flex flex-col gap-3">
      {names.map((name) => {
        const p = draft.providers[name]
        const isAddingModel = addingModel[name] ?? false
        const hasKey = p.apiKeyStored || p.apiKeyNewValue.trim() !== ""
        return (
          <div key={name} className="bg-white border border-gray-200 rounded-lg overflow-hidden transition-shadow hover:shadow-sm">
            {/* Provider header */}
            <div className="flex items-center gap-3 px-4 py-2.5 bg-gray-50/50 border-b border-gray-100">
              <label className="flex items-center gap-2.5 flex-1 min-w-0 select-none">
                <Switch
                  checked={p.enabled}
                  onCheckedChange={(v) => hasKey ? updateProv(name, { enabled: v }) : undefined}
                  disabled={!hasKey}
                  size="sm"
                />
                {editingProvName === name ? (
                  <input
                    autoFocus
                    value={provRenameValue}
                    onChange={(e) => setProvRenameValue(e.target.value)}
                    onBlur={() => renameProvider(name)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") renameProvider(name)
                      if (e.key === "Escape") setEditingProvName(null)
                    }}
                    className={cn(inputClass, "text-[13px] font-semibold flex-1 min-w-0")}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => { setEditingProvName(name); setProvRenameValue(name) }}
                    className={`text-[13px] font-semibold truncate text-left hover:underline ${p.enabled ? "text-gray-900" : "text-gray-400"}`}
                    title="click to rename"
                  >
                    {name}
                  </button>
                )}
                {!p.enabled && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-400 font-medium shrink-0">disabled</span>
                )}
              </label>
              <button
                type="button"
                onClick={() => remove(name)}
                className="text-[11px] text-gray-400 hover:text-red-500 transition-colors shrink-0"
              >
                remove
              </button>
            </div>

            {/* Fields */}
            <div className="p-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                <Labeled label="Base URL">
                  <input
                    value={p.baseUrl}
                    onChange={(e) => updateProv(name, { baseUrl: e.target.value })}
                    placeholder="https://api.example.com"
                    className={inputClass}
                  />
                </Labeled>
                <Labeled label="Max context tokens">
                  <input
                    type="number"
                    value={p.maxContextTokens}
                    onChange={(e) => updateProv(name, { maxContextTokens: e.target.value })}
                    placeholder="auto"
                    className={inputClass}
                  />
                </Labeled>
                <Labeled label={p.apiKeyStored ? "API key (set — type to overwrite)" : "API key"} className="sm:col-span-2">
                  <input
                    type="password"
                    value={p.apiKeyNewValue}
                    onChange={(e) => updateProv(name, { apiKeyNewValue: e.target.value })}
                    placeholder={p.apiKeyStored ? "•••••• stored encrypted in vault" : "paste API key"}
                    className={inputClass}
                  />
                </Labeled>
              </div>

              {/* Model list */}
              <div className="border-t border-gray-100 pt-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                    Models ({p.models.length})
                  </span>
                  <button
                    type="button"
                    onClick={() => setAddingModel((a) => ({ ...a, [name]: !isAddingModel }))}
                    className="text-[11px] text-gray-500 hover:text-gray-900 inline-flex items-center gap-1 transition-colors"
                  >
                    <Plus size={11} /> add model
                  </button>
                </div>

                {isAddingModel && (
                  <div className="flex items-center gap-1.5 mb-2">
                    <input
                      autoFocus
                      value={newModelName[name] ?? ""}
                      onChange={(e) => setNewModelName((a) => ({ ...a, [name]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter") addModel(name); if (e.key === "Escape") setAddingModel((a) => ({ ...a, [name]: false })) }}
                      placeholder="model ID (e.g. claude-sonnet-4-20250514)"
                      className={cn(inputClass, "flex-1 text-[11px]")}
                    />
                    <Button size="xs" onClick={() => addModel(name)}>add</Button>
                    <Button variant="ghost" size="xs" onClick={() => setAddingModel((a) => ({ ...a, [name]: false }))}>cancel</Button>
                  </div>
                )}

                {p.models.length === 0 && !isAddingModel && (
                  <div className="text-[11px] text-gray-400 italic py-2">no models — add one above</div>
                )}
                <div className="-mx-1">
                  {p.models.map((m) => {
                    const isDefaultModel = draft.default === `${name}/${m.id}`
                    const editKey = `${name}::${m.id}`
                    const isEditing = editingModelKey === editKey
                    const tmState = testingModel[`${name}::${m.id}`]
                    const tmErr = testError[`${name}::${m.id}`]
                    return (
                    <div key={m.id} className="flex items-center gap-1.5 px-1 py-1.5 rounded group hover:bg-gray-50 transition-colors">
                      {/* Default model star */}
                      <button
                        type="button"
                        onClick={() => setDraft((d) => d ? { ...d, default: isDefaultModel ? "" : `${name}/${m.id}` } : d)}
                        className={`shrink-0 text-[13px] leading-none transition-colors ${isDefaultModel ? "text-amber-500" : "text-gray-200 hover:text-amber-400"}`}
                        title={isDefaultModel ? "current default model" : "set as default model"}
                      >
                        ★
                      </button>
                      <label className="flex items-center shrink-0 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={m.enabled !== false}
                          onChange={() => toggleModel(name, m.id)}
                          className="h-3.5 w-3.5 rounded border-gray-300 text-gray-900 accent-gray-900"
                        />
                      </label>
                      <div className="flex-1 min-w-0 flex items-center gap-1">
                        {isEditing ? (
                          <input
                            autoFocus
                            value={newModelIdValue}
                            onChange={(e) => setNewModelIdValue(e.target.value)}
                            onBlur={() => renameModel(name, m.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") renameModel(name, m.id)
                              if (e.key === "Escape") setEditingModelKey(null)
                            }}
                            className={cn(inputClass, "text-[11px] flex-1 min-w-0")}
                          />
                        ) : (
                          <code
                            className={`text-[12px] truncate cursor-pointer hover:bg-gray-100 px-0.5 rounded ${
                              m.enabled !== false ? "text-gray-700" : "text-gray-300 line-through"
                            }`}
                            onClick={() => { setEditingModelKey(editKey); setNewModelIdValue(m.id) }}
                            title="click to edit model ID"
                          >
                            {m.id}
                          </code>
                        )}
                        {m.enabled === false && (
                          <span className="text-[10px] text-gray-300 font-medium shrink-0">off</span>
                        )}
                      </div>
                      <input
                        type="number"
                        value={m.maxContextTokens ?? ""}
                        onChange={(e) => updateModel(name, m.id, { maxContextTokens: e.target.value ? Number(e.target.value) : undefined })}
                        placeholder="auto"
                        className={`w-24 px-1.5 py-0.5 border border-gray-200 rounded text-[10px] outline-none focus:border-gray-400 shrink-0 ${m.maxContextTokens ? "" : "opacity-0 group-hover:opacity-100 transition-opacity"}`}
                        title="max context tokens (empty = auto)"
                      />
                      {/* Test button */}
                      <button
                        type="button"
                        onClick={async () => {
                          const newKey = p.apiKeyNewValue.trim()
                          const tk = `${name}::${m.id}`
                          if (!newKey && !p.apiKeyStored) {
                            setTestingModel((t) => ({ ...t, [tk]: "error" }))
                            setTestError((t) => ({ ...t, [tk]: "enter an API key first" }))
                            setTimeout(() => {
                              setTestingModel((t) => { const { [tk]: _, ...rest } = t; return rest })
                              setTestError((t) => { const { [tk]: _, ...rest } = t; return rest })
                            }, 3000)
                            return
                          }
                          setTestingModel((t) => ({ ...t, [tk]: "testing" }))
                          setTestError((t) => ({ ...t, [tk]: "" }))
                          try {
                            const result = newKey
                              ? await testProviderConnection(p.baseUrl, newKey, m.id)
                              : await testProviderConnection(p.baseUrl, "", m.id, name, "personal")
                            setTestingModel((t) => ({ ...t, [tk]: result.ok ? "ok" : "error" }))
                            if (!result.ok) setTestError((t) => ({ ...t, [tk]: result.error ?? "unknown error" }))
                          } catch (e: any) {
                            setTestingModel((t) => ({ ...t, [tk]: "error" }))
                            setTestError((t) => ({ ...t, [tk]: e?.message ?? "connection failed" }))
                          }
                          setTimeout(() => {
                            setTestingModel((t) => { const { [tk]: _, ...rest } = t; return rest })
                            setTestError((t) => { const { [tk]: _, ...rest } = t; return rest })
                          }, 4000)
                        }}
                        disabled={tmState === "testing" || (!p.apiKeyStored && !p.apiKeyNewValue.trim())}
                        className={`shrink-0 text-[10px] px-1 py-0 rounded transition-colors ${
                          !p.apiKeyStored && !p.apiKeyNewValue.trim() ? "opacity-0 group-hover:opacity-100 text-gray-300" :
                          tmState === "ok" ? "bg-emerald-100 text-emerald-700" :
                          tmState === "error" ? "bg-red-100 text-red-700" :
                          tmState === "testing" ? "bg-gray-100 text-gray-400 animate-pulse" :
                          "text-gray-400 hover:text-gray-700 opacity-0 group-hover:opacity-100"
                        }`}
                        title={tmErr || (p.apiKeyNewValue.trim() ? "test connection" : p.apiKeyStored ? "test connection" : "enter an API key first")}
                      >
                        {tmState === "ok" ? "OK" : tmState === "error" ? "FAIL" : tmState === "testing" ? "..." : "test"}
                      </button>
                      <button
                        type="button"
                        onClick={() => removeModel(name, m.id)}
                        className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                        title="remove model"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        )
      })}

      {/* Preset provider shortcuts */}
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.filter((p) => !draft.providers[p.name]).map((p) => (
          <button
            key={p.name}
            type="button"
            onClick={() => {
              setDraft((d) => {
                if (!d || d.providers[p.name]) return d
                return {
                  ...d,
                  providers: {
                    ...d.providers,
                    [p.name]: {
                      models: p.models.map((id) => ({ id, enabled: true })),
                      baseUrl: p.baseUrl,
                      maxContextTokens: "",
                      enabled: false,
                      apiKeyNewValue: "",
                      apiKeyStored: false,
                    },
                  },
                }
              })
            }}
            className="px-2 py-0.5 rounded border border-gray-200 bg-white text-[10px] text-gray-500 hover:text-gray-900 hover:border-gray-400 transition-colors"
            title={`Add ${p.name} preset`}
          >
            + {p.name}
          </button>
        ))}
      </div>

      {adding ? (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addProvider(); if (e.key === "Escape") setAdding(false) }}
            placeholder="provider name"
            className={cn(inputClass, "flex-1")}
          />
          <Button size="sm" onClick={addProvider}>add</Button>
          <Button variant="ghost" size="sm" onClick={() => { setAdding(false); setNewName("") }}>cancel</Button>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="self-start text-xs text-gray-500 hover:text-gray-900 inline-flex items-center gap-1"
        >
          <Plus size={12} /> add custom provider
        </button>
      )}

      <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-gray-100">
        {err && <span className="text-xs text-red-600">{err}</span>}
        <Button size="sm" onClick={save} disabled={saving || disabled}>
          {saving ? "saving…" : "save providers"}
        </Button>
      </div>

    </div>
  )
}

function Labeled({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ""}`}>
      <span className="text-[11px] font-medium text-gray-500">{label}</span>
      {children}
    </label>
  )
}


// ────────────────────────────────────────────────────────────────────────────
// Shell
// ────────────────────────────────────────────────────────────────────────────

const SHELL_PRESETS: Array<{ value: string; label: string; description: string }> = [
  { value: "",                  label: "Default (bash)",      description: "POSIX-guaranteed; works everywhere" },
  { value: "fish",              label: "fish",                description: "Friendly interactive shell with autosuggestions" },
  { value: "zsh",               label: "zsh",                 description: "Common default on macOS-style setups" },
]

function ShellSection({ disk, onChanged, disabled }: {
  disk: PersonalConfigDisk | null
  onChanged: () => void
  disabled?: boolean
}) {
  const [val, setVal] = useState("")
  const [customMode, setCustomMode] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const v = disk?.shell ?? ""
    setVal(v)
    setCustomMode(!!v && !SHELL_PRESETS.some((p) => p.value === v))
  }, [disk])

  const save = async () => {
    setSaving(true)
    setErr(null)
    setSaved(false)
    const r = await savePersonalDisk({ shell: val })
    setSaving(false)
    if (!r.ok) { setErr(r.error ?? "save failed"); return }
    setSaved(true)
    onChanged()
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden p-4 flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        {SHELL_PRESETS.map((p) => (
          <label
            key={p.value || "default"}
            className={
              "flex items-start gap-2 px-3 py-2 rounded border " +
              (!customMode && val === p.value ? "border-gray-900 bg-gray-50" : "border-gray-200 hover:bg-gray-50")
            }
          >
            <input
              type="radio"
              name="shell-preset"
              checked={!customMode && val === p.value}
              onChange={() => { setVal(p.value); setCustomMode(false); setSaved(false) }}
              className="mt-0.5"
            />
            <div className="flex-1 min-w-0">
              <div className="text-[13px] text-gray-900">{p.label}</div>
              <div className="text-[11.5px] text-gray-500">{p.description}</div>
            </div>
          </label>
        ))}
        <label
          className={
            "flex items-start gap-2 px-3 py-2 rounded border " +
            (customMode ? "border-gray-900 bg-gray-50" : "border-gray-200 hover:bg-gray-50")
          }
        >
          <input
            type="radio"
            name="shell-preset"
            checked={customMode}
            onChange={() => { setCustomMode(true); setSaved(false) }}
            className="mt-0.5"
          />
          <div className="flex-1 min-w-0">
            <div className="text-[13px] text-gray-900">Custom</div>
            <div className="text-[11.5px] text-gray-500 mb-1">Binary name in sandbox PATH or absolute path</div>
            {customMode && (
              <input
                value={val}
                onChange={(e) => { setVal(e.target.value); setSaved(false) }}
                placeholder="/usr/bin/nushell"
                className={cn(inputClass, "font-mono")}
              />
            )}
          </div>
        </label>
      </div>
      <div className="flex items-center justify-end gap-2 p-3 border-t border-gray-100">
        {err && <span className="text-xs text-red-600">{err}</span>}
        {saved && !err && <span className="text-xs text-emerald-700 flex items-center gap-1"><Check size={12} /> saved</span>}
        <Button size="sm" onClick={save} disabled={saving || disabled}>
          {saving ? "saving…" : "save shell"}
        </Button>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Gateway Tokens
// ────────────────────────────────────────────────────────────────────────────

function ApiTokensSection() {
  const [tokens, setTokens] = useState<ApiTokenEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [label, setLabel] = useState("")
  const [creating, setCreating] = useState(false)
  const [newToken, setNewToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    const list = await listApiTokens()
    setTokens(list)
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleCreate = async () => {
    if (creating) return
    setCreating(true)
    const result = await createApiToken(label.trim() || "default")
    setCreating(false)
    if (result) {
      setNewToken(result.token)
      setLabel("")
      setCopied(false)
      refresh()
    }
  }

  const handleRevoke = async (tokenId: string) => {
    await revokeApiToken(tokenId)
    setDeleteConfirm(null)
    refresh()
  }

  const handleCopy = () => {
    if (!newToken) return
    navigator.clipboard.writeText(newToken).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="space-y-4">
      {/* new token reveal banner */}
      {newToken && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Check size={14} className="text-emerald-600" />
            <span className="text-[13px] font-medium text-emerald-900">Token created — copy it now, it won't be shown again</span>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-[12px] bg-white border border-emerald-200 rounded px-3 py-2 font-mono text-gray-800 select-all break-all">
              {newToken}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="shrink-0 h-8 px-3 rounded text-xs border border-emerald-300 hover:bg-emerald-100 text-emerald-800 flex items-center gap-1.5"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? "copied" : "copy"}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setNewToken(null)}
            className="mt-2 text-[11px] text-emerald-700 hover:text-emerald-900 underline"
          >
            dismiss
          </button>
        </div>
      )}

      {/* docs link */}
      <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 flex items-center justify-between">
        <div>
          <h3 className="text-[13px] font-medium text-gray-900">Loop API documentation</h3>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Interactive reference for the endpoints these tokens authenticate against.
          </p>
        </div>
        <a
          href="/api/v1/docs"
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded text-[12px] border border-gray-300 hover:bg-gray-50 text-gray-700"
        >
          Open docs →
        </a>
      </div>

      {/* token list */}
      <div className="rounded-lg border border-gray-200 bg-white">
        <div className="px-4 py-3 border-b border-gray-100">
          <h3 className="text-[13px] font-medium text-gray-900">Your tokens</h3>
          <p className="text-[11px] text-gray-500 mt-0.5">
            External programs use these tokens to call loopat under your identity — your providers, API keys, and vault.
          </p>
        </div>

        {loading ? (
          <div className="px-4 py-8 text-center text-[12px] text-gray-400 italic">loading…</div>
        ) : tokens.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-gray-400">
            No API tokens yet. Create one below.
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-gray-100 text-left text-[11px] text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-2 font-medium">Label</th>
                <th className="px-4 py-2 font-medium">Token</th>
                <th className="px-4 py-2 font-medium">Created</th>
                <th className="px-4 py-2 font-medium w-10"></th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.tokenId} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-4 py-2.5 text-gray-900">{t.label}</td>
                  <td className="px-4 py-2.5 font-mono text-[12px] text-gray-500">{t.tokenId}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-[12px]">{new Date(t.createdAt).toLocaleDateString()}</td>
                  <td className="px-4 py-2.5">
                    {deleteConfirm === t.tokenId ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleRevoke(t.tokenId)}
                          className="text-[11px] text-red-600 hover:text-red-800 font-medium"
                        >
                          confirm
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteConfirm(null)}
                          className="text-[11px] text-gray-400 hover:text-gray-600"
                        >
                          cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setDeleteConfirm(t.tokenId)}
                        className="w-7 h-7 flex items-center justify-center rounded text-gray-400 hover:text-red-600 hover:bg-red-50"
                        title="revoke token"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* create form */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="text-[13px] font-medium text-gray-900 mb-2">Create new token</h3>
        <div className="flex items-center gap-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="label (e.g. dingtalk-bot)"
            className="flex-1 px-2.5 py-1.5 border border-gray-300 rounded text-[13px] outline-none bg-white focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="h-8 px-3 rounded text-xs bg-gray-900 hover:bg-gray-800 text-white flex items-center gap-1.5 disabled:opacity-50"
          >
            <Plus size={12} />
            {creating ? "creating…" : "create token"}
          </button>
        </div>
      </div>

      {/* usage hint */}
      <div className="rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
        <p className="text-[11px] text-gray-500 leading-relaxed">
          <strong className="text-gray-700">Usage:</strong> pass the token as{" "}
          <code className="bg-white border border-gray-200 rounded px-1 py-0.5 text-[10px]">Authorization: Bearer &lt;token&gt;</code>{" "}
          when calling{" "}
          <code className="bg-white border border-gray-200 rounded px-1 py-0.5 text-[10px]">POST /api/runtime/v1/turn/stream</code>.
          The request will run under your identity with your configured providers and API keys.
        </p>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Accounts — additional accounts (API-only, no password login) owned by the
// current account. See docs/account-model.md.
// ────────────────────────────────────────────────────────────────────────────

function AccountsSection() {
  const [accounts, setAccounts] = useState<PublicAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [newId, setNewId] = useState("")
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [justCreated, setJustCreated] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    const list = await listMyAccounts()
    setAccounts(list)
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleCreate = async () => {
    if (creating) return
    const id = newId.trim().toLowerCase()
    if (!id) return
    setCreating(true)
    setCreateError(null)
    const result = await createMyAccount(id)
    setCreating(false)
    if (result.error) {
      setCreateError(result.error)
      return
    }
    if (result.account) {
      setNewId("")
      setJustCreated(result.account.id)
      setTimeout(() => setJustCreated(null), 4000)
      refresh()
    }
  }

  const handleDelete = async (id: string) => {
    const r = await deleteMyAccount(id)
    setDeleteConfirm(null)
    if (r.ok) refresh()
  }

  return (
    <div className="space-y-4">
      {/* What this is */}
      <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-[12px] text-blue-900">
        <strong className="font-medium">What is this?</strong> Additional accounts you own. They cannot log in via password — only you, via this UI, can manage them. Each account has its own vault, .claude config, loops, and tokens. External programs (bots, CI hooks, etc.) drive them via Bearer tokens issued from <strong>API Tokens</strong>.
        See <a className="underline" href="/api/v1/docs" target="_blank" rel="noopener noreferrer">API docs</a>.
      </div>

      {/* Just-created confirmation */}
      {justCreated && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-[12px] text-emerald-900 flex items-center gap-2">
          <Check size={14} />
          <span>Created account <code className="bg-white border border-emerald-200 rounded px-1.5 py-0.5 font-mono text-[11px]">{justCreated}</code>. Next: go to <strong>API Tokens</strong> to issue a token for it.</span>
        </div>
      )}

      {/* Account list */}
      <div className="rounded-lg border border-gray-200 bg-white">
        <div className="px-4 py-3 border-b border-gray-100">
          <h3 className="text-[13px] font-medium text-gray-900">Your accounts</h3>
          <p className="text-[11px] text-gray-500 mt-0.5">
            API-only accounts you own. Each one is a separate identity with its own resources.
          </p>
        </div>

        {loading ? (
          <div className="px-4 py-8 text-center text-[12px] text-gray-400 italic">loading…</div>
        ) : accounts.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-gray-400">
            No accounts yet. Create one below.
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-gray-100 text-left text-[11px] text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-2 font-medium">ID</th>
                <th className="px-4 py-2 font-medium">Created</th>
                <th className="px-4 py-2 font-medium w-32"></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-4 py-2.5 font-mono text-gray-900">{a.id}</td>
                  <td className="px-4 py-2.5 text-gray-500 text-[12px]">{new Date(a.createdAt).toLocaleDateString()}</td>
                  <td className="px-4 py-2.5">
                    {deleteConfirm === a.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleDelete(a.id)}
                          className="text-[11px] text-red-600 hover:text-red-800 font-medium"
                        >
                          confirm
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteConfirm(null)}
                          className="text-[11px] text-gray-400 hover:text-gray-600"
                        >
                          cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setDeleteConfirm(a.id)}
                        className="w-7 h-7 flex items-center justify-center rounded text-gray-400 hover:text-red-600 hover:bg-red-50"
                        title="delete account"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Create form */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="text-[13px] font-medium text-gray-900 mb-2">Create new account</h3>
        <div className="flex gap-2">
          <input
            type="text"
            value={newId}
            onChange={(e) => { setNewId(e.target.value); setCreateError(null) }}
            placeholder="e.g. my-coderev-bot"
            className={inputClass}
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate() }}
            disabled={creating}
          />
          <button
            type="button"
            onClick={handleCreate}
            disabled={!newId.trim() || creating}
            className="shrink-0 h-9 px-4 rounded text-[13px] bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating ? "creating…" : "Create"}
          </button>
        </div>
        {createError && (
          <p className="mt-2 text-[12px] text-red-600 flex items-center gap-1.5">
            <AlertCircle size={12} />
            {createError}
          </p>
        )}
        <p className="mt-2 text-[11px] text-gray-500">
          ID rules: lowercase a-z 0-9 _ - , 1-32 chars, must start with alphanumeric. Shares the global namespace with personal accounts — pick a name no one else has taken.
        </p>
      </div>
    </div>
  )
}
