import { useCallback, useEffect, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { useWorkspace } from "@/ctx"
import { getTiers, getTierMiseConfig, saveTierMiseConfig, createProfile, deleteProfile, getAdminPresets, type TierInfo, type TiersResponse, type MiseToolPreset } from "@/api"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { parse as parseToml, stringify as stringifyToml } from "smol-toml"
import {
  ChevronDown, ChevronRight, Lock, RefreshCw, Check, Layers,
  Globe, User, Blocks, FolderGit2, FileCode2, Plus, Trash2, Terminal,
  ExternalLink,
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

// ── input styling ──

const inputClass = "w-full px-2.5 py-1.5 border border-gray-300 rounded text-[12px] outline-none bg-white focus:border-gray-900 focus:ring-1 focus:ring-gray-900 transition-colors font-mono"
const inputClassSm = "w-full px-2 py-1 border border-gray-300 rounded text-[11px] outline-none bg-white focus:border-gray-900 font-mono"

// ── TOML parse/rebuild ──

type MiseData = {
  tools: Record<string, { version: string; backend?: string }>
  env: Record<string, string>
  envFile: string
  envPath: string[]
  tasks: Record<string, MiseTask>
  alias: Record<string, Record<string, string>>
  settings: Record<string, any>
  plugins: Record<string, string>
  hooks: Record<string, string>
}

type MiseTask = {
  description?: string
  run?: string
  dir?: string
  depends?: string[]
  waitFor?: string[]
  sources?: string[]
  outputs?: string[]
  hide?: boolean
  raw?: boolean
  env?: Record<string, string>
  runWindows?: string
}

function parseMiseToml(content: string): MiseData {
  let parsed: Record<string, any> = {}
  try { parsed = parseToml(content) as Record<string, any> } catch { /* raw edit fallback */ }

  // ── tools ──
  const tools: Record<string, { version: string; backend?: string }> = {}
  if (parsed.tools && typeof parsed.tools === "object") {
    for (const [k, v] of Object.entries(parsed.tools as Record<string, any>)) {
      if (k.startsWith("_")) continue
      if (typeof v === "string") {
        tools[k] = { version: v }
      } else if (v && typeof v === "object") {
        tools[k] = {
          version: typeof v.version === "string" ? v.version : String(v.version ?? ""),
          backend: typeof v.backend === "string" ? v.backend : undefined,
        }
      }
    }
  }

  // ── env ──
  const env: Record<string, string> = {}
  let envFile = ""
  let envPath: string[] = []
  if (parsed.env && typeof parsed.env === "object") {
    for (const [k, v] of Object.entries(parsed.env as Record<string, any>)) {
      if (k === "_.file" && typeof v === "string") { envFile = v; continue }
      if (k === "_.path" && Array.isArray(v)) { envPath = v.map(String); continue }
      if (typeof v === "string") env[k] = v
      else if (Array.isArray(v)) env[k] = v.join(":")
      else if (v != null) env[k] = String(v)
    }
  }

  // ── tasks ──
  const tasks: Record<string, MiseTask> = {}
  if (parsed.tasks && typeof parsed.tasks === "object") {
    for (const [k, v] of Object.entries(parsed.tasks as Record<string, any>)) {
      if (!v || typeof v !== "object") continue
      const runWin = (v as any)?.run_windows
      const t: MiseTask = {
        description: typeof v.description === "string" ? v.description : undefined,
        run: typeof v.run === "string" ? v.run : undefined,
        dir: typeof v.dir === "string" ? v.dir : undefined,
        depends: Array.isArray(v.depends) ? v.depends.map(String) : undefined,
        waitFor: Array.isArray(v.wait_for) ? v.wait_for.map(String) : undefined,
        sources: Array.isArray(v.sources) ? v.sources.map(String) : undefined,
        outputs: Array.isArray(v.outputs) ? v.outputs.map(String) : undefined,
        hide: typeof v.hide === "boolean" ? v.hide : undefined,
        raw: typeof v.raw === "boolean" ? v.raw : undefined,
        env: v.env && typeof v.env === "object" ? Object.fromEntries(
          Object.entries(v.env as Record<string, any>).map(([ek, ev]) => [ek, String(ev)])
        ) : undefined,
        runWindows: typeof runWin === "string" ? runWin : undefined,
      }
      tasks[k] = t
    }
  }

  // ── alias ──
  const alias: Record<string, Record<string, string>> = {}
  if (parsed.alias && typeof parsed.alias === "object") {
    for (const [tool, entries] of Object.entries(parsed.alias as Record<string, any>)) {
      if (entries && typeof entries === "object") {
        alias[tool] = {}
        for (const [k, v] of Object.entries(entries as Record<string, any>)) {
          alias[tool][k] = String(v)
        }
      }
    }
  }

  // ── settings ──
  const settings: Record<string, any> = {}
  if (parsed.settings && typeof parsed.settings === "object") {
    for (const [k, v] of Object.entries(parsed.settings as Record<string, any>)) {
      if (k.startsWith("_")) continue
      settings[k] = v
    }
  }

  // ── plugins ──
  const plugins: Record<string, string> = {}
  if (parsed.plugins && typeof parsed.plugins === "object") {
    for (const [k, v] of Object.entries(parsed.plugins as Record<string, any>)) {
      plugins[k] = v && typeof v === "object" && typeof (v as any).url === "string"
        ? (v as any).url
        : typeof v === "string" ? v : ""
    }
  }

  // ── hooks ──
  const hooks: Record<string, string> = {}
  if (parsed.hooks && typeof parsed.hooks === "object") {
    for (const [k, v] of Object.entries(parsed.hooks as Record<string, any>)) {
      if (typeof v === "string") hooks[k] = v
    }
  }

  return { tools, env, envFile, envPath, tasks, alias, settings, plugins, hooks }
}

function buildMiseToml(data: MiseData): string {
  const obj: Record<string, any> = {}

  // tools
  if (Object.keys(data.tools).length > 0) {
    obj.tools = {} as Record<string, any>
    for (const [k, t] of Object.entries(data.tools)) {
      if (t.backend) {
        obj.tools[k] = { version: t.version, backend: t.backend }
      } else {
        obj.tools[k] = t.version
      }
    }
  }

  // env
  const hasEnv = Object.keys(data.env).length > 0 || data.envFile || data.envPath.length > 0
  if (hasEnv) {
    obj.env = {} as Record<string, any>
    if (data.envFile) (obj.env as any)["_.file"] = data.envFile
    if (data.envPath.length > 0) (obj.env as any)["_.path"] = data.envPath
    Object.assign(obj.env, data.env)
  }

  // tasks
  if (Object.keys(data.tasks).length > 0) {
    obj.tasks = {} as Record<string, any>
    for (const [k, t] of Object.entries(data.tasks)) {
      const taskObj: Record<string, any> = {}
      if (t.description) taskObj.description = t.description
      if (t.run) taskObj.run = t.run
      if (t.dir) taskObj.dir = t.dir
      if (t.depends && t.depends.length > 0) taskObj.depends = t.depends
      if (t.waitFor && t.waitFor.length > 0) taskObj.wait_for = t.waitFor
      if (t.sources && t.sources.length > 0) taskObj.sources = t.sources
      if (t.outputs && t.outputs.length > 0) taskObj.outputs = t.outputs
      if (t.hide !== undefined) taskObj.hide = t.hide
      if (t.raw !== undefined) taskObj.raw = t.raw
      if (t.env && Object.keys(t.env).length > 0) taskObj.env = t.env
      if (t.runWindows) taskObj.run_windows = t.runWindows
      obj.tasks[k] = taskObj
    }
  }

  // alias
  if (Object.keys(data.alias).length > 0) {
    obj.alias = data.alias
  }

  // settings
  if (Object.keys(data.settings).length > 0) {
    obj.settings = data.settings
  }

  // plugins
  if (Object.keys(data.plugins).length > 0) {
    obj.plugins = {} as Record<string, any>
    for (const [k, url] of Object.entries(data.plugins)) {
      obj.plugins[k] = { url }
    }
  }

  // hooks
  if (Object.keys(data.hooks).length > 0) {
    obj.hooks = data.hooks
  }

  if (Object.keys(obj).length === 0) return ""
  return stringifyToml(obj as any)
}

// ── main panel ──

type SectionId = "tools" | "env" | "tasks" | "alias" | "settings" | "plugins" | "hooks" | "raw"

const SECTIONS: { id: SectionId; label: string; desc: string }[] = [
  { id: "tools",    label: "Tools",    desc: "Tool versions (node, python, rust, …)" },
  { id: "env",      label: "Env",      desc: "Environment variables" },
  { id: "tasks",    label: "Tasks",    desc: "Build / run tasks" },
  { id: "alias",    label: "Alias",    desc: "Tool version aliases" },
  { id: "settings", label: "Settings", desc: "mise behavior flags" },
  { id: "plugins",  label: "Plugins",  desc: "asdf plugin sources" },
  { id: "hooks",    label: "Hooks",    desc: "Lifecycle hook commands" },
  { id: "raw",      label: "Raw TOML", desc: "Direct TOML editing" },
]

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
              mise.toml per tier — tools, env, tasks, aliases, settings, plugins, hooks
            </span>
          </div>
          <div className="flex-1" />
          <a
            href="https://mise.jdx.dev/configuration.html"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <ExternalLink size={10} /> docs
          </a>
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
                  <span className={`text-[11px] font-medium truncate ${tier.exists ? "text-gray-700" : "text-gray-400"}`}>
                    {tier.label}
                  </span>
                  <div className="text-[10px] text-gray-400 mt-0.5">
                    {tier.toolchainCount > 0 ? `${tier.toolchainCount} tools` : tier.exists ? "0 tools" : "—"}
                  </div>
                </div>
                {isExp ? <ChevronDown size={10} className="text-gray-400 shrink-0" /> : <ChevronRight size={10} className="text-gray-400 shrink-0" />}
              </button>
            )
          })}
        </div>

        {/* Profiles dropdown */}
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
  profiles, expanded, toolSum, open, onToggle,
}: {
  profiles: TierInfo[]; expanded: Set<string>; toolSum: number; open: boolean; onToggle: () => void
}) {
  const anyExpanded = profiles.some((p) => expanded.has(p.id))
  return (
    <button
      type="button" onClick={onToggle}
      className={`flex-1 min-w-[120px] flex items-center gap-2 px-3 py-2.5 bg-white hover:bg-gray-50 transition-colors text-left ${anyExpanded || open ? "bg-gray-50" : ""}`}
    >
      <Blocks size={14} className="text-blue-400 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="text-[11px] font-medium text-gray-700">Profiles ({profiles.length})</span>
        <div className="text-[10px] text-gray-400 mt-0.5">{toolSum > 0 ? `${toolSum} tools` : "—"}</div>
      </div>
      {open ? <ChevronDown size={10} className="text-gray-400 shrink-0" /> : <ChevronRight size={10} className="text-gray-400 shrink-0" />}
    </button>
  )
}

// ── create profile ──

function CreateProfileButton({ onCreated }: { onCreated: (name: string) => void }) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const create = async () => {
    const n = name.trim(); if (!n) return; setErr(null)
    const r = await createProfile(n)
    if (!r.ok) { setErr(r.error ?? "create failed"); return }
    setName(""); setAdding(false); onCreated(n)
  }
  if (!adding) return (
    <button onClick={() => setAdding(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-gray-400 hover:text-gray-700 hover:bg-white/80 rounded w-full transition-colors">
      <Plus size={12} /> Create profile
    </button>
  )
  return (
    <div className="px-3 py-1.5 space-y-1.5">
      <input autoFocus value={name} onChange={(e) => { setName(e.target.value); setErr(null) }}
        onKeyDown={(e) => { if (e.key === "Enter") create(); if (e.key === "Escape") { setAdding(false); setName("") } }}
        placeholder="profile name" className={inputClass} />
      {err && <div className="text-[11px] text-red-600">{err}</div>}
      <div className="flex items-center gap-2">
        <button onClick={create} className="px-3 h-7 rounded-lg bg-gray-900 text-white text-[11px] font-medium hover:bg-gray-800">Create</button>
        <button onClick={() => { setAdding(false); setName(""); setErr(null) }} className="text-[11px] text-gray-400 hover:text-gray-600">Cancel</button>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// Tier detail card — the main editor for a single tier
// ═══════════════════════════════════════════════════════════════

function MiseTierDetail({
  tier, isAdmin, isExpanded, disabled, onSaved,
}: {
  tier: TierInfo; isAdmin: boolean; isExpanded: boolean; disabled?: boolean; onSaved: () => void
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

  const [rawContent, setRawContent] = useState("")
  const [data, setData] = useState<MiseData>({ tools: {}, env: {}, envFile: "", envPath: [], tasks: {}, alias: {}, settings: {}, plugins: {}, hooks: {} })
  const [activeSection, setActiveSection] = useState<SectionId>("tools")
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!isExpanded) return
    ;(async () => {
      const r = await getTierMiseConfig(tier.id)
      const c = r.exists ? r.content : ""
      setRawContent(c)
      setData(parseMiseToml(c))
      setLoaded(true)
      setErr(null)
      setSaved(false)
    })()
  }, [isExpanded, tier.id])

  const handleSave = async () => {
    setSaving(true); setErr(null)
    const newContent = activeSection === "raw" ? rawContent : buildMiseToml(data)
    const r = await saveTierMiseConfig(tier.id, newContent)
    setSaving(false)
    if (!r.ok) { setErr(r.error ?? "save failed"); return }
    // Re-sync rawContent and parsed data after save from structured mode
    if (activeSection !== "raw") {
      setRawContent(newContent)
      setData(parseMiseToml(newContent))
    } else {
      setData(parseMiseToml(rawContent))
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
    onSaved()
  }

  const updateData = (patch: Partial<MiseData>) => {
    setData((d) => ({ ...d, ...patch }))
    setSaved(false)
  }

  const rawEdited = () => {
    setData(parseMiseToml(rawContent))
    setSaved(false)
  }

  const hasContent = Object.keys(data.tools).length > 0 ||
    Object.keys(data.env).length > 0 || data.envFile || data.envPath.length > 0 ||
    Object.keys(data.tasks).length > 0 ||
    Object.keys(data.alias).length > 0 ||
    Object.keys(data.settings).length > 0 ||
    Object.keys(data.plugins).length > 0 ||
    Object.keys(data.hooks).length > 0

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
          <div className="text-[11px] text-gray-400 mt-0.5">{isSdk ? tier.path : meta.desc}</div>
        </div>
        {/* Stat chips */}
        <div className="hidden sm:flex items-center gap-1 shrink-0">
          {Object.keys(data.tools).length > 0 && <StatChip label="tools" value={Object.keys(data.tools).length} />}
          {Object.keys(data.tasks).length > 0 && <StatChip label="tasks" value={Object.keys(data.tasks).length} />}
          {Object.keys(data.env).length > 0 && <StatChip label="env" value={Object.keys(data.env).length} />}
        </div>
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
            {/* Section tabs */}
            <div className="flex items-center gap-0.5 bg-gray-100 rounded-lg p-0.5 overflow-x-auto">
              {SECTIONS.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setActiveSection(s.id)}
                  className={`px-3 py-1 rounded text-[11px] font-medium whitespace-nowrap transition-colors ${activeSection === s.id ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-gray-400 -mt-3">{SECTIONS.find(s => s.id === activeSection)?.desc}</p>

            {/* ── Tools Editor ── */}
            {activeSection === "tools" && (
              <ToolsEditor
                tools={data.tools}
                readonly={!canEdit || !!disabled}
                onChange={(tools) => updateData({ tools })}
              />
            )}

            {/* ── Env Editor ── */}
            {activeSection === "env" && (
              <EnvEditor
                env={data.env}
                envFile={data.envFile}
                envPath={data.envPath}
                readonly={!canEdit || !!disabled}
                onChange={(env, envFile, envPath) => updateData({ env, envFile, envPath })}
              />
            )}

            {/* ── Tasks Editor ── */}
            {activeSection === "tasks" && (
              <TasksEditor
                tasks={data.tasks}
                readonly={!canEdit || !!disabled}
                onChange={(tasks) => updateData({ tasks })}
              />
            )}

            {/* ── Alias Editor ── */}
            {activeSection === "alias" && (
              <AliasEditor
                alias={data.alias}
                readonly={!canEdit || !!disabled}
                onChange={(alias) => updateData({ alias })}
              />
            )}

            {/* ── Settings Editor ── */}
            {activeSection === "settings" && (
              <SettingsEditor
                settings={data.settings}
                readonly={!canEdit || !!disabled}
                onChange={(settings) => updateData({ settings })}
              />
            )}

            {/* ── Plugins Editor ── */}
            {activeSection === "plugins" && (
              <PluginsEditor
                plugins={data.plugins}
                readonly={!canEdit || !!disabled}
                onChange={(plugins) => updateData({ plugins })}
              />
            )}

            {/* ── Hooks Editor ── */}
            {activeSection === "hooks" && (
              <HooksEditor
                hooks={data.hooks}
                readonly={!canEdit || !!disabled}
                onChange={(hooks) => updateData({ hooks })}
              />
            )}

            {/* ── Raw Editor ── */}
            {activeSection === "raw" && (
              <div className="space-y-2">
                <textarea
                  value={rawContent}
                  onChange={(e) => { setRawContent(e.target.value); setSaved(false) }}
                  onBlur={rawEdited}
                  readOnly={!canEdit || disabled}
                  spellCheck={false}
                  className="w-full h-80 px-3 py-2 border border-gray-300 rounded text-[12px] font-mono outline-none bg-white focus:border-gray-900 resize-y disabled:bg-gray-50 disabled:text-gray-500"
                />
              </div>
            )}

            {/* Lock warning */}
            {lockReason && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 text-[12px] text-amber-700">
                <Lock size={12} /> {lockReason}
              </div>
            )}

            {/* Save bar */}
            {canEdit && (
              <div className={`flex items-center gap-2 pt-3 border-t border-gray-100 ${isProfile ? "justify-between" : "justify-end"}`}>
                {isProfile && isAdmin && (
                  <button
                    onClick={async () => {
                      if (!confirm(`Delete profile "${profileName}"?`)) return
                      const r = await deleteProfile(profileName)
                      if (!r.ok) { setErr(r.error ?? "delete failed"); return }
                      onSaved()
                    }}
                    className="px-3 h-7 rounded-lg text-[11px] text-red-500 hover:bg-red-50 hover:text-red-600 transition-colors"
                  >
                    Delete profile
                  </button>
                )}
                <div className="flex items-center gap-2">
                  {!hasContent && activeSection !== "raw" && !rawContent && (
                    <span className="text-[11px] text-gray-400 italic">empty — save will create the file</span>
                  )}
                  {err && <span className="text-[12px] text-red-600">{err}</span>}
                  {saved && (
                    <span className="text-[12px] text-emerald-600 flex items-center gap-1"><Check size={13} /> saved</span>
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

// ═══════════════════════════════════════════════════════════════
// Section editors
// ═══════════════════════════════════════════════════════════════

// ── Tools ──

function ToolsEditor({ tools, readonly, onChange }: {
  tools: Record<string, { version: string; backend?: string }>
  readonly: boolean
  onChange: (tools: Record<string, { version: string; backend?: string }>) => void
}) {
  const entries = Object.entries(tools)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState("")
  const [newVersion, setNewVersion] = useState("")
  const [newBackend, setNewBackend] = useState("")
  const [suggestions, setSuggestions] = useState<MiseToolPreset[]>([])

  useEffect(() => { getAdminPresets().then(d => setSuggestions(d.miseToolPresets)).catch(() => {}) }, [])

  const quickAdd = (s: MiseToolPreset) => {
    onChange({ ...tools, [s.name]: { version: s.suggestedVersion, backend: s.backend } })
  }

  const add = () => {
    const n = newName.trim(); if (!n) return
    onChange({ ...tools, [n]: { version: newVersion.trim() || "latest", backend: newBackend.trim() || undefined } })
    setNewName(""); setNewVersion(""); setNewBackend(""); setAdding(false)
  }

  const remove = (name: string) => {
    const { [name]: _, ...rest } = tools; onChange(rest)
  }

  const update = (name: string, patch: Partial<{ version: string; backend?: string }>) => {
    const cur = tools[name]
    const next = { ...cur, ...patch }
    if (next.backend === "") next.backend = undefined
    onChange({ ...tools, [name]: next })
  }

  return (
    <div className="space-y-3">
      {entries.length === 0 && !adding && (
        <div className="text-[12px] text-gray-400 italic py-3">No tools. Add one to get started.</div>
      )}
      {entries.length > 0 && (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/50 text-left text-[10px] text-gray-500 uppercase tracking-wider">
                <th className="px-3 py-2 font-medium">Tool</th>
                <th className="px-3 py-2 font-medium">Version</th>
                <th className="px-3 py-2 font-medium hidden sm:table-cell">Backend</th>
                {!readonly && <th className="px-3 py-2 font-medium w-10"></th>}
              </tr>
            </thead>
            <tbody>
              {entries.map(([name, t]) => (
                <tr key={name} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                  <td className="px-3 py-2">
                    {readonly ? (
                      <code className="text-[12px] text-gray-800">{name}</code>
                    ) : (
                      <input value={name} onChange={(e) => {
                        const { [name]: v, ...rest } = tools
                        onChange({ ...rest, [e.target.value]: v })
                      }} className={inputClassSm} />
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {readonly ? (
                      <code className="text-[12px] text-gray-600">{t.version}</code>
                    ) : (
                      <input value={t.version} onChange={(e) => update(name, { version: e.target.value })} className={`w-24 ${inputClassSm}`} />
                    )}
                  </td>
                  <td className="px-3 py-2 hidden sm:table-cell">
                    {readonly ? (
                      <code className="text-[11px] text-gray-500">{t.backend || "—"}</code>
                    ) : (
                      <input value={t.backend ?? ""} onChange={(e) => update(name, { backend: e.target.value })} placeholder="e.g. aqua:hashicorp/terraform" className={`w-44 ${inputClassSm}`} />
                    )}
                  </td>
                  {!readonly && (
                    <td className="px-3 py-2">
                      <button onClick={() => remove(name)} className="text-gray-300 hover:text-red-500 transition-colors"><Trash2 size={12} /></button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!readonly && (
        <>
          {adding ? (
            <div className="border border-gray-200 rounded-lg p-3 space-y-2 bg-gray-50/50">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") setAdding(false) }} placeholder="tool name" className={inputClassSm} />
                <input value={newVersion} onChange={(e) => setNewVersion(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add() }} placeholder="version (e.g. 3.12)" className={inputClassSm} />
                <input value={newBackend} onChange={(e) => setNewBackend(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add() }} placeholder="backend (optional)" className={inputClassSm} />
              </div>
              <div className="flex items-center gap-2">
                <button onClick={add} className="px-3 h-7 rounded bg-gray-900 text-white text-[11px] font-medium hover:bg-gray-800">Add</button>
                <button onClick={() => setAdding(false)} className="text-[11px] text-gray-400 hover:text-gray-600">Cancel</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} className="text-[11px] text-gray-500 hover:text-gray-900 inline-flex items-center gap-1 transition-colors">
              <Plus size={11} /> add tool
            </button>
          )}

          {/* Suggested tool presets */}
          {suggestions.filter(s => !tools[s.name]).length > 0 && (
            <div className="border-t border-gray-100 pt-3 mt-2">
              <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Suggested tools</span>
              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                {suggestions.filter(s => !tools[s.name]).map(s => (
                  <button
                    key={s.name}
                    onClick={() => quickAdd(s)}
                    className="px-2 py-0.5 rounded border border-gray-200 bg-white text-[10px] text-gray-500 hover:text-gray-900 hover:border-gray-400 transition-colors"
                    title={s.description}
                  >
                    + {s.name} {s.suggestedVersion}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Env ──

function EnvEditor({ env, envFile, envPath, readonly, onChange }: {
  env: Record<string, string>; envFile: string; envPath: string[]; readonly: boolean
  onChange: (env: Record<string, string>, envFile: string, envPath: string[]) => void
}) {
  const entries = Object.entries(env)
  const [adding, setAdding] = useState(false)
  const [newKey, setNewKey] = useState("")
  const [newVal, setNewVal] = useState("")

  const add = () => {
    const k = newKey.trim(); if (!k) return
    onChange({ ...env, [k]: newVal }, envFile, envPath)
    setNewKey(""); setNewVal(""); setAdding(false)
  }

  const remove = (key: string) => {
    const { [key]: _, ...rest } = env; onChange(rest, envFile, envPath)
  }

  const update = (key: string, val: string) => {
    onChange({ ...env, [key]: val }, envFile, envPath)
  }

  return (
    <div className="space-y-4">
      {/* _.file */}
      <div className="flex items-center gap-3">
        <label className="text-[11px] font-medium text-gray-500 w-20 shrink-0">_.file</label>
        <input
          value={envFile} onChange={(e) => onChange(env, e.target.value, envPath)}
          readOnly={readonly} placeholder=".env (load from dotenv file)"
          className={inputClassSm + " flex-1"}
        />
      </div>

      {/* _.path */}
      <div className="flex items-center gap-3">
        <label className="text-[11px] font-medium text-gray-500 w-20 shrink-0">_.path</label>
        <input
          value={envPath.join(", ")} onChange={(e) => onChange(env, envFile, e.target.value.split(",").map(s => s.trim()).filter(Boolean))}
          readOnly={readonly} placeholder="./node_modules/.bin (comma-separated PATH additions)"
          className={inputClassSm + " flex-1"}
        />
      </div>

      <div className="border-t border-gray-100 pt-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Variables</span>
          {!readonly && (
            <button onClick={() => setAdding(true)} className="text-[11px] text-gray-500 hover:text-gray-900 inline-flex items-center gap-1">
              <Plus size={11} /> add
            </button>
          )}
        </div>
        {entries.length === 0 && !adding && (
          <div className="text-[12px] text-gray-400 italic py-2">No env vars set.</div>
        )}
        {entries.length > 0 && (
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/50 text-left text-[10px] text-gray-500 uppercase tracking-wider">
                  <th className="px-3 py-2 font-medium w-1/3">Name</th>
                  <th className="px-3 py-2 font-medium">Value</th>
                  {!readonly && <th className="px-3 py-2 font-medium w-10"></th>}
                </tr>
              </thead>
              <tbody>
                {entries.map(([k, v]) => (
                  <tr key={k} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                    <td className="px-3 py-2">
                      {readonly ? <code className="text-[12px] text-gray-800">{k}</code> : <input value={k} onChange={(e) => { const { [k]: val, ...rest } = env; onChange({ ...rest, [e.target.value]: val }, envFile, envPath) }} className={inputClassSm} />}
                    </td>
                    <td className="px-3 py-2">
                      {readonly ? <code className="text-[12px] text-gray-600">{v}</code> : <input value={v} onChange={(e) => update(k, e.target.value)} className={inputClassSm} />}
                    </td>
                    {!readonly && (
                      <td className="px-3 py-2"><button onClick={() => remove(k)} className="text-gray-300 hover:text-red-500"><Trash2 size={12} /></button></td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!readonly && adding && (
          <div className="flex items-center gap-2 mt-2">
            <input autoFocus value={newKey} onChange={(e) => setNewKey(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") setAdding(false) }} placeholder="VAR_NAME" className={inputClassSm + " flex-1"} />
            <input value={newVal} onChange={(e) => setNewVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add() }} placeholder="value" className={inputClassSm + " flex-1"} />
            <button onClick={add} className="px-3 h-7 rounded bg-gray-900 text-white text-[11px] font-medium hover:bg-gray-800">Add</button>
            <button onClick={() => setAdding(false)} className="text-[11px] text-gray-400 hover:text-gray-600">Cancel</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Tasks ──

function TasksEditor({ tasks, readonly, onChange }: {
  tasks: Record<string, MiseTask>; readonly: boolean
  onChange: (tasks: Record<string, MiseTask>) => void
}) {
  const entries = Object.entries(tasks)
  const [expandedTask, setExpandedTask] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [newTaskName, setNewTaskName] = useState("")

  const add = () => {
    const n = newTaskName.trim(); if (!n) return
    onChange({ ...tasks, [n]: { run: "" } })
    setNewTaskName(""); setAdding(false); setExpandedTask(n)
  }

  const remove = (name: string) => {
    const { [name]: _, ...rest } = tasks; onChange(rest)
    if (expandedTask === name) setExpandedTask(null)
  }

  const update = (name: string, patch: Partial<MiseTask>) => {
    onChange({ ...tasks, [name]: { ...tasks[name], ...patch } })
  }

  return (
    <div className="space-y-3">
      {entries.length === 0 && !adding && (
        <div className="text-[12px] text-gray-400 italic py-3">No tasks defined. Add a build or run task.</div>
      )}
      {entries.map(([name, t]) => {
        const isExp = expandedTask === name
        return (
          <div key={name} className="border border-gray-200 rounded-lg overflow-hidden">
            <button
              onClick={() => setExpandedTask(isExp ? null : name)}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 transition-colors text-left"
            >
              {isExp ? <ChevronDown size={12} className="text-gray-400 shrink-0" /> : <ChevronRight size={12} className="text-gray-400 shrink-0" />}
              <code className="text-[13px] font-medium text-gray-800 flex-1">{name}</code>
              {t.description && <span className="text-[11px] text-gray-400 truncate hidden sm:inline">{t.description}</span>}
              {!readonly && (
                <button onClick={(e) => { e.stopPropagation(); remove(name) }} className="text-gray-300 hover:text-red-500 ml-1">
                  <Trash2 size={12} />
                </button>
              )}
            </button>
            {isExp && (
              <div className="border-t border-gray-100 px-4 py-3 space-y-3 bg-gray-50/30">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Labeled label="Run command">
                    <input value={t.run ?? ""} onChange={(e) => update(name, { run: e.target.value })} readOnly={readonly} placeholder="npm run build" className={inputClass} />
                  </Labeled>
                  <Labeled label="Description">
                    <input value={t.description ?? ""} onChange={(e) => update(name, { description: e.target.value })} readOnly={readonly} placeholder="Build the project" className={inputClass} />
                  </Labeled>
                  <Labeled label="Working dir">
                    <input value={t.dir ?? ""} onChange={(e) => update(name, { dir: e.target.value })} readOnly={readonly} placeholder="{{config_root}}/frontend" className={inputClass} />
                  </Labeled>
                  <Labeled label="Run (Windows)">
                    <input value={t.runWindows ?? ""} onChange={(e) => update(name, { runWindows: e.target.value })} readOnly={readonly} placeholder="npm.cmd run build" className={inputClass} />
                  </Labeled>
                  <Labeled label="Depends on (comma-sep)">
                    <input value={t.depends?.join(", ") ?? ""} onChange={(e) => update(name, { depends: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} readOnly={readonly} placeholder="lint, test" className={inputClass} />
                  </Labeled>
                  <Labeled label="Wait for (comma-sep)">
                    <input value={t.waitFor?.join(", ") ?? ""} onChange={(e) => update(name, { waitFor: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} readOnly={readonly} placeholder="db:5432" className={inputClass} />
                  </Labeled>
                  <Labeled label="Sources (comma-sep)">
                    <input value={t.sources?.join(", ") ?? ""} onChange={(e) => update(name, { sources: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} readOnly={readonly} placeholder="src/**/*.ts" className={inputClass} />
                  </Labeled>
                  <Labeled label="Outputs (comma-sep)">
                    <input value={t.outputs?.join(", ") ?? ""} onChange={(e) => update(name, { outputs: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} readOnly={readonly} placeholder="dist/**/*.js" className={inputClass} />
                  </Labeled>
                </div>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 text-[12px] text-gray-600 cursor-pointer">
                    <input type="checkbox" checked={t.hide ?? false} onChange={(e) => update(name, { hide: e.target.checked || undefined })} disabled={readonly} className="h-3.5 w-3.5 rounded border-gray-300" />
                    Hide in <code className="text-[11px] bg-gray-100 px-1 rounded">mise run</code> list
                  </label>
                  <label className="flex items-center gap-2 text-[12px] text-gray-600 cursor-pointer">
                    <input type="checkbox" checked={t.raw ?? false} onChange={(e) => update(name, { raw: e.target.checked || undefined })} disabled={readonly} className="h-3.5 w-3.5 rounded border-gray-300" />
                    Raw (pass directly to shell)
                  </label>
                </div>
                {/* Task env vars */}
                <details className="text-[11px]">
                  <summary className="text-gray-400 cursor-pointer hover:text-gray-600">Task environment variables ({Object.keys(t.env ?? {}).length})</summary>
                  <div className="mt-2 space-y-1">
                    {(Object.entries(t.env ?? {})).map(([ek, ev]) => (
                      <div key={ek} className="flex items-center gap-2">
                        <input value={ek} onChange={(e) => {
                          const cur = { ...(t.env ?? {}) }
                          const val = cur[ek] ?? ""
                          delete cur[ek]
                          cur[e.target.value] = val
                          update(name, { env: cur })
                        }} readOnly={readonly} placeholder="VAR" className={inputClassSm + " w-40"} />
                        <span className="text-gray-400">=</span>
                        <input value={ev} onChange={(e) => {
                          update(name, { env: { ...(t.env ?? {}), [ek]: e.target.value } })
                        }} readOnly={readonly} placeholder="value" className={inputClassSm + " flex-1"} />
                        {!readonly && (
                          <button onClick={() => {
                            const { [ek]: _, ...rest } = (t.env ?? {})
                            update(name, { env: Object.keys(rest).length > 0 ? rest : undefined })
                          }} className="text-gray-300 hover:text-red-500"><Trash2 size={11} /></button>
                        )}
                      </div>
                    ))}
                    {!readonly && (
                      <button
                        onClick={() => update(name, { env: { ...(t.env ?? {}), "": "" } })}
                        className="text-[10px] text-gray-400 hover:text-gray-600 inline-flex items-center gap-1 mt-1"
                      ><Plus size={10} /> add env var</button>
                    )}
                  </div>
                </details>
              </div>
            )}
          </div>
        )
      })}
      {!readonly && (
        <>
          {adding ? (
            <div className="flex items-center gap-2">
              <input autoFocus value={newTaskName} onChange={(e) => setNewTaskName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") setAdding(false) }} placeholder="task name" className={inputClassSm + " flex-1"} />
              <button onClick={add} className="px-3 h-7 rounded bg-gray-900 text-white text-[11px] font-medium hover:bg-gray-800">Add</button>
              <button onClick={() => setAdding(false)} className="text-[11px] text-gray-400 hover:text-gray-600">Cancel</button>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} className="text-[11px] text-gray-500 hover:text-gray-900 inline-flex items-center gap-1">
              <Plus size={11} /> add task
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ── Alias ──

function AliasEditor({ alias, readonly, onChange }: {
  alias: Record<string, Record<string, string>>; readonly: boolean
  onChange: (alias: Record<string, Record<string, string>>) => void
}) {
  const [addingTool, setAddingTool] = useState("")
  const [addingAlias, setAddingAlias] = useState("")
  const [addingVersion, setAddingVersion] = useState("")
  const [showAdd, setShowAdd] = useState(false)

  const add = () => {
    const tool = addingTool.trim(); const al = addingAlias.trim(); if (!tool || !al) return
    onChange({ ...alias, [tool]: { ...(alias[tool] ?? {}), [al]: addingVersion.trim() || "latest" } })
    setAddingTool(""); setAddingAlias(""); setAddingVersion(""); setShowAdd(false)
  }

  const remove = (tool: string, al: string) => {
    const { [al]: _, ...rest } = alias[tool]
    if (Object.keys(rest).length === 0) {
      const { [tool]: __, ...restAlias } = alias
      onChange(restAlias)
    } else {
      onChange({ ...alias, [tool]: rest })
    }
  }

  const entries = Object.entries(alias)

  return (
    <div className="space-y-3">
      {entries.length === 0 && !showAdd && (
        <div className="text-[12px] text-gray-400 italic py-3">No aliases. Create version aliases for tools (e.g. node:myapp → 22.11.0).</div>
      )}
      {entries.map(([tool, aliases]) => (
        <div key={tool} className="border border-gray-200 rounded-lg overflow-hidden">
          <div className="px-3 py-2 bg-gray-50/50 border-b border-gray-100 text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
            {tool}
          </div>
          {Object.entries(aliases).map(([al, ver]) => (
            <div key={al} className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-50 hover:bg-gray-50/50">
              <code className="text-[12px] text-gray-600 w-32 truncate">{al}</code>
              <span className="text-gray-300">→</span>
              <code className="text-[12px] text-gray-800 flex-1">{ver}</code>
              {!readonly && (
                <button onClick={() => remove(tool, al)} className="text-gray-300 hover:text-red-500"><Trash2 size={11} /></button>
              )}
            </div>
          ))}
        </div>
      ))}
      {!readonly && (
        <>
          {showAdd ? (
            <div className="border border-gray-200 rounded-lg p-3 space-y-2 bg-gray-50/50">
              <div className="grid grid-cols-3 gap-2">
                <input autoFocus value={addingTool} onChange={(e) => setAddingTool(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") setShowAdd(false) }} placeholder="tool (e.g. node)" className={inputClassSm} />
                <input value={addingAlias} onChange={(e) => setAddingAlias(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add() }} placeholder="alias (e.g. myapp)" className={inputClassSm} />
                <input value={addingVersion} onChange={(e) => setAddingVersion(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add() }} placeholder="version" className={inputClassSm} />
              </div>
              <div className="flex items-center gap-2">
                <button onClick={add} className="px-3 h-7 rounded bg-gray-900 text-white text-[11px] font-medium hover:bg-gray-800">Add</button>
                <button onClick={() => setShowAdd(false)} className="text-[11px] text-gray-400 hover:text-gray-600">Cancel</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowAdd(true)} className="text-[11px] text-gray-500 hover:text-gray-900 inline-flex items-center gap-1">
              <Plus size={11} /> add alias
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ── Settings ──

const MISE_SETTINGS: { key: string; label: string; type: "bool" | "string" | "number" | "string[]"; desc: string; placeholder?: string }[] = [
  { key: "always_keep_download", label: "Always keep download", type: "bool", desc: "Keep downloaded archives after install" },
  { key: "always_keep_install", label: "Always keep install", type: "bool", desc: "Keep install directory after uninstall" },
  { key: "legacy_version_file", label: "Legacy version file", type: "bool", desc: "Read .node-version, .python-version, etc." },
  { key: "jobs", label: "Jobs", type: "number", desc: "Parallel install jobs (default: 4)" },
  { key: "experimental", label: "Experimental", type: "bool", desc: "Enable experimental features" },
  { key: "yes", label: "Yes", type: "bool", desc: "Auto-answer yes to prompts" },
  { key: "quiet", label: "Quiet", type: "bool", desc: "Suppress non-error output" },
  { key: "verbose", label: "Verbose", type: "bool", desc: "Show extra debug output" },
  { key: "raw", label: "Raw", type: "bool", desc: "Pass commands directly to shell" },
  { key: "color", label: "Color", type: "bool", desc: "Enable colored output" },
  { key: "pipx_uvx", label: "pipx / uvx", type: "bool", desc: "Use uvx for pipx operations" },
  { key: "python_venv_auto_create", label: "Python venv auto-create", type: "bool", desc: "Auto-create venv when entering dir" },
  { key: "python_default_packages_file", label: "Python default packages file", type: "string", desc: "Default pip packages file", placeholder: "~/.default-python-packages" },
  { key: "node_mirror_url", label: "Node mirror URL", type: "string", desc: "Custom nodejs.org mirror" },
  { key: "python_mirror_url", label: "Python mirror URL", type: "string", desc: "Custom python.org mirror" },
  { key: "plugin_autoupdate_last_check_duration", label: "Plugin autoupdate check", type: "string", desc: "Duration between update checks", placeholder: "7d" },
  { key: "trusted_config_paths", label: "Trusted config paths", type: "string[]", desc: "Paths to trust (comma-separated)", placeholder: "/path/to/trusted" },
]

function SettingsEditor({ settings, readonly, onChange }: {
  settings: Record<string, any>; readonly: boolean
  onChange: (settings: Record<string, any>) => void
}) {
  const update = (key: string, val: any) => {
    if (val === null || val === "" || val === undefined || (typeof val === "boolean" && val === true)) {
      // For booleans, we use the default (true is mise default for most, so remove key)
      const { [key]: _, ...rest } = settings
      onChange(rest)
    } else {
      onChange({ ...settings, [key]: val })
    }
  }

  // Show configured settings + all known ones not yet configured
  const configuredKeys = new Set(Object.keys(settings))
  const knownSettings = MISE_SETTINGS.filter(s => configuredKeys.has(s.key) || s.type === "bool")
  const unknownSettings = Object.entries(settings).filter(([k]) => !MISE_SETTINGS.some(s => s.key === k))

  return (
    <div className="space-y-3">
      {knownSettings.map((s) => {
        const val = settings[s.key]
        const isSet = val !== undefined
        return (
          <div key={s.key} className="flex items-start gap-3 py-1.5 border-b border-gray-50">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <code className="text-[12px] text-gray-800">{s.label}</code>
                {!isSet && <span className="text-[9px] text-gray-300">default</span>}
              </div>
              <div className="text-[10px] text-gray-400">{s.desc}</div>
            </div>
            <div className="shrink-0">
              {s.type === "bool" ? (
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox" checked={val === true}
                    onChange={(e) => update(s.key, e.target.checked || null)}
                    disabled={readonly}
                    className="sr-only peer"
                  />
                  <div className="w-8 h-4.5 bg-gray-200 peer-checked:bg-gray-900 rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-3.5 after:w-3.5 after:transition-transform peer-checked:after:translate-x-[14px]"></div>
                </label>
              ) : s.type === "number" ? (
                <input type="number" value={val ?? ""} onChange={(e) => update(s.key, e.target.value ? Number(e.target.value) : null)} readOnly={readonly} placeholder={s.placeholder} className={inputClassSm + " w-24"} />
              ) : (
                <input value={val ?? ""} onChange={(e) => update(s.key, e.target.value || null)} readOnly={readonly} placeholder={s.placeholder} className={inputClassSm + " w-48"} />
              )}
            </div>
          </div>
        )
      })}
      {/* Unknown/custom settings */}
      {unknownSettings.length > 0 && (
        <div className="border-t border-gray-200 pt-3 mt-3">
          <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Custom</span>
          {unknownSettings.map(([k, v]) => (
            <div key={k} className="flex items-center gap-2 mt-2">
              <input value={k} readOnly className={inputClassSm + " w-40"} />
              <input value={String(v)} onChange={(e) => update(k, e.target.value)} readOnly={readonly} className={inputClassSm + " flex-1"} />
              {!readonly && (
                <button onClick={() => { const { [k]: _, ...rest } = settings; onChange(rest) }} className="text-gray-300 hover:text-red-500"><Trash2 size={11} /></button>
              )}
            </div>
          ))}
        </div>
      )}
      {!readonly && (
        <AddCustomSetting onAdd={(k, v) => onChange({ ...settings, [k]: v })} />
      )}
    </div>
  )
}

function AddCustomSetting({ onAdd }: { onAdd: (key: string, val: string) => void }) {
  const [adding, setAdding] = useState(false)
  const [key, setKey] = useState("")
  const [val, setVal] = useState("")
  const add = () => { const k = key.trim(); if (!k) return; onAdd(k, val); setKey(""); setVal(""); setAdding(false) }
  if (!adding) return <button onClick={() => setAdding(true)} className="text-[11px] text-gray-500 hover:text-gray-900 inline-flex items-center gap-1"><Plus size={11} /> add custom setting</button>
  return (
    <div className="flex items-center gap-2 mt-2">
      <input autoFocus value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") setAdding(false) }} placeholder="setting key" className={inputClassSm + " flex-1"} />
      <input value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add() }} placeholder="value" className={inputClassSm + " flex-1"} />
      <button onClick={add} className="px-3 h-7 rounded bg-gray-900 text-white text-[11px] font-medium hover:bg-gray-800">Add</button>
      <button onClick={() => setAdding(false)} className="text-[11px] text-gray-400 hover:text-gray-600">Cancel</button>
    </div>
  )
}

// ── Plugins ──

function PluginsEditor({ plugins, readonly, onChange }: {
  plugins: Record<string, string>; readonly: boolean
  onChange: (plugins: Record<string, string>) => void
}) {
  const entries = Object.entries(plugins)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState("")
  const [newUrl, setNewUrl] = useState("")

  const add = () => {
    const n = newName.trim(); if (!n) return
    onChange({ ...plugins, [n]: newUrl.trim() || `https://github.com/asdf-community/asdf-${n}.git` })
    setNewName(""); setNewUrl(""); setAdding(false)
  }

  const remove = (name: string) => {
    const { [name]: _, ...rest } = plugins; onChange(rest)
  }

  return (
    <div className="space-y-3">
      {entries.length === 0 && !adding && (
        <div className="text-[12px] text-gray-400 italic py-3">No plugins. Add asdf-compatible plugin sources for tools not in the default registry.</div>
      )}
      {entries.length > 0 && (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/50 text-left text-[10px] text-gray-500 uppercase tracking-wider">
                <th className="px-3 py-2 font-medium">Plugin</th>
                <th className="px-3 py-2 font-medium">URL</th>
                {!readonly && <th className="px-3 py-2 font-medium w-10"></th>}
              </tr>
            </thead>
            <tbody>
              {entries.map(([name, url]) => (
                <tr key={name} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                  <td className="px-3 py-2">
                    {readonly ? <code className="text-[12px] text-gray-800">{name}</code> : <input value={name} onChange={(e) => { const { [name]: v, ...rest } = plugins; onChange({ ...rest, [e.target.value]: v }) }} className={inputClassSm} />}
                  </td>
                  <td className="px-3 py-2">
                    {readonly ? <code className="text-[11px] text-gray-500 truncate block max-w-xs">{url}</code> : <input value={url} onChange={(e) => onChange({ ...plugins, [name]: e.target.value })} className={inputClassSm} />}
                  </td>
                  {!readonly && (
                    <td className="px-3 py-2"><button onClick={() => remove(name)} className="text-gray-300 hover:text-red-500"><Trash2 size={12} /></button></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!readonly && (
        <>
          {adding ? (
            <div className="border border-gray-200 rounded-lg p-3 space-y-2 bg-gray-50/50">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") setAdding(false) }} placeholder="plugin name (e.g. rust)" className={inputClassSm} />
                <input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add() }} placeholder="git URL (or leave empty for default)" className={inputClassSm} />
              </div>
              <div className="flex items-center gap-2">
                <button onClick={add} className="px-3 h-7 rounded bg-gray-900 text-white text-[11px] font-medium hover:bg-gray-800">Add</button>
                <button onClick={() => setAdding(false)} className="text-[11px] text-gray-400 hover:text-gray-600">Cancel</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} className="text-[11px] text-gray-500 hover:text-gray-900 inline-flex items-center gap-1">
              <Plus size={11} /> add plugin
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ── Hooks ──

const HOOK_EVENTS = ["enter", "leave", "cd", "preinstall", "postinstall"]

function HooksEditor({ hooks, readonly, onChange }: {
  hooks: Record<string, string>; readonly: boolean
  onChange: (hooks: Record<string, string>) => void
}) {
  const update = (event: string, cmd: string) => {
    if (!cmd.trim()) {
      const { [event]: _, ...rest } = hooks
      onChange(rest)
    } else {
      onChange({ ...hooks, [event]: cmd })
    }
  }

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-gray-500 mb-2">
        Commands that run on lifecycle events. Use <code className="bg-gray-100 px-1 rounded text-[10px]">{`{{env.PWD}}`}</code> for template variables.
      </div>
      {HOOK_EVENTS.map((event) => (
        <div key={event} className="flex items-center gap-3">
          <code className="text-[11px] font-medium text-gray-600 w-24 shrink-0">{event}</code>
          <input
            value={hooks[event] ?? ""}
            onChange={(e) => update(event, e.target.value)}
            readOnly={readonly}
            placeholder={`echo '${event} hook'`}
            className={inputClassSm + " flex-1"}
          />
        </div>
      ))}
      {/* Custom hooks */}
      {Object.entries(hooks).filter(([k]) => !HOOK_EVENTS.includes(k)).map(([k, v]) => (
        <div key={k} className="flex items-center gap-3">
          <input value={k} readOnly className={inputClassSm + " w-24 shrink-0"} />
          <input value={v} onChange={(e) => update(k, e.target.value)} readOnly={readonly} className={inputClassSm + " flex-1"} />
          {!readonly && <button onClick={() => { const { [k]: _, ...rest } = hooks; onChange(rest) }} className="text-gray-300 hover:text-red-500"><Trash2 size={11} /></button>}
        </div>
      ))}
      {!readonly && <AddCustomHook onAdd={(k, v) => onChange({ ...hooks, [k]: v })} />}
    </div>
  )
}

function AddCustomHook({ onAdd }: { onAdd: (key: string, val: string) => void }) {
  const [adding, setAdding] = useState(false)
  const [key, setKey] = useState("")
  const [val, setVal] = useState("")
  const add = () => { const k = key.trim(); if (!k) return; onAdd(k, val); setKey(""); setVal(""); setAdding(false) }
  if (!adding) return <button onClick={() => setAdding(true)} className="text-[11px] text-gray-500 hover:text-gray-900 inline-flex items-center gap-1 mt-1"><Plus size={11} /> add custom hook</button>
  return (
    <div className="flex items-center gap-2 mt-1">
      <input autoFocus value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") setAdding(false) }} placeholder="hook event" className={inputClassSm + " w-32"} />
      <input value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add() }} placeholder="command" className={inputClassSm + " flex-1"} />
      <button onClick={add} className="px-3 h-7 rounded bg-gray-900 text-white text-[11px] font-medium hover:bg-gray-800">Add</button>
      <button onClick={() => setAdding(false)} className="text-[11px] text-gray-400 hover:text-gray-600">Cancel</button>
    </div>
  )
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">{label}</span>
      {children}
    </label>
  )
}
