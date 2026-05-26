import { useCallback, useEffect, useState } from "react"
import {
  getAdminPresets,
  updateAdminPresets,
  type ProviderPreset,
  type MiseToolPreset,
  type PresetsData,
} from "@/api"
import { Plus, Trash2, RefreshCw, Check, Cpu, Wrench } from "lucide-react"

const inputClass = "w-full px-2.5 py-1.5 border border-gray-300 rounded text-[12px] outline-none bg-white focus:border-gray-900 focus:ring-1 focus:ring-gray-900 transition-colors font-mono"
const inputClassSm = "w-full px-2 py-1 border border-gray-300 rounded text-[11px] outline-none bg-white focus:border-gray-900 font-mono"

type SubTab = "providers" | "mise-tools"

export function PresetsPanel() {
  const [data, setData] = useState<PresetsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [subTab, setSubTab] = useState<SubTab>("providers")

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr(null)
    const d = await getAdminPresets()
    setData(d)
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const save = async (patch: Partial<PresetsData>) => {
    if (!data) return
    const next = { ...data, ...patch }
    setData(next)
    setSaving(true)
    setErr(null)
    const ok = await updateAdminPresets(next)
    setSaving(false)
    if (!ok) { setErr("save failed"); return }
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  if (loading && !data) {
    return <div className="text-[12px] text-gray-400 italic py-12 text-center">loading presets…</div>
  }

  if (!data) {
    return <div className="text-[12px] text-red-600 py-12 text-center">failed to load presets</div>
  }

  return (
    <div className="space-y-4">
      {/* Sub-tab bar */}
      <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5 w-fit">
        <button
          onClick={() => setSubTab("providers")}
          className={`px-3 py-1 rounded text-[11px] font-medium transition-colors flex items-center gap-1.5 ${subTab === "providers" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
        >
          <Cpu size={12} /> AI Providers
        </button>
        <button
          onClick={() => setSubTab("mise-tools")}
          className={`px-3 py-1 rounded text-[11px] font-medium transition-colors flex items-center gap-1.5 ${subTab === "mise-tools" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
        >
          <Wrench size={12} /> Mise Tools
        </button>
      </div>

      {/* Sub-tab content */}
      {subTab === "providers" && (
        <ProviderPresetsEditor
          presets={data.providerPresets}
          onChange={(providerPresets) => save({ providerPresets })}
          saving={saving}
        />
      )}
      {subTab === "mise-tools" && (
        <MiseToolPresetsEditor
          presets={data.miseToolPresets}
          onChange={(miseToolPresets) => save({ miseToolPresets })}
          saving={saving}
        />
      )}

      {/* Shared status bar */}
      <div className="flex items-center justify-end gap-2">
        {err && <span className="text-[12px] text-red-600">{err}</span>}
        {saved && (
          <span className="text-[12px] text-emerald-600 flex items-center gap-1"><Check size={13} /> saved</span>
        )}
      </div>
    </div>
  )
}

// ── Provider Presets Editor ──

function ProviderPresetsEditor({
  presets,
  onChange,
  saving,
}: {
  presets: ProviderPreset[]
  onChange: (presets: ProviderPreset[]) => void
  saving: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState("")
  const [newBaseUrl, setNewBaseUrl] = useState("")
  const [newModels, setNewModels] = useState("")

  const add = () => {
    const n = newName.trim()
    if (!n || !newBaseUrl.trim()) return
    const models = newModels.trim()
      ? newModels.split("\n").map(s => s.trim()).filter(Boolean)
      : []
    onChange([...presets, { name: n, baseUrl: newBaseUrl.trim(), models }])
    setNewName(""); setNewBaseUrl(""); setNewModels(""); setAdding(false)
  }

  const remove = (idx: number) => {
    onChange(presets.filter((_, i) => i !== idx))
  }

  const update = (idx: number, patch: Partial<ProviderPreset>) => {
    onChange(presets.map((p, i) => i === idx ? { ...p, ...patch } : p))
  }

  return (
    <div className="space-y-3">
      {presets.length === 0 && !adding && (
        <div className="text-[12px] text-gray-400 italic py-3">No provider presets. Add one to get started.</div>
      )}

      {presets.length > 0 && (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/50 text-left text-[10px] text-gray-500 uppercase tracking-wider">
                <th className="px-3 py-2 font-medium w-1/5">Name</th>
                <th className="px-3 py-2 font-medium">Base URL</th>
                <th className="px-3 py-2 font-medium hidden sm:table-cell">Models</th>
                <th className="px-3 py-2 font-medium w-10"></th>
              </tr>
            </thead>
            <tbody>
              {presets.map((p, idx) => (
                <tr key={idx} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                  <td className="px-3 py-2">
                    <input
                      value={p.name}
                      onChange={(e) => update(idx, { name: e.target.value })}
                      disabled={saving}
                      className={inputClassSm}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={p.baseUrl}
                      onChange={(e) => update(idx, { baseUrl: e.target.value })}
                      disabled={saving}
                      className={inputClassSm}
                    />
                  </td>
                  <td className="px-3 py-2 hidden sm:table-cell">
                    <textarea
                      value={p.models.join("\n")}
                      onChange={(e) => update(idx, { models: e.target.value.split("\n").map(s => s.trim()).filter(Boolean) })}
                      disabled={saving}
                      rows={Math.max(1, p.models.length)}
                      className={inputClassSm + " resize-none"}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => remove(idx)}
                      disabled={saving}
                      className="text-gray-300 hover:text-red-500 transition-colors disabled:opacity-30"
                    >
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding ? (
        <div className="border border-gray-200 rounded-lg p-3 space-y-2 bg-gray-50/50">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") setAdding(false) }}
              placeholder="Provider name"
              className={inputClassSm}
            />
            <input
              value={newBaseUrl}
              onChange={(e) => setNewBaseUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") add() }}
              placeholder="Base URL"
              className={inputClassSm}
            />
          </div>
          <textarea
            value={newModels}
            onChange={(e) => setNewModels(e.target.value)}
            placeholder="Models (one per line)"
            rows={3}
            className={inputClassSm + " resize-none"}
          />
          <div className="flex items-center gap-2">
            <button onClick={add} className="px-3 h-7 rounded bg-gray-900 text-white text-[11px] font-medium hover:bg-gray-800">Add</button>
            <button onClick={() => setAdding(false)} className="text-[11px] text-gray-400 hover:text-gray-600">Cancel</button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          disabled={saving}
          className="text-[11px] text-gray-500 hover:text-gray-900 inline-flex items-center gap-1 transition-colors disabled:opacity-50"
        >
          <Plus size={11} /> add provider preset
        </button>
      )}
    </div>
  )
}

// ── Mise Tool Presets Editor ──

function MiseToolPresetsEditor({
  presets,
  onChange,
  saving,
}: {
  presets: MiseToolPreset[]
  onChange: (presets: MiseToolPreset[]) => void
  saving: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState("")
  const [newVersion, setNewVersion] = useState("")
  const [newDesc, setNewDesc] = useState("")
  const [newBackend, setNewBackend] = useState("")

  const add = () => {
    const n = newName.trim()
    if (!n || !newVersion.trim()) return
    onChange([...presets, {
      name: n,
      suggestedVersion: newVersion.trim(),
      description: newDesc.trim() || undefined,
      backend: newBackend.trim() || undefined,
    }])
    setNewName(""); setNewVersion(""); setNewDesc(""); setNewBackend(""); setAdding(false)
  }

  const remove = (idx: number) => {
    onChange(presets.filter((_, i) => i !== idx))
  }

  const update = (idx: number, patch: Partial<MiseToolPreset>) => {
    onChange(presets.map((p, i) => i === idx ? { ...p, ...patch } : p))
  }

  return (
    <div className="space-y-3">
      {presets.length === 0 && !adding && (
        <div className="text-[12px] text-gray-400 italic py-3">No mise tool presets. Add one to get started.</div>
      )}

      {presets.length > 0 && (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/50 text-left text-[10px] text-gray-500 uppercase tracking-wider">
                <th className="px-3 py-2 font-medium">Tool</th>
                <th className="px-3 py-2 font-medium">Version</th>
                <th className="px-3 py-2 font-medium hidden sm:table-cell">Description</th>
                <th className="px-3 py-2 font-medium hidden sm:table-cell">Backend</th>
                <th className="px-3 py-2 font-medium w-10"></th>
              </tr>
            </thead>
            <tbody>
              {presets.map((p, idx) => (
                <tr key={idx} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                  <td className="px-3 py-2">
                    <input
                      value={p.name}
                      onChange={(e) => update(idx, { name: e.target.value })}
                      disabled={saving}
                      className={inputClassSm + " w-24"}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={p.suggestedVersion}
                      onChange={(e) => update(idx, { suggestedVersion: e.target.value })}
                      disabled={saving}
                      className={inputClassSm + " w-20"}
                    />
                  </td>
                  <td className="px-3 py-2 hidden sm:table-cell">
                    <input
                      value={p.description ?? ""}
                      onChange={(e) => update(idx, { description: e.target.value || undefined })}
                      disabled={saving}
                      placeholder="optional"
                      className={inputClassSm}
                    />
                  </td>
                  <td className="px-3 py-2 hidden sm:table-cell">
                    <input
                      value={p.backend ?? ""}
                      onChange={(e) => update(idx, { backend: e.target.value || undefined })}
                      disabled={saving}
                      placeholder="optional"
                      className={inputClassSm}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => remove(idx)}
                      disabled={saving}
                      className="text-gray-300 hover:text-red-500 transition-colors disabled:opacity-30"
                    >
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding ? (
        <div className="border border-gray-200 rounded-lg p-3 space-y-2 bg-gray-50/50">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") setAdding(false) }}
              placeholder="Tool name (e.g. python)"
              className={inputClassSm}
            />
            <input
              value={newVersion}
              onChange={(e) => setNewVersion(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") add() }}
              placeholder="Suggested version (e.g. 3.12)"
              className={inputClassSm}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="Description (optional)"
              className={inputClassSm}
            />
            <input
              value={newBackend}
              onChange={(e) => setNewBackend(e.target.value)}
              placeholder="Backend (optional, e.g. aqua:sharkdp/fd)"
              className={inputClassSm}
            />
          </div>
          <div className="flex items-center gap-2">
            <button onClick={add} className="px-3 h-7 rounded bg-gray-900 text-white text-[11px] font-medium hover:bg-gray-800">Add</button>
            <button onClick={() => setAdding(false)} className="text-[11px] text-gray-400 hover:text-gray-600">Cancel</button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          disabled={saving}
          className="text-[11px] text-gray-500 hover:text-gray-900 inline-flex items-center gap-1 transition-colors disabled:opacity-50"
        >
          <Plus size={11} /> add mise tool preset
        </button>
      )}
    </div>
  )
}
