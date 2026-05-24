import { useCallback, useEffect, useState } from "react"
import { useWorkspace } from "@/ctx"
import { getTiers, saveTierSettings, type TierInfo, type TiersResponse } from "@/api"
import { McpServerEditor, mcpServersFromJson } from "./McpServerEditor"
import { PluginToggleList } from "./PluginToggleList"
import { ChevronDown, ChevronRight, Lock, RefreshCw, Check, Layers, AlertCircle, Globe, User, Blocks, FolderGit2, FileCode2 } from "lucide-react"

// ── tier metadata ──

type TierMeta = {
  icon: typeof Layers
  borderClass: string
  badgeClass: string
  desc: string
}

const TIER_META: Record<string, TierMeta> = {
  team:     { icon: Globe,       borderClass: "border-l-violet-400", badgeClass: "bg-violet-100 text-violet-700", desc: "Workspace-wide, set by admin" },
  personal: { icon: User,        borderClass: "border-l-emerald-400", badgeClass: "bg-emerald-100 text-emerald-700", desc: "Your personal overrides" },
  project:  { icon: FolderGit2,  borderClass: "border-l-gray-300", badgeClass: "bg-gray-100 text-gray-500", desc: "SDK reads from workdir" },
  local:    { icon: FileCode2,   borderClass: "border-l-amber-300", badgeClass: "bg-amber-100 text-amber-700", desc: "Per-checkout .local.* overrides" },
}

function getTierMeta(id: string): TierMeta {
  if (id.startsWith("profile:")) {
    return { icon: Blocks, borderClass: "border-l-blue-400", badgeClass: "bg-blue-100 text-blue-700", desc: "Opt-in role-based config" }
  }
  return TIER_META[id] ?? TIER_META.team
}

function tierOrder(id: string): number {
  if (id === "team") return 1
  if (id.startsWith("profile:")) return 2
  if (id === "personal") return 3
  if (id === "project") return 4
  if (id === "local") return 5
  return 99
}

function managedBadge(managedBy: string) {
  if (managedBy === "admin") return "bg-violet-100 text-violet-700"
  if (managedBy === "user") return "bg-gray-100 text-gray-600"
  return "bg-gray-100 text-gray-400"
}

// ── main panel ──

export function ClaudeConfigPanel({ disabled: parentDisabled }: { disabled?: boolean }) {
  const ws = useWorkspace()
  const isAdmin = ws.currentUser?.role === "admin"

  const [data, setData] = useState<TiersResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["personal"]))

  const refresh = useCallback(async () => {
    setLoading(true)
    const d = await getTiers()
    setData(d)
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const sorted = data?.tiers
    ? [...data.tiers].sort((a, b) => tierOrder(a.id) - tierOrder(b.id))
    : []

  if (loading && !data) {
    return <div className="flex items-center gap-2 py-12 justify-center text-[13px] text-gray-400"><RefreshCw size={13} className="animate-spin" /> loading tiers…</div>
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Intro + stats bar */}
      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2.5">
          <Layers size={15} className="text-gray-400" />
          <div>
            <span className="text-[13px] font-medium text-gray-900">Claude Config Composition</span>
            <span className="text-[11px] text-gray-400 ml-2">
              {sorted.filter((t) => t.exists).length} active tiers · merged at loop spawn
            </span>
          </div>
          <div className="flex-1" />
          <button onClick={refresh} disabled={loading} className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors">
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        {/* Tier summary bar */}
        <div className="flex flex-wrap gap-px bg-gray-100">
          {sorted.map((tier) => {
            const meta = getTierMeta(tier.id)
            const Icon = meta.icon
            const isExp = expanded.has(tier.id)
            return (
              <button
                key={tier.id}
                type="button"
                onClick={() => toggleExpand(tier.id)}
                className={`flex-1 min-w-[120px] flex items-center gap-2 px-3 py-2.5 bg-white hover:bg-gray-50 transition-colors text-left ${isExp ? "bg-gray-50" : ""}`}
              >
                <Icon size={14} className={`shrink-0 ${tier.exists ? "text-gray-500" : "text-gray-300"}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-[11px] font-medium truncate ${tier.exists ? "text-gray-700" : "text-gray-400"}`}>
                      {tier.label}
                    </span>
                  </div>
                  <div className="text-[10px] text-gray-400 mt-0.5 flex items-center gap-1.5">
                    {tier.pluginCount > 0 && <span>{tier.pluginCount}p</span>}
                    {tier.mcpServerCount > 0 && <span>{tier.mcpServerCount}m</span>}
                    {tier.pluginCount === 0 && tier.mcpServerCount === 0 && !tier.exists && <span>—</span>}
                    {Object.keys(tier.overrides).length > 0 && (
                      <span className="text-amber-500">{Object.keys(tier.overrides).length}↗</span>
                    )}
                  </div>
                </div>
                {isExp ? <ChevronDown size={10} className="text-gray-400 shrink-0" /> : <ChevronRight size={10} className="text-gray-400 shrink-0" />}
              </button>
            )
          })}
        </div>
      </div>

      {/* Expanded tier detail */}
      {sorted.map((tier) => (
        <TierDetail
          key={tier.id}
          tier={tier}
          isAdmin={!!isAdmin}
          isExpanded={expanded.has(tier.id)}
          disabled={parentDisabled}
          onSaved={() => refresh()}
        />
      ))}
    </div>
  )
}

// ── tier detail card ──

function TierDetail({
  tier,
  isAdmin,
  isExpanded,
  disabled,
  onSaved,
}: {
  tier: TierInfo
  isAdmin: boolean
  isExpanded: boolean
  disabled?: boolean
  onSaved: () => void
}) {
  if (!isExpanded) return null

  const meta = getTierMeta(tier.id)
  const Icon = meta.icon
  const canEdit = tier.editable && (tier.managedBy === "user" || (tier.managedBy === "admin" && isAdmin))
  const isSdk = tier.managedBy === "sdk"
  const lockReason = !canEdit && tier.managedBy === "admin" && !isAdmin ? "Admin access required" : null

  const [draft, setDraft] = useState<Record<string, any>>({})
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setDraft(tier.settings ? { ...tier.settings } : {})
    setErr(null)
    setSaved(false)
  }, [tier.settings, tier.id])

  const handleSave = async () => {
    setSaving(true)
    setErr(null)
    const { _comment, ...clean } = draft
    const r = await saveTierSettings(tier.id, clean)
    setSaving(false)
    if (!r.ok) { setErr(r.error ?? "save failed"); return }
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
    onSaved()
  }

  const overrideCount = Object.keys(tier.overrides).length

  return (
    <div className={`rounded-xl border overflow-hidden transition-shadow ${canEdit ? "border-gray-200 bg-white" : "border-gray-200 bg-gray-50/50"}`}>
      {/* Header */}
      <div className={`flex items-center gap-3 px-4 py-3 border-b border-gray-100 border-l-2 ${meta.borderClass}`}>
        <Icon size={16} className="text-gray-500 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-gray-900">{tier.label}</span>
            <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${managedBadge(tier.managedBy)}`}>
              {tier.managedBy === "admin" ? "admin" : tier.managedBy === "user" ? "you" : "SDK"}
            </span>
            {!tier.exists && !isSdk && (
              <span className="text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full">not created</span>
            )}
            {lockReason && <Lock size={11} className="text-amber-500 shrink-0" />}
          </div>
          <div className="text-[11px] text-gray-400 mt-0.5">
            {isSdk ? tier.path : meta.desc}
          </div>
        </div>
        {/* Stat chips */}
        <div className="hidden sm:flex items-center gap-1.5 shrink-0">
          <StatChip label="Plugins" value={tier.pluginCount} />
          <StatChip label="MCP" value={tier.mcpServerCount} />
          {tier.skillCount > 0 && <StatChip label="Skills" value={tier.skillCount} />}
          {tier.agentCount > 0 && <StatChip label="Agents" value={tier.agentCount} />}
          {overrideCount > 0 && (
            <span className="text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full font-medium">
              {overrideCount} override{overrideCount > 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="px-4 py-4 space-y-5">
        {isSdk ? (
          <div className="rounded-lg bg-gray-50 px-3 py-2.5 text-[12px] text-gray-500">
            SDK-managed — read directly from <code className="bg-gray-100 px-1 rounded text-[11px]">{tier.path}</code>. Not editable here.
          </div>
        ) : (
          <>
            {/* Path hint */}
            {tier.path && !tier.path.startsWith("<") && (
              <div className="text-[11px] text-gray-400 font-mono truncate bg-gray-50/50 px-2 py-1 rounded">
                {tier.path}
              </div>
            )}

            {/* Override warnings */}
            {overrideCount > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50/50 px-3 py-2">
                <div className="text-[11px] font-medium text-amber-700 mb-1.5">
                  Overrides from lower tiers
                </div>
                <div className="space-y-0.5">
                  {Object.entries(tier.overrides).slice(0, 8).map(([key, info]) => (
                    <div key={key} className="flex items-center gap-1.5 text-[11px] text-amber-700/80">
                      <AlertCircle size={10} className="text-amber-400 shrink-0" />
                      <code className="text-[10px] bg-amber-100/50 px-1 rounded">{key}</code>
                      <span className="text-amber-500">shadows {info.overrides}</span>
                    </div>
                  ))}
                  {overrideCount > 8 && (
                    <div className="text-[10px] text-amber-400 ml-5">+{overrideCount - 8} more</div>
                  )}
                </div>
              </div>
            )}

            {/* Plugins */}
            <SubSection title="Plugins" count={tier.pluginCount} defaultOpen={tier.pluginCount > 0}>
              {!canEdit && tier.pluginCount === 0 ? (
                <div className="text-[12px] text-gray-400 italic py-2">No plugins configured in this tier</div>
              ) : (
                <PluginToggleList
                  enabledPlugins={(draft?.enabledPlugins as Record<string, boolean>) ?? {}}
                  readonly={!canEdit || disabled}
                  onChange={(enabled) => setDraft((d) => d ? { ...d, enabledPlugins: enabled } : { enabledPlugins: enabled })}
                />
              )}
            </SubSection>

            {/* MCP Servers */}
            <SubSection title="MCP Servers" count={tier.mcpServerCount} defaultOpen={tier.mcpServerCount > 0}>
              <McpServerEditor
                servers={mcpServersFromJson(draft)}
                readonly={!canEdit || disabled}
                onChange={(servers) => setDraft((d) => d ? { ...d, mcpServers: servers } : { mcpServers: servers })}
              />
            </SubSection>

            {/* Hooks + Marketplaces (summary) */}
            {(tier.hookCount > 0 || tier.marketplaceCount > 0) && (
              <SubSection title="Other" count={tier.hookCount + tier.marketplaceCount} defaultOpen={false}>
                <div className="text-[12px] text-gray-500 space-y-1">
                  {tier.hookCount > 0 && (
                    <div>Hooks: {Object.keys((draft?.hooks as Record<string, any>) ?? {}).length} groups</div>
                  )}
                  {tier.marketplaceCount > 0 && (
                    <div>
                      Marketplaces:{" "}
                      <span className="font-mono text-[11px]">
                        {Object.keys((draft?.extraKnownMarketplaces as Record<string, any>) ?? {}).join(", ")}
                      </span>
                    </div>
                  )}
                </div>
              </SubSection>
            )}

            {/* Permissions hint */}
            {lockReason && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 text-[12px] text-amber-700">
                <Lock size={12} />
                {lockReason}
              </div>
            )}

            {/* Save */}
            {canEdit && (
              <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-100">
                {err && <span className="text-[12px] text-red-600">{err}</span>}
                {saved && (
                  <span className="text-[12px] text-emerald-600 flex items-center gap-1">
                    <Check size={13} /> saved
                  </span>
                )}
                <button
                  onClick={handleSave}
                  disabled={saving || disabled}
                  className="px-4 h-8 rounded-lg bg-gray-900 text-white text-xs font-medium hover:bg-gray-800 disabled:opacity-50 transition-colors"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function StatChip({ label, value }: { label: string; value: number }) {
  return (
    <span className="text-[10px] text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded-full font-medium tabular-nums">
      {value} <span className="text-gray-400">{label}</span>
    </span>
  )
}

function SubSection({
  title,
  count,
  defaultOpen,
  children,
}: {
  title: string
  count: number
  defaultOpen: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 mb-2 hover:text-gray-900 transition-colors"
      >
        {open ? <ChevronDown size={12} className="text-gray-400" /> : <ChevronRight size={12} className="text-gray-400" />}
        <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">{title}</span>
        <span className="text-[10px] text-gray-400 tabular-nums">{count}</span>
      </button>
      {open && <div className="ml-3 pl-3 border-l-2 border-gray-100">{children}</div>}
    </div>
  )
}
