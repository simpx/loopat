import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { useWorkspace } from "@/ctx"
import { getTiers, saveTierSettings, createProfile, deleteProfile, type TierInfo, type TiersResponse } from "@/api"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { McpServerEditor, mcpServersFromJson } from "./McpServerEditor"
import { PluginToggleList } from "./PluginToggleList"
import { ChevronDown, ChevronRight, Lock, RefreshCw, Check, Layers, AlertCircle, Globe, User, Blocks, FolderGit2, FileCode2, Plus, Store, Trash2 } from "lucide-react"

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

/** Map tier id to a Context page URL for editing the raw settings.json file. */
function tierContextUrl(tier: TierInfo): { vault: string; file: string } | null {
  if (tier.id === "team") return { vault: "knowledge", file: ".loopat/.claude/settings.json" }
  if (tier.id.startsWith("profile:")) {
    const name = tier.id.slice("profile:".length)
    return { vault: "knowledge", file: `.loopat/profiles/${name}/.claude/settings.json` }
  }
  if (tier.id === "personal") return { vault: "personal", file: ".loopat/.claude/settings.json" }
  return null
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
  const [searchParams, setSearchParams] = useSearchParams()

  // expanded state synced to URL ?expand=personal,profile:dev
  const expandParam = searchParams.get("expand") ?? "personal"
  const expanded = new Set<string>(expandParam.split(",").filter(Boolean))
  const setExpanded = (next: Set<string>) => {
    const val = [...next].join(",")
    if (val) setSearchParams({ expand: val }, { replace: true })
    else setSearchParams({}, { replace: true })
  }

  const [profilesOpen, setProfilesOpen] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    const d = await getTiers()
    setData(d)
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const toggleExpand = (id: string) => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpanded(next)
  }

  const all = data?.tiers ?? []
  const profileTiers = all.filter((t) => t.id.startsWith("profile:"))
  const nonProfileTiers = all.filter((t) => !t.id.startsWith("profile:")).sort((a, b) => tierOrder(a.id) - tierOrder(b.id))

  // Summed stats across all profiles
  const profileSummary = {
    pluginCount: profileTiers.reduce((s, t) => s + t.pluginCount, 0),
    mcpServerCount: profileTiers.reduce((s, t) => s + t.mcpServerCount, 0),
    overrideCount: profileTiers.reduce((s, t) => s + Object.keys(t.overrides).length, 0),
  }

  // Build summary bar tiles: team, profiles-group, personal, project, local
  const summaryTiles = [
    ...nonProfileTiers.filter((t) => tierOrder(t.id) < 3),
    ...(profileTiers.length > 0 ? [{ id: "__profiles__", label: `Profiles (${profileTiers.length})`, tier: profileTiers[0], isGroup: true }] : []),
    ...nonProfileTiers.filter((t) => tierOrder(t.id) >= 3),
  ] as Array<TierInfo | { id: string; label: string; tier: TierInfo; isGroup: true }>

  if (loading && !data) {
    return <div className="flex items-center gap-2 py-12 justify-center text-[13px] text-gray-400"><RefreshCw size={13} className="animate-spin" /> loading tiers…</div>
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Intro + stats bar */}
      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden transition-shadow hover:shadow-sm">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2.5">
          <Layers size={15} className="text-gray-400" />
          <div>
            <span className="text-[13px] font-medium text-gray-900">Claude Config Composition</span>
            <span className="text-[11px] text-gray-400 ml-2">
              {all.filter((t) => t.exists).length} active tiers · merged at loop spawn
            </span>
          </div>
          <div className="flex-1" />
          <button onClick={refresh} disabled={loading} className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors">
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        {/* Tier summary bar */}
        <div className="flex flex-wrap gap-px bg-gray-100">
          {summaryTiles.map((tile) => {
            if ("isGroup" in tile) {
              return <ProfilesTileButton key="__profiles__" profiles={profileTiers} expanded={expanded} summary={profileSummary} open={profilesOpen} onToggle={() => setProfilesOpen(!profilesOpen)} />
            }
            const tier = tile as TierInfo
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

        {/* Profiles expansion — full width below the tiles row */}
        {profilesOpen && profileTiers.length > 0 && (
          <div className="border-t border-gray-200 bg-gray-50/50 px-4 py-2 space-y-0.5">
            <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-1 mb-1">
              Select a profile to expand
            </div>
            {profileTiers.map((p) => {
              const isExp = expanded.has(p.id)
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    toggleExpand(p.id)
                    setProfilesOpen(false)
                    // scroll to the expanded tier detail
                    setTimeout(() => {
                      document.getElementById(`tier-${p.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
                    }, 50)
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-white/80 text-left transition-colors"
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isExp ? "bg-blue-400" : "bg-gray-300"}`} />
                  <span className="text-[12px] text-gray-700 flex-1">{p.label.replace("Profile: ", "")}</span>
                  <span className="text-[10px] text-gray-400 tabular-nums shrink-0">
                    {p.pluginCount > 0 && <>{p.pluginCount}p </>}
                    {p.mcpServerCount > 0 && <>{p.mcpServerCount}m</>}
                    {!p.pluginCount && !p.mcpServerCount && "—"}
                  </span>
                  {isExp && <ChevronDown size={9} className="text-blue-400 shrink-0" />}
                </button>
              )
            })}
            {/* Create profile (admin only) */}
            {isAdmin && (
              <CreateProfileButton
                onCreated={(name) => {
                  setProfilesOpen(false)
                  refresh().then(() => {
                    // Auto-expand the new profile
                    const newId = `profile:${name}`
                    toggleExpand(newId)
                    setTimeout(() => {
                      document.getElementById(`tier-${newId}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
                    }, 100)
                  })
                }}
              />
            )}
          </div>
        )}
      </div>

      {/* Expanded tier detail — profile tiers rendered after non-profiles */}
      {[...nonProfileTiers, ...profileTiers].map((tier) => (
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
  const isProfile = tier.id.startsWith("profile:")
  const profileName = isProfile ? tier.id.slice("profile:".length) : ""
  const lockReason = !canEdit && tier.managedBy === "admin" && !isAdmin ? "Admin access required" : null

  const [draft, setDraft] = useState<Record<string, any>>({})
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const navigate = useNavigate()
  const focusMarketplaceRef = useRef<(() => void) | null>(null)

  const ctxUrl = tierContextUrl(tier)

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
    <div id={`tier-${tier.id}`} className={`rounded-lg border overflow-hidden transition-shadow hover:shadow-sm ${canEdit ? "border-gray-200 bg-white" : "border-gray-200 bg-gray-50/50"}`}>
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
          {tier.toolchainCount > 0 && <StatChip label="Toolchain" value={tier.toolchainCount} />}
          {overrideCount > 0 && (
            <span className="text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full font-medium">
              {overrideCount} override{overrideCount > 1 ? "s" : ""}
            </span>
          )}
        </div>
        {/* Edit raw in Context */}
        {ctxUrl && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => navigate(`/context/${ctxUrl.vault}?file=${encodeURIComponent(ctxUrl.file)}&edit=1`)}
                className="shrink-0 p-1.5 rounded-lg text-gray-300 hover:text-gray-600 hover:bg-gray-100 transition-colors"
              >
                <FileCode2 size={13} />
              </button>
            </TooltipTrigger>
            <TooltipContent>edit {ctxUrl.vault}/{ctxUrl.file}</TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Body */}
      <div className="px-4 py-4 space-y-5">
        {isSdk ? (
          <div className="rounded-lg bg-gray-50 px-3 py-2.5 text-[12px] text-gray-500">
            SDK-managed — read directly from <code className="bg-gray-100 px-1 rounded text-[11px]">{tier.path}</code>. Not editable here.
          </div>
        ) : (
          <>
            {/* File links */}
            {ctxUrl && (
              <div className="flex items-center gap-2 text-[11px] text-gray-400">
                <button
                  onClick={() => navigate(`/context/${ctxUrl.vault}?file=${encodeURIComponent(ctxUrl.file)}&edit=1`)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
                >
                  <FileCode2 size={11} />
                  edit settings.json
                </button>
                {tier.claudeMd !== null && (
                  <button
                    onClick={() => navigate(`/context/${ctxUrl.vault}?file=${encodeURIComponent(ctxUrl.file.replace("settings.json", "CLAUDE.md"))}`)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
                  >
                    view CLAUDE.md
                  </button>
                )}
                <span className="text-gray-300">·</span>
                <span className="text-gray-400 truncate font-mono text-[10px]">{ctxUrl.vault}/{ctxUrl.file}</span>
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
                  focusMarketplaceRef={focusMarketplaceRef}
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

            {/* Marketplaces */}
            <SubSection
              title="Marketplaces"
              count={tier.marketplaceCount}
              defaultOpen={tier.marketplaceCount > 0 || canEdit}
            >
              <MarketplaceEditor
                marketplaces={(draft?.extraKnownMarketplaces as Record<string, any>) ?? {}}
                readonly={!canEdit || disabled}
                onChange={(mps) => setDraft((d) => d ? { ...d, extraKnownMarketplaces: mps } : { extraKnownMarketplaces: mps })}
                focusRef={focusMarketplaceRef}
              />
            </SubSection>

            {/* Hooks (summary only) */}
            {tier.hookCount > 0 && (
              <SubSection title="Hooks" count={tier.hookCount} defaultOpen={false}>
                <div className="text-[12px] text-gray-500">
                  {Object.keys((draft?.hooks as Record<string, any>) ?? {}).length} hook groups configured.
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

            {/* Delete profile (admin only) */}
            {isProfile && isAdmin && (
              <div className="flex items-center justify-between pt-3 border-t border-gray-100">
                <button
                  onClick={async () => {
                    if (!confirm(`Delete profile "${profileName}"? This removes all its .claude/ contents permanently.`)) return
                    const r = await deleteProfile(profileName)
                    if (!r.ok) { setErr(r.error ?? "delete failed"); return }
                    onSaved()
                  }}
                  className="px-3 h-7 rounded-lg text-[11px] text-red-500 hover:bg-red-50 hover:text-red-600 transition-colors"
                >
                  Delete profile
                </button>
                <div className="flex items-center gap-2">
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
              </div>
            )}

            {/* Save (non-profile tiers) */}
            {canEdit && !isProfile && (
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

// ── marketplace editor ──

/** Extract a repo name from a git URL. e.g. "https://github.com/owner/repo.git" → "repo" */
function extractNameFromUrl(url: string): string {
  try {
    // Strip trailing .git and query/hash
    let cleaned = url.trim().replace(/\.git$/, "").split(/[?#]/)[0]
    // Get last path segment
    const parts = cleaned.replace(/\/$/, "").split("/")
    return parts[parts.length - 1] || ""
  } catch { return "" }
}

export function MarketplaceEditor({
  marketplaces,
  readonly,
  onChange,
  focusRef,
}: {
  marketplaces: Record<string, any>
  readonly?: boolean
  onChange: (mps: Record<string, any>) => void
  focusRef?: React.MutableRefObject<(() => void) | null>
}) {
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState("")
  const [newSource, setNewSource] = useState<"git" | "github" | "directory">("git")
  const [newValue, setNewValue] = useState("")
  const [newBranch, setNewBranch] = useState("main")
  const [nameTouched, setNameTouched] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  // Expose a focus function to the parent via ref
  useEffect(() => {
    if (focusRef) {
      focusRef.current = () => {
        setAdding(true)
        setTimeout(() => nameInputRef.current?.focus(), 50)
      }
    }
  }, [focusRef])

  const entries = Object.entries(marketplaces)

  const add = () => {
    const name = newName.trim()
    if (!name || !newValue.trim()) return
    let source: any
    switch (newSource) {
      case "git": source = { source: "git", url: newValue.trim() }; break
      case "github": source = { source: "github", repo: newValue.trim() }; break
      case "directory": source = { source: "directory", path: newValue.trim() }; break
    }
    if (newSource !== "directory" && newBranch.trim() && newBranch.trim() !== "main") {
      source.branch = newBranch.trim()
    }
    onChange({ ...marketplaces, [name]: { source } })
    setNewName("")
    setNewValue("")
    setNewBranch("main")
    setNameTouched(false)
    setAdding(false)
  }

  const remove = (name: string) => {
    const { [name]: _, ...rest } = marketplaces
    onChange(rest)
  }

  return (
    <div className="space-y-1">
      {entries.length === 0 && !adding && (
        <div className="text-[12px] text-gray-400 italic py-2">
          No additional marketplaces. The built-in marketplace is always available.
        </div>
      )}
      {entries.map(([name, entry]) => {
        const src = entry?.source ?? {}
        const branch = src?.branch
    const srcLabel = src.source === "git" ? `git ${src.url ?? ""}${branch ? ` @${branch}` : ""}`
          : src.source === "github" ? `github:${src.repo ?? ""}${branch ? ` @${branch}` : ""}`
          : src.source === "directory" ? `dir: ${src.path ?? ""}`
          : JSON.stringify(src)
        return (
          <div key={name} className="group flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-50 transition-colors">
            <Store size={13} className="text-gray-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-medium text-gray-800 truncate">{name}</div>
              <div className="text-[11px] text-gray-400 font-mono truncate">{srcLabel}</div>
            </div>
            {!readonly && (
              <button
                onClick={() => remove(name)}
                className="shrink-0 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                title="remove"
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        )
      })}

      {adding && (
        <div className="rounded-lg border border-gray-200 bg-gray-50/50 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <input
              ref={nameInputRef}
              autoFocus
              value={newName}
              onChange={(e) => { setNewName(e.target.value); setNameTouched(true) }}
              onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") { setAdding(false); setNewName(""); setNameTouched(false) } }}
              placeholder="marketplace name"
              className="flex-1 min-w-0 border border-gray-300 rounded px-2.5 py-1.5 text-[12px] outline-none focus:border-gray-900 bg-white"
            />
            <select
              value={newSource}
              onChange={(e) => { setNewSource(e.target.value as any); if (e.target.value === "directory") { setNameTouched(true) } }}
              className="w-24 shrink-0 border border-gray-300 rounded px-2 py-1.5 text-[12px] outline-none focus:border-gray-900 bg-white"
            >
              <option value="git">git URL</option>
              <option value="github">github repo</option>
              <option value="directory">directory</option>
            </select>
          </div>
          <input
            value={newValue}
            onChange={(e) => {
              setNewValue(e.target.value)
              // Auto-fill name from URL if not manually edited
              if ((newSource === "git" || newSource === "github") && !nameTouched) {
                const extracted = extractNameFromUrl(e.target.value)
                if (extracted) setNewName(extracted)
              }
            }}
            placeholder={newSource === "git" ? "https://..." : newSource === "github" ? "owner/repo" : "/path/to/marketplace"}
            className="ip text-[12px] w-full font-mono"
          />
          {newSource !== "directory" && (
            <input
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              placeholder="branch (default: main)"
              className="ip text-[12px] w-full font-mono"
            />
          )}
          <div className="flex items-center gap-2">
            <button onClick={add} className="px-3 h-7 rounded-lg bg-gray-900 text-white text-[11px] font-medium hover:bg-gray-800">Add</button>
            <button onClick={() => { setAdding(false); setNewName(""); setNewValue("") }} className="text-[11px] text-gray-400 hover:text-gray-600">Cancel</button>
          </div>
        </div>
      )}

      {!readonly && (
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 px-3 py-2 text-[12px] text-gray-400 hover:text-gray-700 hover:bg-gray-50 rounded-lg w-full transition-colors"
        >
          <Plus size={13} />
          Add marketplace source
        </button>
      )}
    </div>
  )
}

// ── profiles dropdown tile ──

function ProfilesTileButton({
  profiles,
  expanded,
  summary,
  open,
  onToggle,
}: {
  profiles: TierInfo[]
  expanded: Set<string>
  summary: { pluginCount: number; mcpServerCount: number; overrideCount: number }
  open: boolean
  onToggle: () => void
}) {
  const anyExpanded = profiles.some((p) => expanded.has(p.id))

  return (
    <button
      type="button"
      onClick={onToggle}
      className={`flex-1 min-w-[120px] flex items-center gap-2 px-3 py-2.5 bg-white hover:bg-gray-50 transition-colors text-left ${anyExpanded || open ? "bg-gray-50" : ""}`}
    >
      <Blocks size={14} className="text-blue-400 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium text-gray-700 truncate">
            Profiles ({profiles.length})
          </span>
        </div>
        <div className="text-[10px] text-gray-400 mt-0.5 flex items-center gap-1.5">
          {summary.pluginCount > 0 && <span>{summary.pluginCount}p</span>}
          {summary.mcpServerCount > 0 && <span>{summary.mcpServerCount}m</span>}
          {summary.pluginCount === 0 && summary.mcpServerCount === 0 && <span>—</span>}
          {summary.overrideCount > 0 && (
            <span className="text-amber-500">{summary.overrideCount}↗</span>
          )}
        </div>
      </div>
      {open ? <ChevronDown size={10} className="text-gray-400 shrink-0" /> : <ChevronRight size={10} className="text-gray-400 shrink-0" />}
    </button>
  )
}

// ── profile lifecycle helpers ──

function CreateProfileButton({ onCreated }: { onCreated: (name: string) => void }) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState("")
  const [err, setErr] = useState<string | null>(null)

  const create = async () => {
    const n = name.trim()
    if (!n) return
    setErr(null)
    const r = await createProfile(n)
    if (!r.ok) { setErr(r.error ?? "create failed"); return }
    setName("")
    setAdding(false)
    onCreated(n)
  }

  if (!adding) {
    return (
      <button
        onClick={() => setAdding(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-gray-400 hover:text-gray-700 hover:bg-white/80 rounded w-full transition-colors"
      >
        <Plus size={12} />
        Create profile
      </button>
    )
  }

  return (
    <div className="px-3 py-1.5 space-y-1.5">
      <input
        autoFocus
        value={name}
        onChange={(e) => { setName(e.target.value); setErr(null) }}
        onKeyDown={(e) => { if (e.key === "Enter") create(); if (e.key === "Escape") { setAdding(false); setName("") } }}
        placeholder="profile name"
        className="flex-1 min-w-0 border border-gray-300 rounded px-2.5 py-1.5 text-[12px] outline-none focus:border-gray-900 bg-white w-full"
      />
      {err && <div className="text-[11px] text-red-600">{err}</div>}
      <div className="flex items-center gap-2">
        <button onClick={create} className="px-3 h-7 rounded-lg bg-gray-900 text-white text-[11px] font-medium hover:bg-gray-800">Create</button>
        <button onClick={() => { setAdding(false); setName(""); setErr(null) }} className="text-[11px] text-gray-400 hover:text-gray-600">Cancel</button>
      </div>
    </div>
  )
}
