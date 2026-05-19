/**
 * Full-screen Settings page — the UX-friendly editor for
 * `personal/<user>/.loopat/config.json`. Sections: Providers, Environment,
 * Mounts, Shell, Personal Repo. Output is byte-identical to hand-editing
 * the JSON.
 *
 * Gating: everything except Personal Repo is grayed out until the user
 * has both `personalRepo` set AND `imported: true` (per /api/personal/status).
 * The Personal Repo section embeds the existing PersonalRepoPanel so users
 * can complete setup in place.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react"
import { useNavigate, useParams } from "react-router-dom"
import {
  getPersonalStatus,
  getPersonalDisk,
  savePersonalDisk,
  writePersonalValue,
  listPersonalEntries,
  type ConfigValue,
  type PersonalConfigDisk,
  type ProviderDisk,
  type MountDisk,
  type RefExistsMap,
  type PersonalEntry,
} from "../api"
import { PersonalRepoPanel } from "../components/dialog/PersonalRepoPanel"
import { McpStatusPanel } from "../components/McpStatusPanel"
import { ArrowLeft, Plus, Trash2, RefreshCw, Check, AlertCircle, Lock, FileCode2, Search } from "lucide-react"
import { useSearchParams } from "react-router-dom"

type TabId = "personal-repo" | "providers" | "envs" | "mounts" | "shell" | "mcp"

const TABS: { id: TabId; label: string; gated: boolean; description: string }[] = [
  { id: "personal-repo", label: "Personal Repo",          gated: false, description: "Your private repo carrying credentials + dotfiles." },
  { id: "providers",     label: "AI Providers",           gated: true,  description: "Models, base URLs, API keys. Pick a default." },
  { id: "envs",          label: "Environment Variables", gated: true,  description: "Env vars injected into every loop sandbox." },
  { id: "mounts",        label: "Sandbox Mounts",         gated: true,  description: "Expose personal files / dirs into loop sandboxes." },
  { id: "shell",         label: "Terminal Shell",         gated: true,  description: "PTY shell binary used in loop terminals." },
  { id: "mcp",           label: "MCP",                    gated: true,  description: "OAuth tokens for MCP servers. Per-vault." },
]

// ────────────────────────────────────────────────────────────────────────────
// Page shell
// ────────────────────────────────────────────────────────────────────────────

export function SettingsPage() {
  const navigate = useNavigate()
  const { tab } = useParams<{ tab: string }>()
  const active = (TABS.some((t) => t.id === tab) ? tab : "personal-repo") as TabId

  const [loading, setLoading] = useState(true)
  const [statusReady, setStatusReady] = useState(false)
  const [statusReason, setStatusReason] = useState<string>("")
  const [disk, setDisk] = useState<PersonalConfigDisk | null>(null)
  const [refExists, setRefExists] = useState<RefExistsMap>({})

  const refresh = useCallback(async () => {
    setLoading(true)
    const [status, diskRes] = await Promise.all([getPersonalStatus(), getPersonalDisk()])
    const ready = !!status && !!status.personalRepo && status.imported
    setStatusReady(ready)
    setStatusReason(
      !status || !status.personalRepo
        ? "no personal repo configured"
        : !status.imported
          ? "personal repo not imported yet"
          : "",
    )
    if (diskRes) {
      setDisk(diskRes.disk)
      setRefExists(diskRes.refExists)
    }
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // If the active tab is gated and personal repo isn't ready, bounce to the
  // personal-repo tab so users see the unlock path instead of a dead pane.
  useEffect(() => {
    if (!loading && !statusReady && TABS.find((t) => t.id === active)?.gated) {
      navigate(`/settings/personal-repo`, { replace: true })
    }
  }, [loading, statusReady, active, navigate])

  const activeMeta = TABS.find((t) => t.id === active) ?? TABS[0]
  const isGatedAndLocked = activeMeta.gated && !statusReady

  const [search, setSearch] = useState("")
  const filteredTabs = search.trim() === ""
    ? TABS
    : TABS.filter((t) =>
        t.label.toLowerCase().includes(search.toLowerCase()) ||
        t.description.toLowerCase().includes(search.toLowerCase()) ||
        t.id.toLowerCase().includes(search.toLowerCase()),
      )

  return (
    <div className="h-full overflow-hidden bg-gray-50 flex flex-col">
      <style>{`
        .ip { width: 100%; padding: 6px 10px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 13px; outline: none; background: white; }
        .ip:focus { border-color: #111827; }
        .ip:disabled { background: #f3f4f6; color: #9ca3af; }
      `}</style>

      <header className="shrink-0 border-b border-gray-200 bg-white px-4 sm:px-6 h-12 flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="w-8 h-8 flex items-center justify-center rounded text-gray-500 hover:text-gray-900 hover:bg-gray-100"
          title="back"
        >
          <ArrowLeft size={16} />
        </button>
        <h1 className="text-[15px] font-semibold text-gray-900">Settings</h1>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => navigate("/context/personal?file=.loopat/config.json&edit=1")}
          className="h-7 px-2.5 rounded text-xs border border-gray-200 hover:bg-gray-100 text-gray-700 flex items-center gap-1.5"
          title="open raw config.json in Context tab"
        >
          <FileCode2 size={12} />
          <span className="hidden sm:inline">edit raw config.json</span>
        </button>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="h-7 px-2.5 rounded text-xs border border-gray-200 hover:bg-gray-100 text-gray-700 flex items-center gap-1.5 disabled:opacity-50"
          title="reload"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          <span className="hidden sm:inline">reload</span>
        </button>
      </header>

      <div className="flex-1 min-h-0 flex flex-col sm:flex-row">
        {/* tab nav: horizontal on mobile, vertical sidebar on desktop */}
        <nav className="sm:w-56 shrink-0 sm:border-r border-b sm:border-b-0 border-gray-200 bg-white flex flex-col">
          {/* search */}
          <div className="hidden sm:block px-3 py-3 border-b border-gray-100">
            <div className="relative">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="search settings"
                className="w-full pl-7 pr-2 py-1.5 text-[12px] border border-gray-200 rounded outline-none focus:border-gray-400 bg-gray-50 focus:bg-white"
              />
            </div>
          </div>
          <ul className="flex sm:flex-col gap-0.5 sm:gap-0 p-2 sm:py-2 overflow-x-auto sm:overflow-x-visible">
            {filteredTabs.map((t) => {
              const isActive = t.id === active
              const locked = t.gated && !statusReady
              return (
                <li key={t.id} className="shrink-0 sm:px-1">
                  <button
                    type="button"
                    onClick={() => navigate(`/settings/${t.id}`)}
                    className={
                      "w-full text-left px-2.5 py-1.5 rounded text-[13px] flex items-center gap-2 transition-colors whitespace-nowrap " +
                      (isActive
                        ? "bg-gray-100 text-gray-900 font-medium"
                        : "text-gray-600 hover:bg-gray-50 hover:text-gray-900")
                    }
                  >
                    <span className="flex-1 truncate">{t.label}</span>
                    {locked && (
                      <span title="locked — set up personal repo">
                        <Lock size={11} className="text-amber-600 shrink-0" />
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
            {filteredTabs.length === 0 && (
              <li className="px-3 py-2 text-[11px] text-gray-400 italic">no match</li>
            )}
          </ul>
        </nav>

        {/* tab content */}
        <main className="flex-1 min-w-0 min-h-0 overflow-auto">
          <div className="max-w-[760px] mx-auto px-4 sm:px-6 py-5">
            {loading && !disk ? (
              <div className="text-[13px] text-gray-400 italic py-12 text-center">loading…</div>
            ) : (
              <>
                <div className="mb-4">
                  <h2 className="text-[16px] font-semibold text-gray-900">{activeMeta.label}</h2>
                  <p className="text-[12.5px] text-gray-500 mt-0.5">{activeMeta.description}</p>
                </div>

                {isGatedAndLocked && (
                  <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-2">
                    <AlertCircle size={16} className="text-amber-700 mt-0.5 shrink-0" />
                    <div className="text-[13px] text-amber-900 flex-1">
                      <div className="font-medium">Set up your personal repo first</div>
                      <div className="text-[12px] text-amber-800/90 mt-0.5">
                        These settings live in your personal repo. Complete setup in
                        the <button onClick={() => navigate("/settings/personal-repo")} className="underline">Personal Repo</button> tab; this section will unlock automatically.
                        <span className="text-amber-700/70"> ({statusReason})</span>
                      </div>
                    </div>
                  </div>
                )}

                <div className={isGatedAndLocked ? "opacity-50 pointer-events-none" : ""}>
                  {active === "personal-repo" && <PersonalRepoPanel onDone={refresh} />}
                  {active === "providers" && (
                    <ProvidersSection disk={disk} refExists={refExists} onChanged={refresh} disabled={isGatedAndLocked} />
                  )}
                  {active === "envs" && (
                    <EnvsSection disk={disk} refExists={refExists} onChanged={refresh} disabled={isGatedAndLocked} />
                  )}
                  {active === "mounts" && (
                    <MountsSection disk={disk} onChanged={refresh} disabled={isGatedAndLocked} />
                  )}
                  {active === "shell" && (
                    <ShellSection disk={disk} onChanged={refresh} disabled={isGatedAndLocked} />
                  )}
                  {active === "mcp" && (
                    <McpSection disabled={isGatedAndLocked} />
                  )}
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Providers
// ────────────────────────────────────────────────────────────────────────────

type ProvidersDraft = {
  default: string
  providers: Record<string, {
    model: string
    baseUrl: string
    maxContextTokens: string
    /** New value typed by the user. Empty = "keep whatever is in the vault". */
    apiKeyNewValue: string
    /** Whether the apiKey vault file exists today. Display-only. */
    apiKeyStored: boolean
  }>
}

function ProvidersSection({ disk, refExists, onChanged, disabled }: {
  disk: PersonalConfigDisk | null
  refExists: RefExistsMap
  onChanged: () => void
  disabled?: boolean
}) {
  const [draft, setDraft] = useState<ProvidersDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [newName, setNewName] = useState("")
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    if (!disk) { setDraft(null); return }
    const next: ProvidersDraft = { default: "", providers: {} }
    for (const [name, val] of Object.entries(disk.providers)) {
      if (name === "default") {
        if (typeof val === "string") next.default = val
        continue
      }
      if (val && typeof val === "object") {
        const p = val as ProviderDisk
        const refInfo = refExists[`providers.${name}.apiKey`]
        next.providers[name] = {
          model: p.model ?? "",
          baseUrl: p.baseUrl ?? "",
          maxContextTokens: p.maxContextTokens ? String(p.maxContextTokens) : "",
          apiKeyNewValue: "",
          apiKeyStored: !!refInfo?.exists,
        }
      }
    }
    setDraft(next)
  }, [disk, refExists])

  const names = draft ? Object.keys(draft.providers) : []

  const update = (name: string, field: keyof ProvidersDraft["providers"][string], value: any) => {
    setDraft((d) => {
      if (!d || !d.providers[name]) return d
      return { ...d, providers: { ...d.providers, [name]: { ...d.providers[name], [field]: value } } }
    })
  }

  const remove = (name: string) => {
    setDraft((d) => {
      if (!d) return d
      const { [name]: _, ...rest } = d.providers
      return { ...d, providers: rest, default: d.default === name ? "" : d.default }
    })
  }

  const addProvider = () => {
    const n = newName.trim()
    if (!n) return
    if (n === "default") { setErr("'default' is reserved"); return }
    setDraft((d) => {
      if (!d) return d
      if (d.providers[n]) return d
      return { ...d, providers: { ...d.providers, [n]: {
        model: "", baseUrl: "", maxContextTokens: "",
        apiKeyNewValue: "", apiKeyStored: false,
      } } }
    })
    setNewName("")
    setAdding(false)
    setErr(null)
  }

  const save = async () => {
    if (!draft) return
    setSaving(true)
    setErr(null)
    // Best practice: each provider's apiKey ALWAYS lives at
    //   <active vault>/provider-keys/<providerName>
    // The user just enters the value; we own the storage layout. Renaming
    // a provider implicitly moves the key file (next save writes to the
    // new path).
    for (const [name, p] of Object.entries(draft.providers)) {
      if (!p.apiKeyNewValue.trim()) continue
      const r = await writePersonalValue({ vault: `provider-keys/${name}` }, p.apiKeyNewValue.trim())
      if (!r.ok) { setErr(`apiKey write failed for "${name}": ${r.error}`); setSaving(false); return }
    }
    const providersOut: Record<string, ProviderDisk | string> = {}
    if (draft.default) providersOut.default = draft.default
    for (const [name, p] of Object.entries(draft.providers)) {
      providersOut[name] = {
        model: p.model,
        baseUrl: p.baseUrl,
        apiKey: { vault: `provider-keys/${name}` },
        ...(p.maxContextTokens ? { maxContextTokens: Number(p.maxContextTokens) } : {}),
      }
    }
    const r = await savePersonalDisk({ providers: providersOut })
    setSaving(false)
    if (!r.ok) { setErr(r.error ?? "save failed"); return }
    onChanged()
  }

  if (!draft) return <div className="text-[12px] text-gray-400 italic">no providers yet</div>

  return (
    <div className="flex flex-col gap-3">
      {names.map((name) => {
        const p = draft.providers[name]
        return (
          <div key={name} className="border border-gray-200 rounded-md p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-gray-900">{name}</span>
                <label
                  className={"text-[11px] flex items-center gap-1 px-1.5 py-0.5 rounded cursor-pointer select-none " + (draft.default === name ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200")}
                >
                  <input
                    type="radio"
                    name="default-provider"
                    checked={draft.default === name}
                    onChange={() => setDraft((d) => d ? { ...d, default: name } : d)}
                    className="hidden"
                  />
                  <span>★ default</span>
                </label>
              </div>
              <button
                type="button"
                onClick={() => remove(name)}
                className="text-[11px] text-gray-400 hover:text-red-500"
              >
                remove
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <Labeled label="Model">
                <input
                  value={p.model}
                  onChange={(e) => update(name, "model", e.target.value)}
                  placeholder="e.g. claude-opus-4-7"
                  className="ip"
                />
              </Labeled>
              <Labeled label="Base URL">
                <input
                  value={p.baseUrl}
                  onChange={(e) => update(name, "baseUrl", e.target.value)}
                  placeholder="https://api.example.com"
                  className="ip"
                />
              </Labeled>
              <Labeled label="Max context tokens">
                <input
                  type="number"
                  value={p.maxContextTokens}
                  onChange={(e) => update(name, "maxContextTokens", e.target.value)}
                  placeholder="auto"
                  className="ip"
                />
              </Labeled>
              <Labeled label={p.apiKeyStored ? "API key (set — type to overwrite)" : "API key"}>
                <input
                  type="password"
                  value={p.apiKeyNewValue}
                  onChange={(e) => update(name, "apiKeyNewValue", e.target.value)}
                  placeholder={p.apiKeyStored ? "•••••• stored encrypted in vault" : "paste API key"}
                  className="ip"
                />
              </Labeled>
            </div>
          </div>
        )
      })}

      {adding ? (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addProvider(); if (e.key === "Escape") setAdding(false) }}
            placeholder="provider name"
            className="ip flex-1"
          />
          <button onClick={addProvider} className="px-2.5 h-7 rounded bg-gray-900 text-white text-xs hover:bg-gray-700">add</button>
          <button onClick={() => { setAdding(false); setNewName("") }} className="text-xs text-gray-400 hover:text-gray-700">cancel</button>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="self-start text-xs text-gray-500 hover:text-gray-900 inline-flex items-center gap-1"
        >
          <Plus size={12} /> add provider
        </button>
      )}

      <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-100">
        {err && <span className="text-[11px] text-red-600">{err}</span>}
        <button
          onClick={save}
          disabled={saving || disabled}
          className="px-3 h-8 rounded bg-gray-900 text-white text-xs hover:bg-gray-700 disabled:opacity-50"
        >
          {saving ? "saving…" : "save providers"}
        </button>
      </div>

    </div>
  )
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-gray-500">{label}</span>
      {children}
    </label>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Envs
// ────────────────────────────────────────────────────────────────────────────

type EnvDraft = {
  key: string
  encrypted: boolean
  /** Plain value (used when !encrypted). */
  literal: string
  /** New encrypted value typed by the user — empty = keep existing. */
  newValue: string
  /** Was the encrypted value already stored on disk? Display only. */
  stored: boolean
}

function EnvsSection({ disk, refExists, onChanged, disabled }: {
  disk: PersonalConfigDisk | null
  refExists: RefExistsMap
  onChanged: () => void
  disabled?: boolean
}) {
  const [rows, setRows] = useState<EnvDraft[]>([])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!disk) { setRows([]); return }
    const out: EnvDraft[] = []
    for (const [k, v] of Object.entries(disk.envs ?? {})) {
      const refInfo = refExists[`envs.${k}`]
      if (typeof v === "string") {
        out.push({ key: k, encrypted: false, literal: v, newValue: "", stored: false })
      } else {
        out.push({ key: k, encrypted: true, literal: "", newValue: "", stored: !!refInfo?.exists })
      }
    }
    setRows(out)
  }, [disk, refExists])

  const update = (i: number, patch: Partial<EnvDraft>) => {
    setRows((rs) => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r))
  }
  const remove = (i: number) => setRows((rs) => rs.filter((_, idx) => idx !== i))
  const add = () => setRows((rs) => [...rs, { key: "", encrypted: true, literal: "", newValue: "", stored: false }])

  const save = async () => {
    setSaving(true)
    setErr(null)
    // Validate keys
    const seen = new Set<string>()
    for (const r of rows) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.key)) { setErr(`invalid env name "${r.key}"`); setSaving(false); return }
      if (seen.has(r.key)) { setErr(`duplicate env name "${r.key}"`); setSaving(false); return }
      seen.add(r.key)
    }
    // Best practice: encrypted envs always live at
    //   <active vault>/envs/<envName>
    // The user toggles encrypted on/off; we own the storage layout.
    for (const r of rows) {
      if (!r.encrypted) continue
      if (!r.newValue.trim()) continue
      const wr = await writePersonalValue({ vault: `envs/${r.key}` }, r.newValue.trim())
      if (!wr.ok) { setErr(`value write failed for ${r.key}: ${wr.error}`); setSaving(false); return }
    }
    const envs: Record<string, ConfigValue> = {}
    for (const r of rows) {
      envs[r.key] = r.encrypted ? { vault: `envs/${r.key}` } : r.literal
    }
    const res = await savePersonalDisk({ envs })
    setSaving(false)
    if (!res.ok) { setErr(res.error ?? "save failed"); return }
    onChanged()
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 && (
        <div className="text-[12px] text-gray-400 italic">no environment variables</div>
      )}
      {rows.map((r, i) => (
        <div key={i} className="border border-gray-200 rounded-md p-3 grid grid-cols-1 sm:grid-cols-[200px_1fr_auto_auto] gap-2.5 items-start">
          <Labeled label="Name">
            <input
              value={r.key}
              onChange={(e) => update(i, { key: e.target.value })}
              placeholder="ENV_NAME"
              className="ip font-mono"
            />
          </Labeled>
          <Labeled label={r.encrypted ? (r.stored ? "Value (set — type to overwrite)" : "Value") : "Value (plain text)"}>
            {r.encrypted ? (
              <input
                type="password"
                value={r.newValue}
                onChange={(e) => update(i, { newValue: e.target.value })}
                placeholder={r.stored ? "•••••• stored encrypted in vault" : "type secret value"}
                className="ip"
              />
            ) : (
              <input
                value={r.literal}
                onChange={(e) => update(i, { literal: e.target.value })}
                placeholder="value"
                className="ip"
              />
            )}
          </Labeled>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-gray-500">{r.encrypted ? "🔒 Encrypted" : "Encryption"}</span>
            <label className="flex items-center gap-1.5 h-[34px] text-[12px] text-gray-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={r.encrypted}
                onChange={(e) => update(i, { encrypted: e.target.checked, newValue: "", stored: false })}
              />
              <span>{r.encrypted ? "stored encrypted" : "plain text"}</span>
            </label>
          </div>
          <button
            onClick={() => remove(i)}
            className="self-start h-[34px] mt-[19px] w-7 flex items-center justify-center text-gray-400 hover:text-red-600 rounded"
            title="remove"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button
        onClick={add}
        className="self-start text-xs text-gray-500 hover:text-gray-900 inline-flex items-center gap-1"
      >
        <Plus size={12} /> add env var
      </button>
      <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-100">
        {err && <span className="text-[11px] text-red-600">{err}</span>}
        <button
          onClick={save}
          disabled={saving || disabled}
          className="px-3 h-8 rounded bg-gray-900 text-white text-xs hover:bg-gray-700 disabled:opacity-50"
        >
          {saving ? "saving…" : "save env"}
        </button>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Mounts
// ────────────────────────────────────────────────────────────────────────────

type MountRow = {
  /** "vault" → src is `{vault: path}`; "personal" → src is `path`. */
  source: "vault" | "personal"
  path: string
  dst: string
  rw: boolean
  /** User has manually edited dst → don't auto-derive anymore. */
  dstTouched: boolean
}

function MountsSection({ disk, onChanged, disabled }: {
  disk: PersonalConfigDisk | null
  onChanged: () => void
  disabled?: boolean
}) {
  const [rows, setRows] = useState<MountRow[]>([])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [vaultEntries, setVaultEntries] = useState<PersonalEntry[]>([])
  const [personalEntries, setPersonalEntries] = useState<PersonalEntry[]>([])

  useEffect(() => {
    Promise.all([listPersonalEntries("vault"), listPersonalEntries("personal")]).then(([v, p]) => {
      setVaultEntries(v)
      setPersonalEntries(p)
    })
  }, [])

  useEffect(() => {
    if (!disk) { setRows([]); return }
    const next: MountRow[] = []
    for (const m of disk.mounts ?? []) {
      if (typeof m.src === "string") {
        next.push({ source: "personal", path: m.src, dst: m.dst, rw: !!m.rw, dstTouched: true })
      } else if (m.src && typeof m.src === "object" && "vault" in m.src) {
        next.push({ source: "vault", path: (m.src as any).vault, dst: m.dst, rw: !!m.rw, dstTouched: true })
      }
    }
    setRows(next)
  }, [disk])

  const deriveDst = (path: string): string => {
    if (!path) return "$HOME/"
    return `$HOME/${path}`
  }

  const update = (i: number, patch: Partial<MountRow>) => {
    setRows((rs) => rs.map((r, idx) => {
      if (idx !== i) return r
      const next = { ...r, ...patch }
      // Re-derive dst when path or source changes, unless the user has
      // manually edited dst.
      if (("path" in patch || "source" in patch) && !next.dstTouched) {
        next.dst = deriveDst(next.path)
      }
      return next
    }))
  }
  const remove = (i: number) => setRows((rs) => rs.filter((_, idx) => idx !== i))
  const add = () => setRows((rs) => [...rs, { source: "vault", path: "", dst: "$HOME/", rw: false, dstTouched: false }])

  const save = async () => {
    setSaving(true)
    setErr(null)
    const out: MountDisk[] = []
    for (const r of rows) {
      if (!r.path) { setErr("pick a source path for every mount"); setSaving(false); return }
      if (!r.dst || (!r.dst.startsWith("$HOME") && !r.dst.startsWith("~") && !r.dst.startsWith("/"))) {
        setErr(`mount dst "${r.dst}" must start with $HOME/ ~/ or /`)
        setSaving(false)
        return
      }
      out.push({
        src: r.source === "vault" ? { vault: r.path } : r.path,
        dst: r.dst,
        ...(r.rw ? { rw: true } : {}),
      })
    }
    const res = await savePersonalDisk({ mounts: out })
    setSaving(false)
    if (!res.ok) { setErr(res.error ?? "save failed"); return }
    onChanged()
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 && <div className="text-[12px] text-gray-400 italic">no mounts</div>}
      {rows.map((r, i) => {
        const entries = r.source === "vault" ? vaultEntries : personalEntries
        const listId = `mount-paths-${i}`
        return (
          <div key={i} className="border border-gray-200 rounded-md p-3 grid grid-cols-1 sm:grid-cols-[160px_1fr_1fr_auto_auto] gap-2.5 items-start">
            <Labeled label="Source">
              <select
                value={r.source}
                onChange={(e) => update(i, { source: e.target.value as MountRow["source"], path: "" })}
                className="ip"
              >
                <option value="vault">Vault (encrypted)</option>
                <option value="personal">Personal (plain)</option>
              </select>
            </Labeled>
            <Labeled label="Path">
              <input
                list={listId}
                value={r.path}
                onChange={(e) => update(i, { path: e.target.value })}
                placeholder={r.source === "vault" ? "pick from vault…" : "pick from personal…"}
                className="ip font-mono"
              />
              <datalist id={listId}>
                {entries.map((e) => (
                  <option key={e.path} value={e.path}>{e.type === "dir" ? "📁" : "📄"} {e.path}</option>
                ))}
              </datalist>
            </Labeled>
            <Labeled label="Mount inside sandbox at">
              <input
                value={r.dst}
                onChange={(e) => update(i, { dst: e.target.value, dstTouched: true })}
                placeholder="$HOME/.config/foo"
                className="ip font-mono"
              />
            </Labeled>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-gray-500">Access</span>
              <label className="flex items-center gap-1.5 h-[34px] text-[12px] text-gray-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={r.rw}
                  onChange={(e) => update(i, { rw: e.target.checked })}
                />
                <span>read-write</span>
              </label>
            </div>
            <button
              onClick={() => remove(i)}
              className="self-start h-[34px] mt-[19px] w-7 flex items-center justify-center text-gray-400 hover:text-red-600 rounded"
              title="remove"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )
      })}
      <button
        onClick={add}
        className="self-start text-xs text-gray-500 hover:text-gray-900 inline-flex items-center gap-1"
      >
        <Plus size={12} /> add mount
      </button>
      <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-100">
        {err && <span className="text-[11px] text-red-600">{err}</span>}
        <button
          onClick={save}
          disabled={saving || disabled}
          className="px-3 h-8 rounded bg-gray-900 text-white text-xs hover:bg-gray-700 disabled:opacity-50"
        >
          {saving ? "saving…" : "save mounts"}
        </button>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Shell
// ────────────────────────────────────────────────────────────────────────────

const SHELL_PRESETS: Array<{ value: string; label: string; description: string }> = [
  { value: "",                  label: "Default (bash)",      description: "POSIX-guaranteed; works everywhere" },
  { value: "fish",              label: "fish",                description: "Friendly interactive shell with autosuggestions" },
  { value: "zsh",               label: "zsh",                 description: "Common default on macOS-style setups" },
]

function ShellSection({ disk, onChanged, disabled }: {
  disk: PersonalConfigDisk | null
  onChanged: () => void
  disabled?: boolean
}) {
  const [val, setVal] = useState("")
  const [customMode, setCustomMode] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const v = disk?.shell ?? ""
    setVal(v)
    setCustomMode(!!v && !SHELL_PRESETS.some((p) => p.value === v))
  }, [disk])

  const save = async () => {
    setSaving(true)
    setErr(null)
    setSaved(false)
    const r = await savePersonalDisk({ shell: val })
    setSaving(false)
    if (!r.ok) { setErr(r.error ?? "save failed"); return }
    setSaved(true)
    onChanged()
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        {SHELL_PRESETS.map((p) => (
          <label
            key={p.value || "default"}
            className={
              "flex items-start gap-2 px-3 py-2 rounded border " +
              (!customMode && val === p.value ? "border-gray-900 bg-gray-50" : "border-gray-200 hover:bg-gray-50")
            }
          >
            <input
              type="radio"
              name="shell-preset"
              checked={!customMode && val === p.value}
              onChange={() => { setVal(p.value); setCustomMode(false); setSaved(false) }}
              className="mt-0.5"
            />
            <div className="flex-1 min-w-0">
              <div className="text-[13px] text-gray-900">{p.label}</div>
              <div className="text-[11.5px] text-gray-500">{p.description}</div>
            </div>
          </label>
        ))}
        <label
          className={
            "flex items-start gap-2 px-3 py-2 rounded border " +
            (customMode ? "border-gray-900 bg-gray-50" : "border-gray-200 hover:bg-gray-50")
          }
        >
          <input
            type="radio"
            name="shell-preset"
            checked={customMode}
            onChange={() => { setCustomMode(true); setSaved(false) }}
            className="mt-0.5"
          />
          <div className="flex-1 min-w-0">
            <div className="text-[13px] text-gray-900">Custom</div>
            <div className="text-[11.5px] text-gray-500 mb-1">Binary name in sandbox PATH or absolute path</div>
            {customMode && (
              <input
                value={val}
                onChange={(e) => { setVal(e.target.value); setSaved(false) }}
                placeholder="/usr/bin/nushell"
                className="ip font-mono"
              />
            )}
          </div>
        </label>
      </div>
      <div className="flex items-center justify-end gap-2 pt-3 border-t border-gray-100">
        {err && <span className="text-[11px] text-red-600">{err}</span>}
        {saved && !err && <span className="text-[11px] text-emerald-700 flex items-center gap-1"><Check size={12} /> saved</span>}
        <button
          onClick={save}
          disabled={saving || disabled}
          className="px-3 h-8 rounded bg-gray-900 text-white text-xs hover:bg-gray-700 disabled:opacity-50"
        >
          {saving ? "saving…" : "save shell"}
        </button>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// MCP section — thin wrapper over the shared McpStatusPanel. Adds the
// "auth completed" flash for the OAuth redirect-back, since this is the
// landing page after a successful /api/mcp-auth/callback round-trip.
// ────────────────────────────────────────────────────────────────────────────

function McpSection({ disabled }: { disabled: boolean }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [flash, setFlash] = useState<{ kind: "ok" | "error"; text: string } | null>(null)

  useEffect(() => {
    const s = searchParams.get("status")
    if (!s) return
    if (s === "ok") {
      const server = searchParams.get("server") ?? ""
      setFlash({ kind: "ok", text: `Connected to ${server} ✓` })
    } else if (s === "error") {
      const reason = searchParams.get("reason") ?? "unknown error"
      setFlash({ kind: "error", text: `Auth failed: ${reason}` })
    }
    const next = new URLSearchParams(searchParams)
    next.delete("status"); next.delete("server"); next.delete("reason")
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={disabled ? "pointer-events-none opacity-50" : ""}>
      {flash && (
        <div
          className={`mb-3 rounded px-3 py-2 text-[12px] ${
            flash.kind === "ok"
              ? "bg-green-50 text-green-800 border border-green-200"
              : "bg-red-50 text-red-800 border border-red-200"
          }`}
        >
          {flash.text}
        </div>
      )}
      <McpStatusPanel variant="settings" />
    </div>
  )
}
