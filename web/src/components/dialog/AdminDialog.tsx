import { useState, useEffect, useCallback } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
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

function UsersPanel({ currentUserId }: { currentUserId: string }) {
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

// ── Workspace settings panel (formerly SettingsDialog's "Workspace" tab) ──

type ModelForm = { id: string; enabled: boolean }

type ProviderForm = {
  models: ModelForm[]
  baseUrl: string
  apiKey: string
  keyDirty: boolean
  enabled: boolean
}

function WorkspacePanel() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [, setWorkspace] = useState<WorkspaceSettings | null>(null)
  const [providers, setProviders] = useState<Record<string, ProviderForm>>({})
  const [def, setDef] = useState("")
  const [newProviderName, setNewProviderName] = useState("")
  const [addingProvider, setAddingProvider] = useState(false)
  const [newModelFor, setNewModelFor] = useState("")
  const [addingModelFor, setAddingModelFor] = useState("")

  useEffect(() => {
    setLoading(true)
    setError("")
    getWorkspaceSettings().then((w) => {
      setWorkspace(w)
      const forms: Record<string, ProviderForm> = {}
      for (const [name, prov] of Object.entries(w.providers)) {
        forms[name] = {
          models: (prov as any).models?.map((m: any) => ({ id: m.id, enabled: m.enabled !== false })) ?? [],
          baseUrl: prov.baseUrl ?? "",
          apiKey: "",
          keyDirty: false,
          enabled: (prov as any).enabled !== false,
        }
      }
      setProviders(forms)
      setDef(w.default ?? "")
    }).catch((e) => {
      setError(e?.message ?? "load failed")
    }).finally(() => setLoading(false))
  }, [])

  function updateProv(name: string, patch: Partial<ProviderForm>) {
    setProviders((prev) => {
      const updated = { ...prev }
      if (!updated[name]) return prev
      updated[name] = { ...updated[name], ...patch }
      return updated
    })
  }

  function handleChange(name: string, field: "baseUrl" | "apiKey", value: string) {
    setProviders((prev) => {
      const updated = { ...prev }
      if (!updated[name]) return prev
      const entry = { ...updated[name], [field]: value }
      if (field === "apiKey") entry.keyDirty = true
      updated[name] = entry
      return updated
    })
  }

  function handleRemove(name: string) {
    setProviders((prev) => {
      const updated = { ...prev }
      delete updated[name]
      return updated
    })
    setDef((prev) => (prev === name ? "" : prev))
  }

  function handleAdd() {
    const name = newProviderName.trim()
    if (!name) return
    if (providers[name]) { setError("provider name already exists"); return }
    setProviders((prev) => ({
      ...prev,
      [name]: { models: [], baseUrl: "", apiKey: "", keyDirty: false, enabled: false },
    }))
    setNewProviderName("")
    setAddingProvider(false)
    setError("")
  }

  function toggleModel(provName: string, modelId: string) {
    setProviders((prev) => {
      const p = prev[provName]
      if (!p) return prev
      return { ...prev, [provName]: { ...p, models: p.models.map(m => m.id === modelId ? { ...m, enabled: !m.enabled } : m) } }
    })
  }

  function addModel(provName: string) {
    const id = newModelFor.trim()
    if (!id) return
    setProviders((prev) => {
      const p = prev[provName]
      if (!p || p.models.some(m => m.id === id)) return prev
      return { ...prev, [provName]: { ...p, models: [...p.models, { id, enabled: true }] } }
    })
    setNewModelFor("")
    setAddingModelFor("")
  }

  function removeModel(provName: string, modelId: string) {
    setProviders((prev) => {
      const p = prev[provName]
      if (!p) return prev
      return { ...prev, [provName]: { ...p, models: p.models.filter(m => m.id !== modelId) } }
    })
  }

  async function handleSave() {
    setSaving(true); setError("")
    try {
      const out: Record<string, any> = {}
      for (const [name, f] of Object.entries(providers)) {
        const models = f.models.filter(m => m.id.trim()).map(m => ({ id: m.id.trim(), ...(m.enabled ? {} : { enabled: false }) }))
        out[name] = { models, baseUrl: f.baseUrl, enabled: f.enabled }
        if (f.keyDirty && f.apiKey) out[name].apiKey = f.apiKey
      }
      const ok = await updateWorkspaceSettings({ providers: out, default: def })
      if (!ok) setError("save failed")
      else {
        setProviders((prev) => {
          const updated = { ...prev }
          for (const k of Object.keys(updated)) {
            updated[k] = { ...updated[k], keyDirty: false, apiKey: "" }
          }
          return updated
        })
      }
    } catch (e: any) {
      setError(e?.message ?? "save failed")
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="text-sm text-gray-400 py-8 text-center">Loading…</div>

  const names = Object.keys(providers)

  return (
    <div className="flex flex-col gap-5 min-h-full">
      <div className="flex-1 flex flex-col gap-5">
        {names.map((name) => {
          const f = providers[name]!
          return (
            <div key={name} className="border border-gray-200 rounded-lg p-3 sm:p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={f.enabled}
                      onChange={(e) => updateProv(name, { enabled: e.target.checked })}
                      className="h-3.5 w-3.5"
                    />
                    <span className={`text-sm font-semibold ${f.enabled ? "text-gray-900" : "text-gray-400"}`}>{name}</span>
                  </label>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemove(name)}
                  className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                >
                  Remove
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Base URL</label>
                  <input
                    type="url"
                    value={f.baseUrl}
                    onChange={(e) => handleChange(name, "baseUrl", e.target.value)}
                    placeholder="https://api.example.com"
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">API Key</label>
                  <input
                    type="password"
                    value={f.apiKey}
                    onChange={(e) => handleChange(name, "apiKey", e.target.value)}
                    placeholder="API key"
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                  />
                </div>
              </div>

              {/* Model list */}
              <div className="border-t border-gray-100 pt-2.5">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-medium text-gray-500">Models ({f.models.length})</span>
                  <button
                    type="button"
                    onClick={() => setAddingModelFor(addingModelFor === name ? "" : name)}
                    className="text-[11px] text-gray-500 hover:text-gray-900 inline-flex items-center gap-1"
                  >
                    <span className="text-base leading-none">+</span> add model
                  </button>
                </div>

                {addingModelFor === name && (
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <input
                      type="text"
                      value={newModelFor}
                      onChange={(e) => setNewModelFor(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") addModel(name); if (e.key === "Escape") setAddingModelFor("") }}
                      placeholder="model ID"
                      autoFocus
                      className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                    />
                    <Button size="xs" onClick={() => addModel(name)}>Add</Button>
                    <button type="button" onClick={() => setAddingModelFor("")} className="text-[10px] text-gray-400 hover:text-gray-600">cancel</button>
                  </div>
                )}

                {f.models.length === 0 && addingModelFor !== name && (
                  <div className="text-[11px] text-gray-400 italic py-1">no models — add one above</div>
                )}
                {f.models.map((m) => (
                  <div key={m.id} className="flex items-center gap-2 py-1 group">
                    <label className="flex items-center gap-1.5 flex-1 min-w-0 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={m.enabled}
                        onChange={() => toggleModel(name, m.id)}
                        className="h-3 w-3 shrink-0"
                      />
                      <span className={`text-xs font-mono truncate ${m.enabled ? "text-gray-700" : "text-gray-300 line-through"}`}>
                        {m.id}
                      </span>
                    </label>
                    <button
                      type="button"
                      onClick={() => removeModel(name, m.id)}
                      className="text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                      title="remove model"
                    >
                      <span className="text-[10px]">✕</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )
        })}

        {addingProvider ? (
          <div className="border border-dashed border-gray-300 rounded-lg p-3 flex items-center gap-2">
            <input
              type="text"
              value={newProviderName}
              onChange={(e) => setNewProviderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAdd()
                if (e.key === "Escape") { setAddingProvider(false); setNewProviderName("") }
              }}
              placeholder="provider name"
              autoFocus
              className="flex-1 px-2.5 py-1.5 border border-gray-300 rounded text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
            />
            <Button size="xs" onClick={handleAdd}>Add</Button>
            <button
              type="button"
              onClick={() => { setAddingProvider(false); setNewProviderName("") }}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAddingProvider(true)}
            className="text-sm text-gray-500 hover:text-gray-900 transition-colors flex items-center gap-1"
          >
            <span className="text-base leading-none">+</span> Add Provider
          </button>
        )}

        {names.length > 0 && (
          <div className="pt-2 border-t border-gray-200">
            <label className="block text-sm font-medium text-gray-700 mb-1">Default Provider</label>
            <select
              value={def}
              onChange={(e) => setDef(e.target.value)}
              className="px-3 py-1.5 border border-gray-300 rounded-md text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900 bg-white"
            >
              <option value="">None</option>
              {names.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-200">
        {error && <span className="text-xs text-red-500">{error}</span>}
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  )
}

// ── Workspace Serve panel ──

function ServePanel() {
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
