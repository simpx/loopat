import { useEffect, useState } from "react"
import { listAvailablePlugins, type PluginEntry } from "@/api"
import { Switch } from "@/components/ui/switch"
import { Plus, Trash2, Package, ExternalLink } from "lucide-react"

export function PluginToggleList({
  enabledPlugins,
  onChange,
  readonly,
}: {
  enabledPlugins: Record<string, boolean>
  onChange: (enabled: Record<string, boolean>) => void
  readonly?: boolean
}) {
  const [available, setAvailable] = useState<PluginEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [newKey, setNewKey] = useState("")

  useEffect(() => {
    listAvailablePlugins().then((p) => {
      setAvailable(p)
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

  // Build a merged list: installed plugins first, then any custom enabled ones
  const installedKeys = new Set(available.map((p) => `${p.name}@${p.marketplace}`))
  const customEnabled = Object.keys(enabledPlugins).filter((k) => enabledPlugins[k] && !installedKeys.has(k))
  const disabledInstalled = available.filter((p) => {
    const key = `${p.name}@${p.marketplace}`
    return !enabledPlugins[key]
  })

  const allEnabled = available.filter((p) => {
    const key = `${p.name}@${p.marketplace}`
    return enabledPlugins[key]
  })

  if (loading) {
    return <div className="flex items-center gap-2 py-3 text-[12px] text-gray-400"><span className="animate-spin w-3 h-3 border border-gray-300 border-t-transparent rounded-full" /> loading plugins…</div>
  }

  if (allEnabled.length === 0 && customEnabled.length === 0 && disabledInstalled.length === 0) {
    return (
      <div className="py-3">
        <div className="flex flex-col items-center gap-1.5 text-center py-4">
          <Package size={18} className="text-gray-300" />
          <div className="text-[12px] text-gray-400">No plugins installed</div>
          <div className="text-[11px] text-gray-400/70">
            Plugins from <code className="bg-gray-100 px-1 rounded text-[10px]">extraKnownMarketplaces</code> appear here after install.
          </div>
        </div>
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
      </div>
    )
  }

  return (
    <div className="space-y-0.5">
      {/* Enabled plugins */}
      {allEnabled.map((p) => {
        const key = `${p.name}@${p.marketplace}`
        return (
          <PluginRow
            key={key}
            name={p.displayName || p.name}
            subtitle={p.marketplace ? `@${p.marketplace}` : undefined}
            description={p.description}
            enabled={true}
            onToggle={() => toggle(key)}
            readonly={readonly}
          />
        )
      })}

      {/* Custom enabled */}
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

      {/* Disabled installed — shown dimmed, still toggleable */}
      {disabledInstalled.map((p) => {
        const key = `${p.name}@${p.marketplace}`
        return (
          <PluginRow
            key={key}
            name={p.displayName || p.name}
            subtitle={p.marketplace ? `@${p.marketplace}` : undefined}
            description={p.description}
            enabled={false}
            onToggle={() => toggle(key)}
            readonly={readonly}
          />
        )
      })}

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
    </div>
  )
}

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
        <div className="flex items-center gap-1.5">
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
        Add plugin
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
        className="ip text-[12px] flex-1"
      />
      <button onClick={onAdd} className="px-2.5 h-7 rounded bg-gray-900 text-white text-[11px] font-medium hover:bg-gray-700 shrink-0">add</button>
      <button onClick={onCancel} className="text-[11px] text-gray-400 hover:text-gray-600 shrink-0">cancel</button>
    </div>
  )
}
