/**
 * Full-screen Settings page — the UX-friendly editor for
 * `personal/<user>/.loopat/config.json`. Sections: Providers, Environment,
 * Mounts, Shell, Personal Repo. Output is byte-identical to hand-editing
 * the JSON.
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
  writePersonalValue,
  listPersonalEntries,
  testProviderConnection,
  type ConfigValue,
  type PersonalConfigDisk,
  type ProviderDisk,
  type MountDisk,
  type RefExistsMap,
  type PersonalEntry,
  type ModelEntry,
} from "../api"
import { PersonalRepoPanel } from "../components/dialog/PersonalRepoPanel"
import { McpStatusPanel } from "../components/McpStatusPanel"
import { UsersPanel, WorkspacePanel as AdminWorkspacePanel, ServePanel } from "../components/dialog/AdminDialog"
import { useWorkspace } from "@/ctx"
import { ArrowLeft, Plus, Trash2, RefreshCw, Check, AlertCircle, Lock, FileCode2, Search } from "lucide-react"
import { useSearchParams } from "react-router-dom"

type TabId = "personal-repo" | "providers" | "envs" | "mounts" | "shell" | "mcp" | "token-usage" | "admin-users" | "admin-workspace" | "admin-serve"

const TABS: { id: TabId; label: string; gated: boolean; description: string }[] = [
  { id: "personal-repo", label: "Personal Repo",          gated: false, description: "Your private repo carrying credentials + dotfiles." },
  { id: "providers",     label: "AI Providers",           gated: true,  description: "Models, base URLs, API keys. Pick a default." },
  { id: "envs",          label: "Environment Variables", gated: true,  description: "Env vars injected into every loop sandbox." },
  { id: "mounts",        label: "Sandbox Mounts",         gated: true,  description: "Expose personal files / dirs into loop sandboxes." },
  { id: "shell",         label: "Terminal Shell",         gated: true,  description: "PTY shell binary used in loop terminals." },
  { id: "mcp",           label: "MCP",                    gated: true,  description: "OAuth tokens for MCP servers. Per-vault." },
  { id: "token-usage",   label: "Token Usage",            gated: false, description: "Token consumption across models, loops, and time." },
  { id: "admin-users",    label: "Users",                 gated: false, description: "Manage workspace members — activate, promote, remove." },
  { id: "admin-workspace",label: "Workspace AI Providers", gated: false, description: "Shared workspace provider configuration." },
  { id: "admin-serve",    label: "Share Artifact Serve",   gated: false, description: "Public share domain and HTTPS settings." },
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
      <style>{`
        .ip { width: 100%; padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 13px; outline: none; background: white; }
        .ip:focus { border-color: #111827; }
        .ip:disabled { background: #f3f4f6; color: #9ca3af; }
      `}</style>

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
                  const locked = t.gated && !statusReady
                  return (
                    <li key={t.id} className="shrink-0 sm:px-1">
                      <button
                        type="button"
                        onClick={() => navigate(t.id === "token-usage" ? "/usage" : `/settings/${t.id}`)}
                        className={
                          "w-full text-left px-2.5 py-1.5 rounded text-[13px] flex items-center gap-2 transition-colors whitespace-nowrap " +
                          (isActive ? "bg-gray-100 text-gray-900 font-medium" : "text-gray-600 hover:bg-gray-50 hover:text-gray-900")
                        }
                      >
                        <span className="flex-1 truncate">{t.label}</span>
                        {locked && <span title="locked"><Lock size={11} className="text-amber-600 shrink-0" /></span>}
                      </button>
                    </li>
                  )
                })
              : (
                <>
                  {regularTabs.map((t) => {
                    const isActive = t.id === active
                    const locked = t.gated && !statusReady
                    return (
                      <li key={t.id} className="shrink-0 sm:px-1">
                        <button
                          type="button"
                          onClick={() => navigate(t.id === "token-usage" ? "/usage" : `/settings/${t.id}`)}
                          className={
                            "w-full text-left px-2.5 py-1.5 rounded text-[13px] flex items-center gap-2 transition-colors whitespace-nowrap " +
                            (isActive ? "bg-gray-100 text-gray-900 font-medium" : "text-gray-600 hover:bg-gray-50 hover:text-gray-900")
                          }
                        >
                          <span className="flex-1 truncate">{t.label}</span>
                          {locked && <span title="locked"><Lock size={11} className="text-amber-600 shrink-0" /></span>}
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
                              onClick={() => navigate(t.id === "token-usage" ? "/usage" : `/settings/${t.id}`)}
                              className={
                                "w-full text-left px-2.5 py-1.5 rounded text-[13px] flex items-center gap-2 transition-colors whitespace-nowrap " +
                                (isActive ? "bg-gray-100 text-gray-900 font-medium" : "text-gray-600 hover:bg-gray-50 hover:text-gray-900")
                              }
                            >
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
          <div className="max-w-[760px] mx-auto px-4 sm:px-6 py-5">
            {loading && !disk ? (
              <div className="text-[13px] text-gray-400 italic py-12 text-center">loading…</div>
            ) : (
              <>
                <div className="mb-4">
                  <h2 className="text-[16px] font-semibold text-gray-900">{activeMeta.label}</h2>
                  <p className="text-[12.5px] text-gray-500 mt-0.5">{activeMeta.description}</p>
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

                <div className={isGatedAndLocked ? "opacity-50 pointer-events-none" : ""}>
                  {active === "personal-repo" && <PersonalRepoPanel onDone={refresh} />}
                  {active === "providers" && (
                    <ProvidersSection disk={disk} refExists={refExists} onChanged={refresh} disabled={isGatedAndLocked} />
                  )}
                  {active === "envs" && (
                    <EnvsSection disk={disk} refExists={refExists} onChanged={refresh} disabled={isGatedAndLocked} />
                  )}
                  {active === "mounts" && (
                    <MountsSection disk={disk} onChanged={refresh} disabled={isGatedAndLocked} />
                  )}
                  {active === "shell" && (
                    <ShellSection disk={disk} onChanged={refresh} disabled={isGatedAndLocked} />
                  )}
                  {active === "mcp" && (
                    <McpSection disabled={isGatedAndLocked} />
                  )}
                  {active === "admin-users" && (
                    <UsersPanel currentUserId={ws.currentUser?.id ?? ""} />
                  )}
                  {active === "admin-workspace" && (
                    <AdminWorkspacePanel />
                  )}
                  {active === "admin-serve" && (
                    <ServePanel />
                  )}
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
const PRESETS: Array<{ name: string; baseUrl: string; models: string[] }> = [
  { name: "Anthropic", baseUrl: "https://api.anthropic.com",
    models: ["claude-sonnet-4-20250514", "claude-opus-4-7-20251101"] },
  { name: "DeepSeek",  baseUrl: "https://api.deepseek.com/anthropic",
    models: ["deepseek-v4-pro", "deepseek-v4-flash"] },
  { name: "Kimi",      baseUrl: "https://api.moonshot.cn/anthropic",
    models: ["kimi-k2.6"] },
  { name: "MiniMax",   baseUrl: "https://api.minimaxi.com/anthropic",
    models: ["MiniMax-M2.7"] },
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1",
    models: ["anthropic/claude-sonnet-4", "openai/gpt-4o", "google/gemini-2.5-flash"] },
]

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
    for (const [name, p] of Object.entries(draft.providers)) {
      if (!p.apiKeyNewValue.trim()) continue
      const r = await writePersonalValue({ vault: `provider-keys/${name}` }, p.apiKeyNewValue.trim())
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
        apiKey: { vault: `provider-keys/${name}` },
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
          <div key={name} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            {/* Provider header */}
            <div className="flex items-center gap-3 px-4 py-2.5 bg-gray-50/50 border-b border-gray-100">
              <label
                className={`flex items-center gap-2 flex-1 min-w-0 select-none ${hasKey ? "cursor-pointer" : ""}`}
                title={hasKey ? undefined : "set an API key to enable this provider"}
              >
                <input
                  type="checkbox"
                  checked={p.enabled}
                  onChange={(e) => hasKey ? updateProv(name, { enabled: e.target.checked }) : undefined}
                  disabled={!hasKey}
                  className="h-3.5 w-3.5 rounded"
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
                    className="ip text-[13px] font-semibold flex-1 min-w-0"
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
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-400 font-medium shrink-0">disabled</span>
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
                    className="ip"
                  />
                </Labeled>
                <Labeled label="Max context tokens">
                  <input
                    type="number"
                    value={p.maxContextTokens}
                    onChange={(e) => updateProv(name, { maxContextTokens: e.target.value })}
                    placeholder="auto"
                    className="ip"
                  />
                </Labeled>
                <Labeled label={p.apiKeyStored ? "API key (set — type to overwrite)" : "API key"} className="sm:col-span-2">
                  <input
                    type="password"
                    value={p.apiKeyNewValue}
                    onChange={(e) => updateProv(name, { apiKeyNewValue: e.target.value })}
                    placeholder={p.apiKeyStored ? "•••••• stored encrypted in vault" : "paste API key"}
                    className="ip"
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
                      className="ip flex-1 text-[11px]"
                    />
                    <button onClick={() => addModel(name)} className="px-2.5 h-6 rounded bg-gray-900 text-white text-[10px] font-medium hover:bg-gray-700">add</button>
                    <button onClick={() => setAddingModel((a) => ({ ...a, [name]: false }))} className="text-[10px] text-gray-400 hover:text-gray-600">cancel</button>
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
                      <label className="flex items-center gap-1.5 flex-1 min-w-0 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={m.enabled !== false}
                          onChange={() => toggleModel(name, m.id)}
                          className="h-3 w-3 rounded shrink-0"
                        />
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
                            className="ip text-[11px] flex-1 min-w-0"
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
                          <span className="text-[9px] text-gray-300 font-medium shrink-0">off</span>
                        )}
                      </label>
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
                        className={`shrink-0 text-[9px] px-1 py-0 rounded transition-colors ${
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
            className="ip flex-1"
          />
          <button onClick={addProvider} className="px-2.5 h-7 rounded bg-gray-900 text-white text-xs hover:bg-gray-700">add</button>
          <button onClick={() => { setAdding(false); setNewName("") }} className="text-xs text-gray-400 hover:text-gray-700">cancel</button>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="self-start text-xs text-gray-500 hover:text-gray-900 inline-flex items-center gap-1"
        >
          <Plus size={12} /> add custom provider
        </button>
      )}

      <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-100">
        {err && <span className="text-[11px] text-red-600">{err}</span>}
        <button
          onClick={save}
          disabled={saving || disabled}
          className="px-3 h-8 rounded bg-gray-900 text-white text-xs hover:bg-gray-700 disabled:opacity-50"
        >
          {saving ? "saving…" : "save providers"}
        </button>
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
// Envs
// ────────────────────────────────────────────────────────────────────────────

type EnvDraft = {
  key: string
  encrypted: boolean
  /** Plain value (used when !encrypted). */
  literal: string
  /** New encrypted value typed by the user — empty = keep existing. */
  newValue: string
  /** Was the encrypted value already stored on disk? Display only. */
  stored: boolean
}

function EnvsSection({ disk, refExists, onChanged, disabled }: {
  disk: PersonalConfigDisk | null
  refExists: RefExistsMap
  onChanged: () => void
  disabled?: boolean
}) {
  const [rows, setRows] = useState<EnvDraft[]>([])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!disk) { setRows([]); return }
    const out: EnvDraft[] = []
    for (const [k, v] of Object.entries(disk.envs ?? {})) {
      const refInfo = refExists[`envs.${k}`]
      if (typeof v === "string") {
        out.push({ key: k, encrypted: false, literal: v, newValue: "", stored: false })
      } else {
        out.push({ key: k, encrypted: true, literal: "", newValue: "", stored: !!refInfo?.exists })
      }
    }
    setRows(out)
  }, [disk, refExists])

  const update = (i: number, patch: Partial<EnvDraft>) => {
    setRows((rs) => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r))
  }
  const remove = (i: number) => setRows((rs) => rs.filter((_, idx) => idx !== i))
  const add = () => setRows((rs) => [...rs, { key: "", encrypted: true, literal: "", newValue: "", stored: false }])

  const save = async () => {
    setSaving(true)
    setErr(null)
    // Validate keys
    const seen = new Set<string>()
    for (const r of rows) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.key)) { setErr(`invalid env name "${r.key}"`); setSaving(false); return }
      if (seen.has(r.key)) { setErr(`duplicate env name "${r.key}"`); setSaving(false); return }
      seen.add(r.key)
    }
    // Best practice: encrypted envs always live at
    //   <active vault>/envs/<envName>
    // The user toggles encrypted on/off; we own the storage layout.
    for (const r of rows) {
      if (!r.encrypted) continue
      if (!r.newValue.trim()) continue
      const wr = await writePersonalValue({ vault: `envs/${r.key}` }, r.newValue.trim())
      if (!wr.ok) { setErr(`value write failed for ${r.key}: ${wr.error}`); setSaving(false); return }
    }
    const envs: Record<string, ConfigValue> = {}
    for (const r of rows) {
      envs[r.key] = r.encrypted ? { vault: `envs/${r.key}` } : r.literal
    }
    const res = await savePersonalDisk({ envs })
    setSaving(false)
    if (!res.ok) { setErr(res.error ?? "save failed"); return }
    onChanged()
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 && (
        <div className="text-[12px] text-gray-400 italic">no environment variables</div>
      )}
      {rows.map((r, i) => (
        <div key={i} className="border border-gray-200 rounded-md p-3 grid grid-cols-1 sm:grid-cols-[200px_1fr_auto_auto] gap-2.5 items-start">
          <Labeled label="Name">
            <input
              value={r.key}
              onChange={(e) => update(i, { key: e.target.value })}
              placeholder="ENV_NAME"
              className="ip font-mono"
            />
          </Labeled>
          <Labeled label={r.encrypted ? (r.stored ? "Value (set — type to overwrite)" : "Value") : "Value (plain text)"}>
            {r.encrypted ? (
              <input
                type="password"
                value={r.newValue}
                onChange={(e) => update(i, { newValue: e.target.value })}
                placeholder={r.stored ? "•••••• stored encrypted in vault" : "type secret value"}
                className="ip"
              />
            ) : (
              <input
                value={r.literal}
                onChange={(e) => update(i, { literal: e.target.value })}
                placeholder="value"
                className="ip"
              />
            )}
          </Labeled>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-gray-500">{r.encrypted ? "🔒 Encrypted" : "Encryption"}</span>
            <label className="flex items-center gap-1.5 h-[34px] text-[12px] text-gray-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={r.encrypted}
                onChange={(e) => update(i, { encrypted: e.target.checked, newValue: "", stored: false })}
              />
              <span>{r.encrypted ? "stored encrypted" : "plain text"}</span>
            </label>
          </div>
          <button
            onClick={() => remove(i)}
            className="self-start h-[34px] mt-[19px] w-7 flex items-center justify-center text-gray-400 hover:text-red-600 rounded"
            title="remove"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button
        onClick={add}
        className="self-start text-xs text-gray-500 hover:text-gray-900 inline-flex items-center gap-1"
      >
        <Plus size={12} /> add env var
      </button>
      <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-100">
        {err && <span className="text-[11px] text-red-600">{err}</span>}
        <button
          onClick={save}
          disabled={saving || disabled}
          className="px-3 h-8 rounded bg-gray-900 text-white text-xs hover:bg-gray-700 disabled:opacity-50"
        >
          {saving ? "saving…" : "save env"}
        </button>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Mounts
// ────────────────────────────────────────────────────────────────────────────

type MountRow = {
  /** "vault" → src is `{vault: path}`; "personal" → src is `path`. */
  source: "vault" | "personal"
  path: string
  dst: string
  rw: boolean
  /** User has manually edited dst → don't auto-derive anymore. */
  dstTouched: boolean
}

function MountsSection({ disk, onChanged, disabled }: {
  disk: PersonalConfigDisk | null
  onChanged: () => void
  disabled?: boolean
}) {
  const [rows, setRows] = useState<MountRow[]>([])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [vaultEntries, setVaultEntries] = useState<PersonalEntry[]>([])
  const [personalEntries, setPersonalEntries] = useState<PersonalEntry[]>([])

  useEffect(() => {
    Promise.all([listPersonalEntries("vault"), listPersonalEntries("personal")]).then(([v, p]) => {
      setVaultEntries(v)
      setPersonalEntries(p)
    })
  }, [])

  useEffect(() => {
    if (!disk) { setRows([]); return }
    const next: MountRow[] = []
    for (const m of disk.mounts ?? []) {
      if (typeof m.src === "string") {
        next.push({ source: "personal", path: m.src, dst: m.dst, rw: !!m.rw, dstTouched: true })
      } else if (m.src && typeof m.src === "object" && "vault" in m.src) {
        next.push({ source: "vault", path: (m.src as any).vault, dst: m.dst, rw: !!m.rw, dstTouched: true })
      }
    }
    setRows(next)
  }, [disk])

  const deriveDst = (path: string): string => {
    if (!path) return "$HOME/"
    return `$HOME/${path}`
  }

  const update = (i: number, patch: Partial<MountRow>) => {
    setRows((rs) => rs.map((r, idx) => {
      if (idx !== i) return r
      const next = { ...r, ...patch }
      // Re-derive dst when path or source changes, unless the user has
      // manually edited dst.
      if (("path" in patch || "source" in patch) && !next.dstTouched) {
        next.dst = deriveDst(next.path)
      }
      return next
    }))
  }
  const remove = (i: number) => setRows((rs) => rs.filter((_, idx) => idx !== i))
  const add = () => setRows((rs) => [...rs, { source: "vault", path: "", dst: "$HOME/", rw: false, dstTouched: false }])

  const save = async () => {
    setSaving(true)
    setErr(null)
    const out: MountDisk[] = []
    for (const r of rows) {
      if (!r.path) { setErr("pick a source path for every mount"); setSaving(false); return }
      if (!r.dst || (!r.dst.startsWith("$HOME") && !r.dst.startsWith("~") && !r.dst.startsWith("/"))) {
        setErr(`mount dst "${r.dst}" must start with $HOME/ ~/ or /`)
        setSaving(false)
        return
      }
      out.push({
        src: r.source === "vault" ? { vault: r.path } : r.path,
        dst: r.dst,
        ...(r.rw ? { rw: true } : {}),
      })
    }
    const res = await savePersonalDisk({ mounts: out })
    setSaving(false)
    if (!res.ok) { setErr(res.error ?? "save failed"); return }
    onChanged()
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 && <div className="text-[12px] text-gray-400 italic">no mounts</div>}
      {rows.map((r, i) => {
        const entries = r.source === "vault" ? vaultEntries : personalEntries
        const listId = `mount-paths-${i}`
        return (
          <div key={i} className="border border-gray-200 rounded-md p-3 grid grid-cols-1 sm:grid-cols-[160px_1fr_1fr_auto_auto] gap-2.5 items-start">
            <Labeled label="Source">
              <select
                value={r.source}
                onChange={(e) => update(i, { source: e.target.value as MountRow["source"], path: "" })}
                className="ip"
              >
                <option value="vault">Vault (encrypted)</option>
                <option value="personal">Personal (plain)</option>
              </select>
            </Labeled>
            <Labeled label="Path">
              <input
                list={listId}
                value={r.path}
                onChange={(e) => update(i, { path: e.target.value })}
                placeholder={r.source === "vault" ? "pick from vault…" : "pick from personal…"}
                className="ip font-mono"
              />
              <datalist id={listId}>
                {entries.map((e) => (
                  <option key={e.path} value={e.path}>{e.type === "dir" ? "📁" : "📄"} {e.path}</option>
                ))}
              </datalist>
            </Labeled>
            <Labeled label="Mount inside sandbox at">
              <input
                value={r.dst}
                onChange={(e) => update(i, { dst: e.target.value, dstTouched: true })}
                placeholder="$HOME/.config/foo"
                className="ip font-mono"
              />
            </Labeled>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-gray-500">Access</span>
              <label className="flex items-center gap-1.5 h-[34px] text-[12px] text-gray-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={r.rw}
                  onChange={(e) => update(i, { rw: e.target.checked })}
                />
                <span>read-write</span>
              </label>
            </div>
            <button
              onClick={() => remove(i)}
              className="self-start h-[34px] mt-[19px] w-7 flex items-center justify-center text-gray-400 hover:text-red-600 rounded"
              title="remove"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )
      })}
      <button
        onClick={add}
        className="self-start text-xs text-gray-500 hover:text-gray-900 inline-flex items-center gap-1"
      >
        <Plus size={12} /> add mount
      </button>
      <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-100">
        {err && <span className="text-[11px] text-red-600">{err}</span>}
        <button
          onClick={save}
          disabled={saving || disabled}
          className="px-3 h-8 rounded bg-gray-900 text-white text-xs hover:bg-gray-700 disabled:opacity-50"
        >
          {saving ? "saving…" : "save mounts"}
        </button>
      </div>
    </div>
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
    <div className="flex flex-col gap-3">
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
                className="ip font-mono"
              />
            )}
          </div>
        </label>
      </div>
      <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-100">
        {err && <span className="text-[11px] text-red-600">{err}</span>}
        {saved && !err && <span className="text-[11px] text-emerald-700 flex items-center gap-1"><Check size={12} /> saved</span>}
        <button
          onClick={save}
          disabled={saving || disabled}
          className="px-3 h-8 rounded bg-gray-900 text-white text-xs hover:bg-gray-700 disabled:opacity-50"
        >
          {saving ? "saving…" : "save shell"}
        </button>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// MCP section — thin wrapper over the shared McpStatusPanel. Adds the
// "auth completed" flash for the OAuth redirect-back, since this is the
// landing page after a successful /api/mcp-auth/callback round-trip.
// ────────────────────────────────────────────────────────────────────────────

function McpSection({ disabled }: { disabled: boolean }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [flash, setFlash] = useState<{ kind: "ok" | "error"; text: string } | null>(null)

  useEffect(() => {
    const s = searchParams.get("status")
    if (!s) return
    if (s === "ok") {
      const server = searchParams.get("server") ?? ""
      setFlash({ kind: "ok", text: `Connected to ${server} ✓` })
    } else if (s === "error") {
      const reason = searchParams.get("reason") ?? "unknown error"
      setFlash({ kind: "error", text: `Auth failed: ${reason}` })
    }
    const next = new URLSearchParams(searchParams)
    next.delete("status"); next.delete("server"); next.delete("reason")
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={disabled ? "pointer-events-none opacity-50" : ""}>
      {flash && (
        <div
          className={`mb-3 rounded px-3 py-2 text-[12px] ${
            flash.kind === "ok"
              ? "bg-green-50 text-green-800 border border-green-200"
              : "bg-red-50 text-red-800 border border-red-200"
          }`}
        >
          {flash.text}
        </div>
      )}
      <McpStatusPanel variant="settings" />
    </div>
  )
}
