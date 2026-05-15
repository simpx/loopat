import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  getPersonalSettings,
  updatePersonalSettings,
  getTeamSettings,
  updateTeamSettings,
  getDailyTokenUsage,
  type PersonalSettings,
  type TeamSettings,
  type TokenUsage,
  type DailyUsage,
} from "@/api"

type Category = "personal" | "team"
type SidebarTab = "models" | "notifications"

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function TokenUsageDisplay({ usage, modelName }: { usage: TokenUsage; modelName: string }) {
  const entry = usage[modelName]
  if (!entry) return <span className="text-xs text-gray-400">no usage yet</span>
  return (
    <span className="text-xs text-gray-500">
      <span title={`${entry.inputTokens.toLocaleString()} input tokens`}>in: {formatTokens(entry.inputTokens)}</span>
      {" · "}
      <span title={`${entry.outputTokens.toLocaleString()} output tokens`}>out: {formatTokens(entry.outputTokens)}</span>
    </span>
  )
}

function DailyChart({ daily, modelName }: { daily: DailyUsage; modelName: string }) {
  const modelData = daily[modelName]
  if (!modelData) return null

  const dates = Object.keys(modelData).sort()
  if (dates.length === 0) return null

  // Show last 14 days
  const shown = dates.slice(-14)
  const maxTokens = Math.max(
    1,
    ...shown.map((d) => modelData[d].inputTokens + modelData[d].outputTokens),
  )

  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <p className="text-xs font-medium text-gray-500 mb-2">Daily Usage (last 14 days)</p>
      <div className="flex items-end gap-[2px] h-16 sm:h-20">
        {shown.map((date) => {
          const d = modelData[date]
          const total = d.inputTokens + d.outputTokens
          const hPct = Math.max(4, (total / maxTokens) * 100)
          const inPct = total > 0 ? (d.inputTokens / total) * 100 : 50
          const label = date.slice(5) // "05-14"
          return (
            <div
              key={date}
              className="flex-1 flex flex-col items-center justify-end h-full group relative min-w-0"
            >
              <div
                className="w-full rounded-sm overflow-hidden flex flex-col justify-end"
                style={{ height: `${hPct}%` }}
                title={`${date}\ninput: ${d.inputTokens.toLocaleString()}\noutput: ${d.outputTokens.toLocaleString()}`}
              >
                <div
                  className="w-full bg-gray-600"
                  style={{ height: `${inPct}%` }}
                />
                <div
                  className="w-full bg-gray-300"
                  style={{ height: `${100 - inPct}%` }}
                />
              </div>
              <span className="text-[8px] sm:text-[10px] text-gray-400 mt-1 leading-none truncate max-w-full">{label}</span>
              {/* Tooltip */}
              <div className="absolute bottom-full mb-1 hidden group-hover:block bg-gray-900 text-white text-[10px] rounded px-2 py-1 whitespace-nowrap z-10">
                {date}: in {formatTokens(d.inputTokens)} out {formatTokens(d.outputTokens)}
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-3 mt-2 text-[10px] text-gray-400">
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-gray-600" /> input</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-gray-300" /> output</span>
      </div>
    </div>
  )
}

type ProviderForm = {
  model: string
  baseUrl: string
  apiKey: string
  maxContextTokens: string
  keyDirty: boolean
}

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [category, setCategory] = useState<Category>("personal")
  const [sidebar, setSidebar] = useState<SidebarTab>("models")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  // Personal settings
  const [personal, setPersonal] = useState<PersonalSettings | null>(null)
  const [personalProviders, setPersonalProviders] = useState<Record<string, ProviderForm>>({})
  const [personalDefault, setPersonalDefault] = useState("")
  const [webhookUrl, setWebhookUrl] = useState("")

  // Team settings
  const [team, setTeam] = useState<TeamSettings | null>(null)
  const [teamProviders, setTeamProviders] = useState<Record<string, ProviderForm>>({})
  const [teamDefault, setTeamDefault] = useState("")

  // New provider form
  const [newProviderName, setNewProviderName] = useState("")
  const [addingProvider, setAddingProvider] = useState(false)

  // Key edit state: { providerName: true }
  const [editingKeys, setEditingKeys] = useState<Record<string, boolean>>({})

  // Daily usage chart data
  const [dailyUsage, setDailyUsage] = useState<DailyUsage>({})

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError("")
    Promise.all([
      getPersonalSettings().catch(() => null),
      getTeamSettings().catch(() => null),
      getDailyTokenUsage().catch(() => ({})),
    ]).then(([p, t, daily]) => {
      if (p) {
        setPersonal(p)
        const forms: Record<string, ProviderForm> = {}
        for (const [name, prov] of Object.entries(p.providers)) {
          forms[name] = {
            model: prov.model ?? "",
            baseUrl: prov.baseUrl ?? "",
            apiKey: "",
            maxContextTokens: prov.maxContextTokens ? String(prov.maxContextTokens) : "",
            keyDirty: false,
          }
        }
        setPersonalProviders(forms)
        setPersonalDefault(p.default ?? "")
        setWebhookUrl(p.webhookUrl ?? "")
      }
      if (t) {
        setTeam(t)
        const forms: Record<string, ProviderForm> = {}
        for (const [name, prov] of Object.entries(t.providers)) {
          forms[name] = {
            model: prov.model ?? "",
            baseUrl: prov.baseUrl ?? "",
            apiKey: "",
            maxContextTokens: "",
            keyDirty: false,
          }
        }
        setTeamProviders(forms)
        setTeamDefault(t.default ?? "")
      }
      if (daily) setDailyUsage(daily)
      setLoading(false)
    })
  }, [open])

  function handleProviderChange(
    target: "personal" | "team",
    name: string,
    field: keyof ProviderForm,
    value: string,
  ) {
    const setter = target === "personal" ? setPersonalProviders : setTeamProviders
    setter((prev) => {
      const updated = { ...prev }
      if (!updated[name]) return prev
      updated[name] = { ...updated[name], [field]: value }
      if (field === "apiKey") updated[name].keyDirty = true
      return updated
    })
  }

  function handleRemoveProvider(target: "personal" | "team", name: string) {
    const setForms = target === "personal" ? setPersonalProviders : setTeamProviders
    const setDef = target === "personal" ? setPersonalDefault : setTeamDefault
    setForms((prev) => {
      const updated = { ...prev }
      delete updated[name]
      return updated
    })
    setDef((prev) => (prev === name ? "" : prev))
  }

  function handleAddProvider(target: "personal" | "team") {
    const name = newProviderName.trim()
    if (!name) return
    const setter = target === "personal" ? setPersonalProviders : setTeamProviders
    const existing = target === "personal" ? personalProviders : teamProviders
    if (existing[name]) { setError("provider name already exists"); return }
    setter((prev) => ({
      ...prev,
      [name]: { model: "", baseUrl: "", apiKey: "", maxContextTokens: "", keyDirty: false },
    }))
    setNewProviderName("")
    setAddingProvider(false)
    setError("")
  }

  async function handleSave(target: "personal" | "team") {
    setSaving(true)
    setError("")
    try {
      if (target === "personal") {
        const providers: Record<string, { model: string; baseUrl: string; apiKey?: string; maxContextTokens?: number }> = {}
        for (const [name, f] of Object.entries(personalProviders)) {
          providers[name] = {
            model: f.model,
            baseUrl: f.baseUrl,
            ...(f.maxContextTokens ? { maxContextTokens: Number(f.maxContextTokens) } : {}),
          }
          if (f.keyDirty && f.apiKey) {
            providers[name].apiKey = f.apiKey
          }
        }
        const ok = await updatePersonalSettings({ providers, default: personalDefault, webhookUrl })
        if (!ok) setError("save failed")
        else {
          // Clear key dirty flags after save
          setPersonalProviders((prev) => {
            const updated = { ...prev }
            for (const k of Object.keys(updated)) {
              updated[k] = { ...updated[k], keyDirty: false, apiKey: "" }
            }
            return updated
          })
          setEditingKeys({})
        }
      } else {
        const providers: Record<string, { model: string; baseUrl: string; apiKey?: string }> = {}
        for (const [name, f] of Object.entries(teamProviders)) {
          providers[name] = { model: f.model, baseUrl: f.baseUrl }
          if (f.keyDirty && f.apiKey) {
            providers[name].apiKey = f.apiKey
          }
        }
        const ok = await updateTeamSettings({ providers, default: teamDefault })
        if (!ok) setError("save failed")
        else {
          setTeamProviders((prev) => {
            const updated = { ...prev }
            for (const k of Object.keys(updated)) {
              updated[k] = { ...updated[k], keyDirty: false, apiKey: "" }
            }
            return updated
          })
          setEditingKeys({})
        }
      }
    } catch (e: any) {
      setError(e?.message ?? "save failed")
    } finally {
      setSaving(false)
    }
  }

  function toggleEditKey(name: string) {
    setEditingKeys((prev) => {
      const next = { ...prev }
      if (next[name]) {
        delete next[name]
        // Clear the key field when canceling (affects current category)
        const setter = category === "personal" ? setPersonalProviders : setTeamProviders
        setter((pp) => {
          const updated = { ...pp }
          if (updated[name]) updated[name] = { ...updated[name], apiKey: "", keyDirty: false }
          return updated
        })
      } else {
        next[name] = true
      }
      return next
    })
  }

  const currentProviders = category === "personal" ? personalProviders : teamProviders
  const currentDefault = category === "personal" ? personalDefault : teamDefault
  const setCurrentDefault = category === "personal" ? setPersonalDefault : setTeamDefault
  const currentSettings = category === "personal" ? personal : team
  const providerNames = Object.keys(currentProviders)
  const tokenUsage = currentSettings?.tokenUsage ?? {}

  if (!open) return null

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent
        className="max-w-[95vw] sm:max-w-[720px] h-[85vh] sm:h-[80vh] p-0 gap-0 overflow-hidden flex flex-col"
        showCloseButton
      >
        <DialogHeader className="px-4 sm:px-6 pt-4 sm:pt-5 pb-0 shrink-0">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Configure model providers, API keys, and notification webhooks.
          </DialogDescription>
        </DialogHeader>

        {/* Top category tabs */}
        <div className="flex gap-0 px-4 sm:px-6 pt-4 border-b border-gray-200 shrink-0">
          <button
            type="button"
            onClick={() => { setCategory("personal"); setSidebar("models") }}
            className={`px-3 sm:px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              category === "personal"
                ? "border-gray-900 text-gray-900"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            Personal
          </button>
          <button
            type="button"
            onClick={() => { setCategory("team"); setSidebar("models") }}
            className={`px-3 sm:px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              category === "team"
                ? "border-gray-900 text-gray-900"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            Team
          </button>
        </div>

        <div className="flex flex-col sm:flex-row min-h-0 flex-1 overflow-hidden">
          {/* Left sidebar - horizontal on mobile, vertical on desktop */}
          <div className="w-full sm:w-40 shrink-0 border-b sm:border-b-0 sm:border-r border-gray-200 p-2 sm:p-3 flex sm:flex-col gap-1 overflow-x-auto">
            <button
              type="button"
              onClick={() => setSidebar("models")}
              className={`text-left px-3 py-1.5 rounded text-sm transition-colors whitespace-nowrap ${
                sidebar === "models"
                  ? "bg-gray-100 text-gray-900 font-medium"
                  : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              Model Settings
            </button>
            {category === "personal" && (
              <button
                type="button"
                onClick={() => setSidebar("notifications")}
                className={`text-left px-3 py-1.5 rounded text-sm transition-colors whitespace-nowrap ${
                  sidebar === "notifications"
                    ? "bg-gray-100 text-gray-900 font-medium"
                    : "text-gray-600 hover:bg-gray-50"
                }`}
              >
                Notifications
              </button>
            )}
          </div>

          {/* Right content */}
          <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5">
            {loading ? (
              <div className="text-sm text-gray-400 py-8 text-center">Loading...</div>
            ) : sidebar === "notifications" ? (
              /* ── Notification Settings ── */
              <div className="flex flex-col gap-4 min-h-full">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 mb-1">IM Webhook URL</label>
                  <input
                    type="url"
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    placeholder="https://..."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    Receive notifications via webhook when messages arrive.
                  </p>
                </div>
                <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-200">
                  {error && <span className="text-xs text-red-500">{error}</span>}
                  <Button onClick={() => handleSave("personal")} disabled={saving}>
                    {saving ? "Saving..." : "Save"}
                  </Button>
                </div>
              </div>
            ) : (
              /* ── Model Settings ── */
              <div className="flex flex-col gap-5 min-h-full">
                <div className="flex-1 flex flex-col gap-5">
                  {/* Provider cards */}
                  {providerNames.map((name) => {
                    const f = currentProviders[name]!
                    const hasExistingKey = currentSettings?.providers?.[name]?.hasKey ?? false
                    const isEditingKey = editingKeys[name] ?? false

                    return (
                      <div key={name} className="border border-gray-200 rounded-lg p-3 sm:p-4">
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-sm font-semibold text-gray-900">{name}</span>
                          <button
                            type="button"
                            onClick={() => handleRemoveProvider(category, name)}
                            className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                          >
                            Remove
                          </button>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Model</label>
                            <input
                              type="text"
                              value={f.model}
                              onChange={(e) => handleProviderChange(category, name, "model", e.target.value)}
                              placeholder="e.g. claude-sonnet-4-6"
                              className="w-full px-2.5 py-1.5 border border-gray-300 rounded text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Base URL</label>
                            <input
                              type="url"
                              value={f.baseUrl}
                              onChange={(e) => handleProviderChange(category, name, "baseUrl", e.target.value)}
                              placeholder="https://api.example.com"
                              className="w-full px-2.5 py-1.5 border border-gray-300 rounded text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">API Key</label>
                            {isEditingKey || !hasExistingKey ? (
                              <div className="flex gap-1.5">
                                <input
                                  type="password"
                                  value={f.apiKey}
                                  onChange={(e) => handleProviderChange(category, name, "apiKey", e.target.value)}
                                  placeholder={hasExistingKey ? "enter new key to replace" : "API key"}
                                  className="flex-1 px-2.5 py-1.5 border border-gray-300 rounded text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                                />
                                {hasExistingKey && (
                                  <button
                                    type="button"
                                    onClick={() => toggleEditKey(name)}
                                    className="text-xs text-gray-400 hover:text-gray-600 px-1"
                                  >
                                    cancel
                                  </button>
                                )}
                              </div>
                            ) : (
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="text"
                                  value="********"
                                  disabled
                                  className="flex-1 px-2.5 py-1.5 border border-gray-200 rounded text-sm bg-gray-50 text-gray-400"
                                />
                                <button
                                  type="button"
                                  onClick={() => toggleEditKey(name)}
                                  className="text-xs text-gray-500 hover:text-gray-900 px-1.5 py-0.5 border border-gray-200 rounded transition-colors"
                                >
                                  Edit
                                </button>
                              </div>
                            )}
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500 mb-1">Max Context Tokens</label>
                            <input
                              type="number"
                              value={f.maxContextTokens}
                              onChange={(e) => handleProviderChange(category, name, "maxContextTokens", e.target.value)}
                              placeholder="auto"
                              className="w-full px-2.5 py-1.5 border border-gray-300 rounded text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                            />
                          </div>
                        </div>
                        <div className="mt-3 pt-3 border-t border-gray-100">
                          <TokenUsageDisplay usage={tokenUsage} modelName={f.model || name} />
                          <DailyChart daily={dailyUsage} modelName={f.model || name} />
                        </div>
                      </div>
                    )
                  })}

                  {/* Add provider */}
                  {addingProvider ? (
                    <div className="border border-dashed border-gray-300 rounded-lg p-3 flex items-center gap-2">
                      <input
                        type="text"
                        value={newProviderName}
                        onChange={(e) => setNewProviderName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleAddProvider(category)
                          if (e.key === "Escape") { setAddingProvider(false); setNewProviderName("") }
                        }}
                        placeholder="provider name"
                        autoFocus
                        className="flex-1 px-2.5 py-1.5 border border-gray-300 rounded text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900"
                      />
                      <Button size="xs" onClick={() => handleAddProvider(category)}>Add</Button>
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

                  {/* Default provider */}
                  {providerNames.length > 0 && (
                    <div className="pt-2 border-t border-gray-200">
                      <label className="block text-sm font-medium text-gray-700 mb-1">Default Provider</label>
                      <select
                        value={currentDefault}
                        onChange={(e) => setCurrentDefault(e.target.value)}
                        className="px-3 py-1.5 border border-gray-300 rounded-md text-sm outline-none focus:border-gray-900 focus:ring-1 focus:ring-gray-900 bg-white"
                      >
                        <option value="">None</option>
                        {providerNames.map((n) => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                {/* Save footer */}
                <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-200">
                  {error && <span className="text-xs text-red-500">{error}</span>}
                  <Button onClick={() => handleSave(category)} disabled={saving}>
                    {saving ? "Saving..." : "Save"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
