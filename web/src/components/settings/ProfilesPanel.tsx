import { useCallback, useEffect, useState } from "react"
import {
  listProfilesRich,
  createProfile,
  updateProfile,
  deleteProfile,
  type ProfileDetail,
} from "@/api"
import { McpServerEditor, mcpServersFromJson } from "./McpServerEditor"
import { PluginToggleList } from "./PluginToggleList"
import { Plus, Trash2, RefreshCw, Check, X, Edit3, AlertCircle, Blocks, Package, Server } from "lucide-react"

export function ProfilesPanel() {
  const [profiles, setProfiles] = useState<ProfileDetail[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")

  const refresh = useCallback(async () => {
    setLoading(true)
    const list = await listProfilesRich()
    setProfiles(list)
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const handleCreate = async () => {
    const n = newName.trim()
    if (!n) return
    setError(null)
    const r = await createProfile(n)
    if (!r.ok) { setError(r.error ?? "create failed"); return }
    setNewName("")
    setCreating(false)
    await refresh()
    setEditing(n)
  }

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete profile "${name}"? This removes all its .claude/ contents permanently.`)) return
    const r = await deleteProfile(name)
    if (!r.ok) { setError(r.error ?? "delete failed"); return }
    if (editing === name) setEditing(null)
    await refresh()
  }

  if (loading && profiles.length === 0) {
    return <div className="flex items-center gap-2 py-12 justify-center text-[13px] text-gray-400"><RefreshCw size={13} className="animate-spin" /> loading profiles…</div>
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-gray-600">
          <span className="font-medium text-gray-900">{profiles.length}</span> profile{profiles.length !== 1 ? "s" : ""}
          <span className="text-gray-400 ml-1">under knowledge/.loopat/profiles/</span>
        </span>
        <button onClick={refresh} disabled={loading} className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors">
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {error && (
        <div className="rounded-lg px-3 py-2 text-[12px] bg-red-50 text-red-800 border border-red-200 flex items-center gap-2">
          <AlertCircle size={12} />
          {error}
          <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-600"><X size={12} /></button>
        </div>
      )}

      {profiles.length === 0 && !creating && (
        <div className="flex flex-col items-center gap-2 text-center py-8 rounded-xl border border-gray-200 bg-white">
          <Blocks size={24} className="text-gray-300" />
          <div className="text-[13px] text-gray-500">No profiles yet</div>
          <div className="text-[12px] text-gray-400 max-w-sm leading-relaxed">
            Profiles let teammates opt into a pre-configured toolchain (plugins, MCP servers, skills, CLAUDE.md). Create one to get started.
          </div>
        </div>
      )}

      {/* Create new */}
      {creating && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="text-[13px] font-semibold text-gray-900 mb-3">New Profile</div>
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") { setCreating(false); setNewName("") } }}
              placeholder="profile name (letters, numbers, dash, underscore)"
              className="ip text-[13px] flex-1"
            />
            <button onClick={handleCreate} className="px-4 h-8 rounded-lg bg-gray-900 text-white text-xs font-medium hover:bg-gray-800 shrink-0">Create</button>
            <button onClick={() => { setCreating(false); setNewName("") }} className="px-3 h-8 text-xs text-gray-500 hover:text-gray-700 shrink-0">Cancel</button>
          </div>
        </div>
      )}

      {/* Profile cards */}
      <div className="space-y-3">
        {profiles.map((p) => (
          <ProfileCard
            key={p.name}
            profile={p}
            isEditing={editing === p.name}
            onEdit={() => setEditing(editing === p.name ? null : p.name)}
            onDelete={() => handleDelete(p.name)}
            onSaved={() => { setEditing(null); refresh() }}
          />
        ))}
      </div>

      {!creating && (
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 px-3 py-2 text-[12px] text-gray-400 hover:text-gray-700 hover:bg-gray-50 rounded-lg w-full transition-colors"
        >
          <Plus size={13} />
          Create profile
        </button>
      )}
    </div>
  )
}

function ProfileCard({
  profile,
  isEditing,
  onEdit,
  onDelete,
  onSaved,
}: {
  profile: ProfileDetail
  isEditing: boolean
  onEdit: () => void
  onDelete: () => void
  onSaved: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [draftSettings, setDraftSettings] = useState<Record<string, any>>(profile.settings ?? {})
  const [draftMd, setDraftMd] = useState(profile.claudeMd ?? "")
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setDraftSettings(profile.settings ?? {})
    setDraftMd(profile.claudeMd ?? "")
  }, [profile.settings, profile.claudeMd])

  const save = async () => {
    setSaving(true)
    setErr(null)
    const r = await updateProfile(profile.name, {
      settings: draftSettings,
      claudeMd: draftMd,
    })
    setSaving(false)
    if (!r.ok) { setErr(r.error ?? "save failed"); return }
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    onSaved()
  }

  const hasContent = profile.pluginCount > 0 || profile.mcpServerCount > 0 || profile.skillCount > 0 || profile.agentCount > 0

  return (
    <div className={`rounded-xl border overflow-hidden transition-shadow ${isEditing ? "border-gray-400 shadow-sm" : "border-gray-200 bg-white hover:shadow-sm"}`}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 border-l-2 border-l-blue-400">
        <Blocks size={16} className="text-gray-500 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-gray-900">{profile.name}</span>
            {hasContent && (
              <span className="text-[10px] text-gray-400">
                {profile.pluginCount > 0 && `${profile.pluginCount}p `}
                {profile.mcpServerCount > 0 && `${profile.mcpServerCount}m `}
                {profile.skillCount > 0 && `${profile.skillCount}s `}
                {profile.agentCount > 0 && `${profile.agentCount}a`}
              </span>
            )}
          </div>
          {profile.description && !isEditing && (
            <div className="text-[12px] text-gray-500 mt-0.5 line-clamp-1">{profile.description}</div>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={onEdit}
            className={`p-1.5 rounded-lg transition-colors ${isEditing ? "bg-gray-100 text-gray-700" : "text-gray-400 hover:text-gray-700 hover:bg-gray-100"}`}
            title={isEditing ? "close" : "edit"}
          >
            <Edit3 size={13} />
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors"
            title="delete"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Expanded editor */}
      {isEditing && (
        <div className="px-4 py-4 space-y-4 bg-gray-50/30">
          {/* CLAUDE.md */}
          <div>
            <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">CLAUDE.md</div>
            <textarea
              value={draftMd}
              onChange={(e) => setDraftMd(e.target.value)}
              placeholder="# Profile instructions for Claude"
              className="ip text-[12px] w-full font-mono resize-y min-h-[60px]"
              rows={3}
            />
          </div>

          {/* Plugins */}
          <div>
            <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Plugins</div>
            <PluginToggleList
              enabledPlugins={(draftSettings?.enabledPlugins as Record<string, boolean>) ?? {}}
              onChange={(enabled) => setDraftSettings((d) => d ? { ...d, enabledPlugins: enabled } : { enabledPlugins: enabled })}
            />
          </div>

          {/* MCP Servers */}
          <div>
            <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">MCP Servers</div>
            <McpServerEditor
              servers={mcpServersFromJson(draftSettings)}
              onChange={(servers) => setDraftSettings((d) => d ? { ...d, mcpServers: servers } : { mcpServers: servers })}
            />
          </div>

          {/* Save */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-200">
            {err && <span className="text-[12px] text-red-600">{err}</span>}
            {saved && (
              <span className="text-[12px] text-emerald-600 flex items-center gap-1">
                <Check size={13} /> saved
              </span>
            )}
            <button
              onClick={onEdit}
              className="px-3 h-8 text-xs rounded-lg text-gray-700 hover:bg-gray-100 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="px-4 h-8 rounded-lg bg-gray-900 text-white text-xs font-medium hover:bg-gray-800 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving…" : "Save Profile"}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
