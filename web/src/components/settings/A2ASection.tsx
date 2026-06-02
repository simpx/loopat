/**
 * A2A (Agent-to-Agent) settings: this account exposed as an A2A agent.
 * Edit the agent card (name/description), pick the default profiles + vault
 * that A2A-created loops use, and (re)generate the service key.
 */
import { useEffect, useState } from "react"
import { getA2A, saveA2A, regenA2AKey, type A2ASettings } from "../../api"

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-gray-500 w-20 shrink-0">{label}</span>
      <code className="flex-1 min-w-0 truncate bg-white border border-gray-200 rounded px-2 py-1 text-[10px] font-mono">{value}</code>
      <button
        onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
        className="text-[11px] text-gray-500 hover:text-gray-800 shrink-0"
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  )
}

export function A2ASection() {
  const [a2a, setA2A] = useState<A2ASettings | null>(null)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [profiles, setProfiles] = useState<string[]>([])
  const [vault, setVault] = useState("")
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [newKey, setNewKey] = useState<string | null>(null)
  const [keyBusy, setKeyBusy] = useState(false)

  const load = async () => {
    const r = await getA2A()
    if (!r) return
    setA2A(r)
    setName(r.card.name)
    setDescription(r.card.description)
    setProfiles(r.profiles)
    setVault(r.vault)
  }
  useEffect(() => { load() }, [])

  const toggleProfile = (p: string) =>
    setProfiles((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]))

  const save = async () => {
    setSaving(true)
    const ok = await saveA2A({ card: { name, description }, profiles, vault })
    setSaving(false)
    if (ok) { setSavedFlash(true); setTimeout(() => setSavedFlash(false), 1500); load() }
  }

  const regenKey = async () => {
    setKeyBusy(true)
    const token = await regenA2AKey()
    setKeyBusy(false)
    if (token) { setNewKey(token); load() }
  }

  if (!a2a) return null

  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 space-y-3">
      <div className="text-[13px] font-medium text-gray-800">A2A (Agent-to-Agent)</div>
      <p className="text-[11px] text-gray-500 leading-relaxed">
        This account is exposed as a standard A2A agent. Register its Agent Card URL with any A2A orchestrator.
      </p>

      <div className="space-y-1.5">
        <CopyRow label="Agent Card" value={a2a.cardUrl} />
        <CopyRow label="Endpoint" value={a2a.endpoint} />
      </div>

      {/* Card editor */}
      <div className="border-t border-gray-100 pt-3 space-y-2">
        <div className="text-[11px] font-medium text-gray-600">Agent card</div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Agent name (default: Loopat Agent)"
          className="w-full h-8 px-2 rounded border border-gray-300 text-[12px] focus:outline-none focus:border-gray-500"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description shown to orchestrators (what this agent does)"
          rows={2}
          className="w-full px-2 py-1 rounded border border-gray-300 text-[12px] resize-none focus:outline-none focus:border-gray-500"
        />
      </div>

      {/* Default profiles + vault */}
      <div className="border-t border-gray-100 pt-3 space-y-2">
        <div className="text-[11px] font-medium text-gray-600">Loops created via A2A use</div>
        <div>
          <div className="text-[11px] text-gray-500 mb-1">Profiles</div>
          {a2a.availableProfiles.length === 0 ? (
            <div className="text-[11px] text-gray-400 italic">no profiles in your knowledge repo</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {a2a.availableProfiles.map((p) => (
                <button
                  key={p}
                  onClick={() => toggleProfile(p)}
                  className={`text-[11px] px-2 h-6 rounded border ${
                    profiles.includes(p)
                      ? "bg-gray-900 text-white border-gray-900"
                      : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-gray-500">Vault</span>
          <select
            value={vault}
            onChange={(e) => setVault(e.target.value)}
            className="h-7 px-2 rounded border border-gray-300 text-[12px] focus:outline-none focus:border-gray-500"
          >
            <option value="">default</option>
            {a2a.availableVaults.filter((v) => v !== "default").map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={save}
          disabled={saving}
          className="text-[12px] px-3 h-8 rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {savedFlash && <span className="text-[11px] text-green-700">saved</span>}
      </div>

      {/* Key */}
      <div className="border-t border-gray-100 pt-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-medium text-gray-600">
            Service key {a2a.hasKey ? <span className="text-green-700">· set</span> : <span className="text-amber-700">· none</span>}
          </div>
          <button
            onClick={regenKey}
            disabled={keyBusy}
            className="text-[11px] px-2 h-6 rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            {keyBusy ? "…" : a2a.hasKey ? "regenerate" : "generate"}
          </button>
        </div>
        <p className="text-[11px] text-gray-500 leading-relaxed">
          The orchestrator presents this token (<code className="bg-gray-100 px-1 rounded text-[10px]">Authorization: Bearer …</code>) to call your agent. Calls run as you, with your providers/keys.
        </p>
        {newKey && (
          <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 space-y-1">
            <div className="text-[11px] text-amber-800">Copy now — shown once:</div>
            <CopyRow label="Key" value={newKey} />
          </div>
        )}
      </div>
    </div>
  )
}
