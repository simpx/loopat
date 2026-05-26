import { useCallback, useEffect, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { useWorkspace } from "@/ctx"
import { getTiers, getTierMiseConfig, saveTierMiseConfig, createProfile, deleteProfile, type TierInfo, type TiersResponse } from "@/api"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import {
  ChevronDown, ChevronRight, Lock, RefreshCw, Check, Layers,
  Globe, User, Blocks, FolderGit2, FileCode2, Plus, Trash2, Terminal,
} from "lucide-react"

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

function miseContextUrl(tier: TierInfo): { vault: string; file: string } | null {
  if (tier.id === "team") return { vault: "knowledge", file: ".loopat/.claude/mise.toml" }
  if (tier.id.startsWith("profile:")) {
    const name = tier.id.slice("profile:".length)
    return { vault: "knowledge", file: `.loopat/profiles/${name}/.claude/mise.toml` }
  }
  if (tier.id === "personal") return { vault: "personal", file: ".loopat/.claude/mise.toml" }
  return null
}

// ── TOML [tools] parsing ──

type ToolEntry = { name: string; version: string }

function parseTools(content: string): ToolEntry[] {
  const tools: ToolEntry[] = []
  const toolsIdx = content.search(/^\[tools\]\s*$/m)
  if (toolsIdx < 0) return tools
  const sectionStart = content.indexOf("\n", toolsIdx) + 1
  const rest = content.slice(sectionStart)
  const nextSection = rest.search(/^\[[^\]]+\]/m)
  const sectionBody = nextSection >= 0 ? rest.slice(0, nextSection) : rest

  for (const line of sectionBody.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const m = trimmed.match(/^(\S+)\s*=\s*(.+)$/)
    if (!m) continue
    let version = m[2].trim()
    if ((version.startsWith('"') && version.endsWith('"')) ||
        (version.startsWith("'") && version.endsWith("'"))) {
      version = version.slice(1, -1)
    }
    tools.push({ name: m[1], version })
  }
  return tools
}

function rebuildMiseToml(original: string, tools: ToolEntry[]): string {
  if (tools.length === 0) {
    const withoutTools = original.replace(/^\[tools\].*?(?=^\[[^\]]+\]|\s*$)/ms, "").trimEnd()
    return withoutTools.replace(/^\[tools\]\s*$/m, "").replace(/\n{3,}/g, "\n\n").trim() + "\n"
  }

  const toolLines = tools.map(t => `${t.name} = "${t.version}"`).join("\n")

  if (/^\[tools\]/m.test(original)) {
    return original.replace(
      /^\[tools\].*?(?=^\[[^\]]+\]|\s*$)/ms,
      `[tools]\n${toolLines}\n`,
    ).trimEnd() + "\n"
  }

  const header = `[tools]\n${toolLines}\n`
  return (header + "\n" + original).trimEnd() + "\n"
}

// ── main panel ──

export function MiseConfigPanel({ disabled: parentDisabled }: { disabled?: boolean }) {
  const ws = useWorkspace()
  const isAdmin = ws.currentUser?.role === "admin"

  const [data, setData] = useState<TiersResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [searchParams, setSearchParams] = useSearchParams()

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

  const profileToolSum = profileTiers.reduce((s, t) => s + t.toolchainCount, 0)

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
      {/* Header */}
      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden transition-shadow hover:shadow-sm">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2.5">
          <Terminal size={15} className="text-gray-400" />
          <div>
            <span className="text-[13px] font-medium text-gray-900">Mise Config</span>
            <span className="text-[11px] text-gray-400 ml-2">
              mise.toml per tier — toolchain tools, env vars, settings
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
              return (
                <ProfilesTileButton
                  key="__profiles__"
                  profiles={profileTiers}
                  expanded={expanded}
                  toolSum={profileToolSum}
                  open={profilesOpen}
                  onToggle={() => setProfilesOpen(!profilesOpen)}
                />
              )
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
                  <div className="text-[10px] text-gray-400 mt-0.5">
                    {tier.toolchainCount > 0 ? `${tier.toolchainCount} tools` : tier.exists ? "0 tools" : "—"}
                  </div>
                </div>
                {isExp ? <ChevronDown size={10} className="text-gray-400 shrink-0" /> : <ChevronRight size={10} className="text-gray-400 shrink-0" />}
              </button>
            )
          })}
        </div>

        {/* Profiles expansion — dropdown below the tiles */}
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
                    setTimeout(() => {
                      document.getElementById(`tier-${p.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
                    }, 50)
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-white/80 text-left transition-colors"
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isExp ? "bg-blue-400" : "bg-gray-300"}`} />
                  <span className="text-[12px] text-gray-700 flex-1">{p.label.replace("Profile: ", "")}</span>
                  <span className="text-[10px] text-gray-400 tabular-nums shrink-0">
                    {p.toolchainCount > 0 ? `${p.toolchainCount} tools` : "—"}
                  </span>
                  {isExp && <ChevronDown size={9} className="text-blue-400 shrink-0" />}
                </button>
              )
            })}
            {isAdmin && (
              <CreateProfileButton
                onCreated={(name) => {
                  setProfilesOpen(false)
                  refresh().then(() => {
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

      {/* Expanded tier details */}
      {[...nonProfileTiers, ...profileTiers].map((tier) => (
        <MiseTierDetail
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

// ── profiles tile button ──

function ProfilesTileButton({
  profiles,
  expanded,
  toolSum,
  open,
  onToggle,
}: {
  profiles: TierInfo[]
  expanded: Set<string>
  toolSum: number
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
        <div className="text-[10px] text-gray-400 mt-0.5">
          {toolSum > 0 ? `${toolSum} tools` : "—"}
        </div>
      </div>
      {open ? <ChevronDown size={10} className="text-gray-400 shrink-0" /> : <ChevronRight size={10} className="text-gray-400 shrink-0" />}
    </button>
  )
}

// ── create profile button ──

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

// ── tier detail card ──

function MiseTierDetail({
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
  const navigate = useNavigate()
  const ctxUrl = miseContextUrl(tier)

  const [content, setContent] = useState("")
  const [tools, setTools] = useState<ToolEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [editMode, setEditMode] = useState<"tools" | "raw">("tools")

  useEffect(() => {
    if (!isExpanded) return
    ;(async () => {
      const r = await getTierMiseConfig(tier.id)
      const c = r.exists ? r.content : ""
      setContent(c)
      setTools(parseTools(c))
      setLoaded(true)
      setErr(null)
      setSaved(false)
    })()
  }, [isExpanded, tier.id])

  const handleSave = async () => {
    setSaving(true)
    setErr(null)
    const newContent = editMode === "tools" ? rebuildMiseToml(content, tools) : content
    const r = await saveTierMiseConfig(tier.id, newContent)
    setSaving(false)
    if (!r.ok) { setErr(r.error ?? "save failed"); return }
    setContent(newContent)
    setTools(parseTools(newContent))
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
    onSaved()
  }

  const addTool = () => {
    setTools([...tools, { name: "", version: "" }])
  }

  const updateTool = (idx: number, patch: Partial<ToolEntry>) => {
    setTools(tools.map((t, i) => i === idx ? { ...t, ...patch } : t))
  }

  const removeTool = (idx: number) => {
    setTools(tools.filter((_, i) => i !== idx))
  }

  const onRawChange = (val: string) => {
    setContent(val)
    setTools(parseTools(val))
  }

  if (!loaded) {
    return (
      <div id={`tier-${tier.id}`} className="rounded-lg border border-gray-200 bg-white p-4 text-[12px] text-gray-400 italic">
        loading mise.toml…
      </div>
    )
  }

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
        <span className="hidden sm:inline text-[10px] text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded-full font-medium tabular-nums">
          {tools.length} tool{tools.length !== 1 ? "s" : ""}
        </span>
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
      <div className="px-4 py-4 space-y-4">
        {isSdk ? (
          <div className="rounded-lg bg-gray-50 px-3 py-2.5 text-[12px] text-gray-500">
            SDK-managed — mise.toml is read from <code className="bg-gray-100 px-1 rounded text-[11px]">{tier.path}/mise.toml</code>. Not editable here.
          </div>
        ) : (
          <>
            {/* Edit mode tabs */}
            <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5 w-fit">
              <button
                onClick={() => setEditMode("tools")}
                className={`px-3 py-1 rounded text-[11px] font-medium transition-colors ${editMode === "tools" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
              >
                Tools
              </button>
              <button
                onClick={() => setEditMode("raw")}
                className={`px-3 py-1 rounded text-[11px] font-medium transition-colors ${editMode === "raw" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
              >
                Raw TOML
              </button>
            </div>

            {editMode === "tools" ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                    Toolchain Tools
                  </span>
                  {canEdit && !disabled && (
                    <button
                      onClick={addTool}
                      className="text-[11px] text-gray-500 hover:text-gray-900 inline-flex items-center gap-1 transition-colors"
                    >
                      <Plus size={11} /> add tool
                    </button>
                  )}
                </div>

                {tools.length === 0 ? (
                  <div className="text-[12px] text-gray-400 italic py-3">No tools configured. Add one to get started.</div>
                ) : (
                  <div className="border border-gray-200 rounded-lg overflow-hidden">
                    <table className="w-full text-[13px]">
                      <thead>
                        <tr className="border-b border-gray-100 bg-gray-50/50 text-left text-[10px] text-gray-500 uppercase tracking-wider">
                          <th className="px-3 py-2 font-medium">Tool</th>
                          <th className="px-3 py-2 font-medium">Version</th>
                          {canEdit && !disabled && <th className="px-3 py-2 font-medium w-10"></th>}
                        </tr>
                      </thead>
                      <tbody>
                        {tools.map((t, idx) => (
                          <tr key={idx} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                            <td className="px-3 py-2">
                              {canEdit && !disabled ? (
                                <input
                                  value={t.name}
                                  onChange={(e) => updateTool(idx, { name: e.target.value })}
                                  placeholder="e.g. python"
                                  className="w-full px-2 py-1 border border-gray-300 rounded text-[12px] outline-none bg-white focus:border-gray-900 font-mono"
                                />
                              ) : (
                                <code className="text-[12px] text-gray-800">{t.name}</code>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              {canEdit && !disabled ? (
                                <input
                                  value={t.version}
                                  onChange={(e) => updateTool(idx, { version: e.target.value })}
                                  placeholder="e.g. 3.12"
                                  className="w-28 px-2 py-1 border border-gray-300 rounded text-[12px] outline-none bg-white focus:border-gray-900 font-mono"
                                />
                              ) : (
                                <code className="text-[12px] text-gray-600">{t.version}</code>
                              )}
                            </td>
                            {canEdit && !disabled && (
                              <td className="px-3 py-2">
                                <button
                                  onClick={() => removeTool(idx)}
                                  className="text-gray-300 hover:text-red-500 transition-colors"
                                >
                                  <Trash2 size={12} />
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {tools.length > 0 && (
                  <details className="text-[11px]">
                    <summary className="text-gray-400 cursor-pointer hover:text-gray-600">preview generated TOML</summary>
                    <pre className="mt-2 p-3 bg-gray-50 border border-gray-200 rounded text-[11px] font-mono text-gray-700 overflow-auto max-h-32">
                      {`[tools]\n${tools.map(t => `${t.name || "?"} = "${t.version || "?"}"`).join("\n")}`}
                    </pre>
                  </details>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                  Raw mise.toml
                </span>
                <textarea
                  value={content}
                  onChange={(e) => onRawChange(e.target.value)}
                  readOnly={!canEdit || disabled}
                  placeholder={`[tools]\npython = "3.12"\nnode = "22"\n\n[env]\n# MY_VAR = "value"\n\n[settings]\n# experimental = true\n`}
                  className="w-full h-64 px-3 py-2 border border-gray-300 rounded text-[12px] font-mono outline-none bg-white focus:border-gray-900 resize-y disabled:bg-gray-50 disabled:text-gray-500"
                  spellCheck={false}
                />
              </div>
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
