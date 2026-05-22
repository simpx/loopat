import { useState, useEffect, useCallback } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Plus, Trash2 } from "lucide-react"
import {
  listAdminUsers,
  activateAdminUser,
  setAdminUserRole,
  deleteAdminUser,
  getWorkspaceSettings,
  updateWorkspaceSettings,
  getServeDomain,
  setServeDomain,
  type AdminUser,
  type WorkspaceSettings,
  type ModelEntry,
} from "@/api"

type Tab = "users" | "workspace" | "serve"

export function AdminDialog({
  open,
  onClose,
  currentUserId,
}: {
  open: boolean
  onClose: () => void
  currentUserId: string
}) {
  const [tab, setTab] = useState<Tab>("users")

  if (!open) return null

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent
        className="max-w-[95vw] sm:max-w-[760px] h-[85vh] sm:h-[80vh] p-0 gap-0 overflow-hidden flex flex-col"
        showCloseButton
      >
        <DialogHeader className="px-4 sm:px-6 pt-4 sm:pt-5 pb-0 shrink-0">
          <DialogTitle>Admin</DialogTitle>
          <DialogDescription className="sr-only">
            Workspace administration — manage users and shared configuration.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-0 px-4 sm:px-6 pt-4 border-b border-gray-200 shrink-0">
          <TabButton active={tab === "users"} onClick={() => setTab("users")}>Users</TabButton>
          <TabButton active={tab === "workspace"} onClick={() => setTab("workspace")}>Workspace</TabButton>
          <TabButton active={tab === "serve"} onClick={() => setTab("serve")}>Workspace Serve</TabButton>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5">
          {tab === "users" ? (
            <UsersPanel currentUserId={currentUserId} />
          ) : tab === "workspace" ? (
            <WorkspacePanel />
          ) : (
            <ServePanel />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 sm:px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
        active
          ? "border-gray-900 text-gray-900"
          : "border-transparent text-gray-500 hover:text-gray-700"
      }`}
    >
      {children}
    </button>
  )
}

export function UsersPanel({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [busyId, setBusyId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const list = await listAdminUsers()
      setUsers(list)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { reload() }, [reload])

  const adminCount = users.filter((u) => u.role === "admin").length

  async function activate(id: string) {
    setBusyId(id); setError("")
    try {
      const r = await activateAdminUser(id)
      if (!r.ok) { setError(r.error ?? "activate failed"); return }
      await reload()
    } finally { setBusyId(null) }
  }

  async function toggleRole(u: AdminUser) {
    const next = u.role === "admin" ? "member" : "admin"
    setBusyId(u.id); setError("")
    try {
      const r = await setAdminUserRole(u.id, next)
      if (!r.ok) { setError(r.error ?? "role change failed"); return }
      await reload()
    } finally { setBusyId(null) }
  }

  async function remove(u: AdminUser) {
    if (!confirm(`Delete user ${u.id}? Entry in users.json will be removed; personal/${u.id}/ on disk is preserved.`)) return
    setBusyId(u.id); setError("")
    try {
      const r = await deleteAdminUser(u.id)
      if (!r.ok) { setError(r.error ?? "delete failed"); return }
      await reload()
    } finally { setBusyId(null) }
  }

  if (loading) return <div className="text-sm text-gray-400 py-8 text-center">Loading…</div>

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
          {error}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 border-b border-gray-200">
            <tr>
              <th className="text-left font-medium py-2 pr-2">User</th>
              <th className="text-left font-medium py-2 pr-2">Role</th>
              <th className="text-left font-medium py-2 pr-2">Status</th>
              <th className="text-left font-medium py-2 pr-2">Created</th>
              <th className="text-right font-medium py-2 pl-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isMe = u.id === currentUserId
              const lastAdmin = u.role === "admin" && adminCount <= 1
              const busy = busyId === u.id
              return (
                <tr key={u.id} className="border-b border-gray-100 last:border-b-0">
                  <td className="py-2 pr-2">
                    <span className="font-medium text-gray-900">{u.id}</span>
                    {isMe && <span className="ml-1.5 text-[10px] text-gray-400">(you)</span>}
                  </td>
                  <td className="py-2 pr-2">
                    <RoleBadge role={u.role} />
                  </td>
                  <td className="py-2 pr-2">
                    <StatusBadge status={u.status} />
                  </td>
                  <td className="py-2 pr-2 text-xs text-gray-500">
                    {u.createdAt.slice(0, 10)}
                  </td>
                  <td className="py-2 pl-2 text-right space-x-1">
                    {u.status === "pending" && (
                      <Button size="xs" onClick={() => activate(u.id)} disabled={busy}>
                        Activate
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => toggleRole(u)}
                      disabled={busy || lastAdmin}
                      title={lastAdmin ? "cannot demote the last admin" : undefined}
                    >
                      {u.role === "admin" ? "Demote" : "Promote"}
                    </Button>
                    <button
                      type="button"
                      onClick={() => remove(u)}
                      disabled={busy || isMe || lastAdmin}
                      title={
                        isMe ? "cannot delete yourself"
                        : lastAdmin ? "cannot delete the last admin"
                        : undefined
                      }
                      className="text-xs text-gray-500 hover:text-red-500 disabled:text-gray-300 disabled:cursor-not-allowed px-1.5"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              )
            })}
            {users.length === 0 && (
              <tr><td colSpan={5} className="text-center py-8 text-gray-400 text-sm">no users</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function RoleBadge({ role }: { role: "admin" | "member" }) {
  const cls = role === "admin"
    ? "bg-violet-50 text-violet-700 border-violet-200"
    : "bg-gray-50 text-gray-600 border-gray-200"
  return (
    <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded border ${cls}`}>{role}</span>
  )
}

function StatusBadge({ status }: { status: "active" | "pending" }) {
  const cls = status === "active"
    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : "bg-amber-50 text-amber-700 border-amber-200"
  return (
    <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded border ${cls}`}>{status}</span>
  )
}

// ── Workspace settings panel — matches the personal ProvidersSection UI ──

/** Preset providers — kept in sync with server/src/config.ts PRESET_PROVIDERS. */
const WS_PRESETS: Array<{ name: string; baseUrl: string; models: string[] }> = [
  { name: "Anthropic", baseUrl: "https://api.anthropic.com",
    models: ["claude-sonnet-4-20250514", "claude-opus-4-7-20251101"] },
  { name: "DeepSeek",  baseUrl: "https://api.deepseek.com/anthropic",
    models: ["deepseek-v4-pro", "deepseek-v4-flash"] },
  { name: "Kimi",      baseUrl: "https://api.moonshot.cn/anthropic",
    models: ["kimi-k2.6"] },
  { name: "MiniMax",   baseUrl: "https://api.minimaxi.com/anthropic",
    models: ["MiniMax-M2.7"] },
]

type WorkspaceDraft = {
  default: string
  providers: Record<string, {
    models: ModelEntry[]
    baseUrl: string
    maxContextTokens?: number
    apiKey: string
    keyDirty: boolean
    enabled: boolean
  }>
}

export function WorkspacePanel() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [draft, setDraft] = useState<WorkspaceDraft | null>(null)
  const [newName, setNewName] = useState("")
  const [adding, setAdding] = useState(false)
  const [newModelName, setNewModelName] = useState<Record<string, string>>({})
  const [addingModel, setAddingModel] = useState<Record<string, boolean>>({})

  useEffect(() => {
    setLoading(true)
    setErr(null)
    getWorkspaceSettings().then((w) => {
      const next: WorkspaceDraft = { default: w.default ?? "", providers: {} }
      for (const [name, prov] of Object.entries(w.providers)) {
        next.providers[name] = {
          models: (prov as any).models?.map((m: any) => ({
            id: m.id,
            enabled: m.enabled !== false,
            ...(m.maxContextTokens && m.maxContextTokens > 0 ? { maxContextTokens: m.maxContextTokens } : {}),
          })) ?? [],
          baseUrl: prov.baseUrl ?? "",
          maxContextTokens: (prov as any).maxContextTokens || undefined,
          apiKey: "",
          keyDirty: false,
          enabled: (prov as any).enabled !== false,
        }
      }
      setDraft(next)
    }).catch((e) => {
      setErr(e?.message ?? "load failed")
    }).finally(() => setLoading(false))
  }, [])

  const names = draft ? Object.keys(draft.providers) : []

  const updateProv = (name: string, patch: Partial<WorkspaceDraft["providers"][string]>) => {
    setDraft((d) => {
      if (!d || !d.providers[name]) return d
      return { ...d, providers: { ...d.providers, [name]: { ...d.providers[name], ...patch } } }
    })
  }

  const remove = (name: string) => {
    setDraft((d) => {
      if (!d) return d
      const { [name]: _, ...rest } = d.providers
      return { ...d, providers: rest, default: d.default === name ? "" : d.default }
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
      return { ...d, providers: { ...d.providers, [provName]: { ...d.providers[provName], models } } }
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

  const addProvider = () => {
    const n = newName.trim()
    if (!n) return
    if (draft?.providers[n]) { setErr("provider name already exists"); return }
    setDraft((d) => {
      if (!d) return d
      return { ...d, providers: { ...d.providers, [n]: {
        models: [], baseUrl: "", apiKey: "", keyDirty: false, enabled: false,
      } } }
    })
    setNewName("")
    setAdding(false)
    setErr(null)
  }

  const save = async () => {
    if (!draft) return
    setSaving(true); setErr(null)
    try {
      const out: Record<string, any> = {}
      for (const [name, p] of Object.entries(draft.providers)) {
        const models = p.models
          .filter(m => m.id.trim())
          .map(m => ({
            id: m.id.trim(),
            ...(m.enabled ? {} : { enabled: false }),
            ...(m.maxContextTokens && m.maxContextTokens > 0 ? { maxContextTokens: m.maxContextTokens } : {}),
          }))
        out[name] = {
          models,
          baseUrl: p.baseUrl,
          enabled: p.enabled,
          ...(p.maxContextTokens && p.maxContextTokens > 0 ? { maxContextTokens: p.maxContextTokens } : {}),
        }
        if (p.keyDirty && p.apiKey.trim()) out[name].apiKey = p.apiKey.trim()
      }
      const ok = await updateWorkspaceSettings({ providers: out, default: draft.default })
      if (!ok) { setErr("save failed"); return }
      setDraft((d) => {
        if (!d) return d
        const next = { ...d, providers: { ...d.providers } }
        for (const k of Object.keys(next.providers)) {
          next.providers[k] = { ...next.providers[k], keyDirty: false, apiKey: "" }
        }
        return next
      })
    } catch (e: any) {
      setErr(e?.message ?? "save failed")
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="text-[12px] text-gray-400 italic py-12 text-center">loading…</div>
  if (!draft) return null

  return (
    <div className="flex flex-col gap-3">
      <style>{`.ip { width: 100%; padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 13px; outline: none; background: white; } .ip:focus { border-color: #111827; } .ip:disabled { background: #f3f4f6; color: #9ca3af; }`}</style>

      {names.map((name) => {
        const p = draft.providers[name]
        const isAddingModel = addingModel[name] ?? false
        return (
          <div key={name} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            {/* Provider header */}
            <div className="flex items-center gap-3 px-4 py-2.5 bg-gray-50/50 border-b border-gray-100">
              <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={p.enabled}
                  onChange={(e) => updateProv(name, { enabled: e.target.checked })}
                  className="h-3.5 w-3.5 rounded"
                />
                <span className={`text-[13px] font-semibold truncate ${p.enabled ? "text-gray-900" : "text-gray-400"}`}>
                  {name}
                </span>
                {!p.enabled && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-400 font-medium">disabled</span>
                )}
              </label>
              <label className={`text-[10px] px-1.5 py-0.5 rounded cursor-pointer select-none font-medium transition-colors ${
                draft.default === name
                  ? "bg-blue-500 text-white"
                  : "bg-gray-100 text-gray-500 hover:bg-gray-200"
              }`}>
                <input
                  type="radio"
                  name="ws-default-provider"
                  checked={draft.default === name}
                  onChange={() => setDraft((d) => d ? { ...d, default: name } : d)}
                  className="hidden"
                />
                {draft.default === name ? "default" : "set default"}
              </label>
              <button
                type="button"
                onClick={() => remove(name)}
                className="text-[11px] text-gray-400 hover:text-red-500 transition-colors"
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
                    value={p.maxContextTokens ?? ""}
                    onChange={(e) => updateProv(name, { maxContextTokens: e.target.value ? Number(e.target.value) : undefined })}
                    placeholder="auto"
                    className="ip"
                  />
                </Labeled>
                <Labeled label="API Key" className="sm:col-span-2">
                  <input
                    type="password"
                    value={p.apiKey}
                    onChange={(e) => updateProv(name, { apiKey: e.target.value, keyDirty: true })}
                    placeholder="API key"
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
                  {p.models.map((m) => (
                    <div key={m.id} className="flex items-center gap-2 px-1 py-1.5 rounded group hover:bg-gray-50 transition-colors">
                      <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={m.enabled !== false}
                          onChange={() => toggleModel(name, m.id)}
                          className="h-3 w-3 rounded shrink-0"
                        />
                        <code className={`text-[12px] truncate ${m.enabled !== false ? "text-gray-700" : "text-gray-300 line-through"}`}>
                          {m.id}
                        </code>
                        {m.enabled === false && (
                          <span className="text-[9px] text-gray-300 font-medium shrink-0">off</span>
                        )}
                      </label>
                      <input
                        type="number"
                        value={m.maxContextTokens ?? ""}
                        onChange={(e) => updateModel(name, m.id, { maxContextTokens: e.target.value ? Number(e.target.value) : undefined })}
                        placeholder="auto"
                        className={`w-28 px-1.5 py-0.5 border border-gray-200 rounded text-[10px] outline-none focus:border-gray-400 shrink-0 ${m.maxContextTokens ? "" : "opacity-0 group-hover:opacity-100 transition-opacity"}`}
                        title="max context tokens (empty = auto)"
                      />
                      <button
                        type="button"
                        onClick={() => removeModel(name, m.id)}
                        className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                        title="remove model"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )
      })}

      {/* Preset provider shortcuts */}
      <div className="flex flex-wrap items-center gap-1.5">
        {WS_PRESETS.filter((p) => !draft.providers[p.name]).map((p) => (
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
                      apiKey: "",
                      keyDirty: false,
                      enabled: false,
                    } satisfies WorkspaceDraft["providers"][string],
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
          disabled={saving}
          className="px-3 h-8 rounded bg-gray-900 text-white text-xs hover:bg-gray-700 disabled:opacity-50"
        >
          {saving ? "saving…" : "save providers"}
        </button>
      </div>
    </div>
  )
}

function Labeled({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ""}`}>
      <span className="text-[11px] font-medium text-gray-500">{label}</span>
      {children}
    </label>
  )
}

// ── Workspace Serve panel ──

export function ServePanel() {
  const [domain, setDomainState] = useState("")
  const [ip, setServeIp] = useState("")
  const [baseUrl, setServeBaseUrl] = useState("")
  const [withPort, setServeWithPort] = useState(false)
  const [https, setServeHttps] = useState(false)
  const [displayPort, setServeDisplayPort] = useState(7788)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    getServeDomain().then((d) => {
      setDomainState(d.domain)
      setServeIp(d.ip)
      setServeBaseUrl(d.baseUrl)
      setServeWithPort(d.withPort ?? false)
      setServeHttps(d.https ?? false)
      setServeDisplayPort(d.displayPort ?? 7788)
    }).catch((e) => {
      setError(e?.message ?? "load failed")
    })
  }, [])

  async function handleSave() {
    setSaving(true); setError("")
    try {
      const ok = await setServeDomain({
        domain: domain.trim(),
        withPort,
        https,
        displayPort,
      })
      if (!ok) { setError("save failed"); return }
      const d = await getServeDomain()
      setDomainState(d.domain)
      setServeIp(d.ip)
      setServeBaseUrl(d.baseUrl)
      setServeWithPort(d.withPort)
      setServeHttps(d.https)
      setServeDisplayPort(d.displayPort)
    } catch (e: any) {
      setError(e?.message ?? "save failed")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 min-h-full">
      <div className="flex-1">
        <label className="block text-sm font-medium text-gray-700 mb-1">Domain Suffix</label>
        <input
          type="text"
          value={domain}
          onChange={(e) => setDomainState(e.target.value)}
          placeholder="nip.io"
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
        />
        <p className="text-xs text-gray-400 mt-1">
          Workspace sharing URLs: <code className="bg-gray-50 px-1 rounded">&lt;alias&gt;{baseUrl}</code>
        </p>
        <p className="text-xs text-gray-400 mt-1">
          Only <code className="bg-gray-50 px-1 rounded">nip.io</code> requires IP prefix. Custom domains use direct subdomain.
        </p>
      </div>

      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={https}
            onChange={(e) => setServeHttps(e.target.checked)}
            className="rounded border-gray-300"
          />
          HTTPS
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={withPort}
            onChange={(e) => setServeWithPort(e.target.checked)}
            className="rounded border-gray-300"
          />
          Show port in URL
        </label>
      </div>

      {withPort && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Display Port</label>
          <input
            type="number"
            value={displayPort}
            onChange={(e) => setServeDisplayPort(parseInt(e.target.value, 10) || 7788)}
            placeholder="7788"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
          />
          <p className="text-xs text-gray-400 mt-1">
            Port shown in share URL (does not change actual server listen port).
          </p>
        </div>
      )}

      <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-200">
        {error && <span className="text-xs text-red-500">{error}</span>}
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  )
}
