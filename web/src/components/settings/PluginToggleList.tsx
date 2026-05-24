import { useEffect, useState } from "react"
import {
  listAvailablePlugins,
  browseMarketplacePlugins,
  listMarketplaces,
  refreshMarketplaces,
  type PluginEntry,
  type PluginWithStatus,
  type MarketplaceSource,
} from "@/api"
import { Switch } from "@/components/ui/switch"
import { Plus, Trash2, Package, Search, RefreshCw, Store, ExternalLink, X, ChevronDown, AlertCircle } from "lucide-react"

export function PluginToggleList({
  enabledPlugins,
  onChange,
  readonly,
  focusMarketplaceRef,
}: {
  enabledPlugins: Record<string, boolean>
  onChange: (enabled: Record<string, boolean>) => void
  readonly?: boolean
  focusMarketplaceRef?: React.MutableRefObject<(() => void) | null>
}) {
  const [installed, setInstalled] = useState<PluginEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [newKey, setNewKey] = useState("")

  useEffect(() => {
    listAvailablePlugins().then((p) => {
      setInstalled(p)
      setLoading(false)
    })
  }, [])

  const toggle = (key: string) => {
    if (readonly) return
    const next = { ...enabledPlugins }
    const current = next[key] ?? false
    if (current) {
      delete next[key]
    } else {
      next[key] = true
    }
    onChange(next)
  }

  const addCustom = () => {
    if (readonly || !newKey.trim()) return
    onChange({ ...enabledPlugins, [newKey.trim()]: true })
    setNewKey("")
    setAdding(false)
  }

  const remove = (key: string) => {
    if (readonly) return
    const { [key]: _, ...rest } = enabledPlugins
    onChange(rest)
  }

  const installedKeys = new Set(installed.map((p) => `${p.name}@${p.marketplace}`))
  const enabledInstalled = installed.filter((p) => enabledPlugins[`${p.name}@${p.marketplace}`])
  const disabledInstalled = installed.filter((p) => !enabledPlugins[`${p.name}@${p.marketplace}`])
  const customEnabled = Object.keys(enabledPlugins).filter((k) => enabledPlugins[k] && !installedKeys.has(k))

  return (
    <div className="space-y-2">
      {loading ? (
        <div className="flex items-center gap-2 py-3 text-[12px] text-gray-400">
          <RefreshCw size={11} className="animate-spin" /> loading…
        </div>
      ) : (
        <>
          {/* Enabled + disabled installed */}
          {enabledInstalled.length === 0 && disabledInstalled.length === 0 && customEnabled.length === 0 ? (
            <div className="py-3">
              <div className="flex flex-col items-center gap-1.5 text-center py-4">
                <Package size={18} className="text-gray-300" />
                <div className="text-[12px] text-gray-400">No plugins</div>
                <div className="text-[11px] text-gray-400/70">
                  Browse marketplaces below or type a plugin spec to add one.
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-0.5">
              {enabledInstalled.map((p) => {
                const key = `${p.name}@${p.marketplace}`
                return (
                  <PluginRow
                    key={key}
                    name={p.displayName || p.name}
                    subtitle={`@${p.marketplace}`}
                    description={p.description}
                    enabled={true}
                    onToggle={() => toggle(key)}
                    readonly={readonly}
                  />
                )
              })}
              {customEnabled.map((key) => (
                <PluginRow
                  key={key}
                  name={key}
                  subtitle="custom"
                  enabled={true}
                  onToggle={() => toggle(key)}
                  onRemove={() => remove(key)}
                  readonly={readonly}
                />
              ))}
              {disabledInstalled.map((p) => {
                const key = `${p.name}@${p.marketplace}`
                return (
                  <PluginRow
                    key={key}
                    name={p.displayName || p.name}
                    subtitle={`@${p.marketplace}`}
                    description={p.description}
                    enabled={false}
                    onToggle={() => toggle(key)}
                    readonly={readonly}
                  />
                )
              })}
            </div>
          )}
        </>
      )}

      {/* Add custom plugin spec */}
      {!readonly && (
        <AddPluginRow
          open={adding}
          value={newKey}
          onOpen={() => setAdding(true)}
          onCancel={() => { setAdding(false); setNewKey("") }}
          onChange={setNewKey}
          onAdd={addCustom}
        />
      )}

      {/* Marketplace browser */}
      {!readonly && (
        <MarketplaceBrowser
          enabledPlugins={enabledPlugins}
          onToggle={toggle}
          focusMarketplaceRef={focusMarketplaceRef}
        />
      )}
    </div>
  )
}

// ── marketplace browser ──

function MarketplaceBrowser({
  enabledPlugins,
  onToggle,
  focusMarketplaceRef,
}: {
  enabledPlugins: Record<string, boolean>
  onToggle: (key: string) => void
  focusMarketplaceRef?: React.MutableRefObject<(() => void) | null>
}) {
  const [open, setOpen] = useState(false)
  const [plugins, setPlugins] = useState<PluginWithStatus[]>([])
  const [marketplaces, setMarketplaces] = useState<MarketplaceSource[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [search, setSearch] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [addedMsg, setAddedMsg] = useState<string | null>(null)
  const [filterMp, setFilterMp] = useState<string>("all")

  const load = async () => {
    setLoading(true)
    setError(null)
    const [p, m] = await Promise.all([browseMarketplacePlugins(), listMarketplaces()])
    setPlugins(p)
    setMarketplaces(m)
    setLoading(false)
  }

  const refresh = async () => {
    setRefreshing(true)
    setError(null)
    setAddedMsg(null)
    const r = await refreshMarketplaces()
    if (r.ok) {
      if (r.added && r.added.length > 0) {
        setAddedMsg(`Registered: ${r.added.join(", ")}`)
      }
      await load()
    } else {
      setError(r.error ?? "refresh failed")
    }
    setRefreshing(false)
  }

  // When opened, auto-register any new marketplaces from tier settings.json
  // into CC's known_marketplaces.json, then load the catalogs.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const init = async () => {
      setLoading(true)
      setError(null)
      setAddedMsg(null)
      const result = await refreshMarketplaces()
      if (cancelled) return
      if (result.ok && result.added && result.added.length > 0) {
        setAddedMsg(`Auto-registered: ${result.added.join(", ")}`)
      }
      const [p, m] = await Promise.all([browseMarketplacePlugins(), listMarketplaces()])
      if (cancelled) return
      setPlugins(p)
      setMarketplaces(m)
      setLoading(false)
    }
    init()
    return () => { cancelled = true }
  }, [open])

  const mpNames = [...new Set(plugins.map((p) => p.marketplaceName).filter(Boolean))].sort()

  const filtered = plugins.filter((p) => {
    if (filterMp !== "all" && p.marketplaceName !== filterMp) return false
    if (search.trim()) {
      const q = search.toLowerCase()
      if (!p.name.toLowerCase().includes(q) &&
          !p.marketplaceName.toLowerCase().includes(q) &&
          !(p.description && p.description.toLowerCase().includes(q))) return false
    }
    return true
  })

  // Group by marketplace
  const grouped: Record<string, PluginWithStatus[]> = {}
  for (const p of filtered) {
    const mp = p.marketplaceName || "unknown"
    if (!grouped[mp]) grouped[mp] = []
    grouped[mp].push(p)
  }

  return (
    <div>
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 px-3 py-2 text-[12px] text-gray-400 hover:text-gray-700 hover:bg-gray-50 rounded-lg w-full transition-colors"
        >
          <Store size={13} />
          Browse marketplace plugins
        </button>
      ) : (
        <div className="rounded-lg border border-gray-200 overflow-hidden">
          {/* Browser header */}
          <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border-b border-gray-100">
            <Store size={13} className="text-gray-500 shrink-0" />
            <span className="text-[12px] font-medium text-gray-700">Marketplace Plugins</span>
            <span className="text-[10px] text-gray-400">
              {marketplaces.length} source{marketplaces.length !== 1 ? "s" : ""}
            </span>
            <div className="flex-1" />
            {focusMarketplaceRef && (
              <button
                onClick={() => focusMarketplaceRef.current?.()}
                className="text-[11px] text-gray-400 hover:text-gray-700 px-1.5 py-0.5 rounded transition-colors"
                title="Add a marketplace source"
              >
                + Add source
              </button>
            )}
            <button
              onClick={refresh}
              disabled={refreshing}
              className="p-1 rounded text-gray-400 hover:text-gray-700 disabled:opacity-50"
              title="Refresh marketplace registrations"
            >
              <RefreshCw size={11} className={refreshing ? "animate-spin" : ""} />
            </button>
            <button
              onClick={() => setOpen(false)}
              className="p-1 rounded text-gray-400 hover:text-gray-700"
            >
              <X size={13} />
            </button>
          </div>

          {/* Search + Filter */}
          <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2">
            <div className="relative flex-1">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="search plugins…"
                className="w-full pl-7 pr-2 py-1.5 text-[12px] border border-gray-200 rounded-lg outline-none focus:border-gray-400 bg-white"
              />
            </div>
            {mpNames.length > 1 && (
              <select
                value={filterMp}
                onChange={(e) => setFilterMp(e.target.value)}
                className="w-28 shrink-0 border border-gray-200 rounded-lg px-2 py-1.5 text-[11px] outline-none focus:border-gray-400 bg-white"
              >
                <option value="all">All sources</option>
                {mpNames.map((mp) => (
                  <option key={mp} value={mp}>{mp}</option>
                ))}
              </select>
            )}
          </div>

          {/* Status messages */}
          {addedMsg && (
            <div className="px-3 py-1.5 bg-emerald-50 border-b border-emerald-100 text-[11px] text-emerald-700">
              {addedMsg}
            </div>
          )}

          {/* Plugin list */}
          <div className="max-h-[300px] overflow-y-auto">
            {loading ? (
              <div className="flex items-center gap-2 px-3 py-6 justify-center text-[12px] text-gray-400">
                <RefreshCw size={11} className="animate-spin" /> loading marketplace catalogs…
              </div>
            ) : error ? (
              <div className="flex items-center gap-2 px-3 py-4 text-[12px] text-red-600">
                <AlertCircle size={12} /> {error}
              </div>
            ) : Object.keys(grouped).length === 0 ? (
              <div className="flex flex-col items-center gap-1.5 py-6 text-center">
                <Package size={18} className="text-gray-300" />
                <div className="text-[12px] text-gray-400">
                  {search ? "No matching plugins" :
                   marketplaces.length === 0 ? "No marketplaces configured" :
                   "No plugins found in marketplaces"}
                </div>
                {marketplaces.length === 0 && (
                  <div className="text-[11px] text-gray-400/70 px-4 space-y-2">
                    <div>
                      No marketplace sources registered. Add one below or{" "}
                      {focusMarketplaceRef ? (
                        <button
                          onClick={() => focusMarketplaceRef.current?.()}
                          className="text-gray-700 underline hover:text-gray-900"
                        >
                          add a marketplace source
                        </button>
                      ) : (
                        "add a marketplace source"
                      )}{" "}
                      in the Marketplaces section, then refresh.
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="py-1">
                {Object.entries(grouped).map(([mpName, mpPlugins]) => (
                  <div key={mpName}>
                    <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider bg-gray-50/50">
                      {mpName}
                    </div>
                    {mpPlugins.map((p) => {
                      const key = `${p.name}@${p.marketplaceName}`
                      const isEnabled = enabledPlugins[key] ?? false
                      return (
                        <label
                          key={key}
                          className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 transition-colors cursor-pointer"
                        >
                          <Switch
                            checked={isEnabled}
                            onCheckedChange={() => onToggle(key)}
                            size="sm"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="text-[12px] text-gray-900 truncate">{p.displayName || p.name}</span>
                              {p.installed && (
                                <span className="text-[9px] bg-gray-100 text-gray-500 px-1 py-0.5 rounded-full shrink-0">installed</span>
                              )}
                              {isEnabled && (
                                <span className="text-[9px] bg-emerald-100 text-emerald-700 px-1 py-0.5 rounded-full shrink-0">on</span>
                              )}
                            </div>
                            {p.description && (
                              <div className="text-[11px] text-gray-400 mt-0.5 line-clamp-1">{p.description}</div>
                            )}
                          </div>
                        </label>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── plugin row ──

function PluginRow({
  name,
  subtitle,
  description,
  enabled,
  onToggle,
  onRemove,
  readonly,
}: {
  name: string
  subtitle?: string
  description?: string
  enabled: boolean
  onToggle: () => void
  onRemove?: () => void
  readonly?: boolean
}) {
  return (
    <div className={`group flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${enabled ? "hover:bg-gray-50" : "hover:bg-gray-50/50"}`}>
      <Switch checked={enabled} onCheckedChange={onToggle} disabled={readonly} size="sm" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`text-[13px] truncate ${enabled ? "text-gray-900 font-medium" : "text-gray-400"}`}>
            {name}
          </span>
          {subtitle && (
            <span className={`text-[10px] shrink-0 ${enabled ? "text-gray-400" : "text-gray-300"}`}>{subtitle}</span>
          )}
        </div>
        {description && (
          <div className={`text-[11px] mt-0.5 line-clamp-1 ${enabled ? "text-gray-500" : "text-gray-400"}`}>
            {description}
          </div>
        )}
      </div>
      {onRemove && !readonly && (
        <button
          onClick={onRemove}
          className="shrink-0 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
          title="remove"
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  )
}

// ── add custom ──

function AddPluginRow({
  open,
  value,
  onOpen,
  onCancel,
  onChange,
  onAdd,
}: {
  open: boolean
  value: string
  onOpen: () => void
  onCancel: () => void
  onChange: (v: string) => void
  onAdd: () => void
}) {
  if (!open) {
    return (
      <button
        onClick={onOpen}
        className="flex items-center gap-1.5 px-3 py-2 text-[12px] text-gray-400 hover:text-gray-700 hover:bg-gray-50 rounded-lg w-full transition-colors"
      >
        <Plus size={13} />
        Add plugin by spec
      </button>
    )
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onAdd()
          if (e.key === "Escape") onCancel()
        }}
        placeholder="name@marketplace"
        className="flex-1 min-w-0 border border-gray-300 rounded px-2.5 py-1.5 text-[12px] outline-none focus:border-gray-900 bg-white"
      />
      <button onClick={onAdd} className="px-2.5 h-7 rounded-lg bg-gray-900 text-white text-[11px] font-medium hover:bg-gray-800 shrink-0">add</button>
      <button onClick={onCancel} className="text-[11px] text-gray-400 hover:text-gray-600 shrink-0">cancel</button>
    </div>
  )
}
