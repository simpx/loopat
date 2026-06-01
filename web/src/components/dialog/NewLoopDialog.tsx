/**
 * New Loop dialog. Post-2026-05 profile model: pick zero or more profiles
 * from the workspace (`context/profiles/<name>/`). `base` is implicit and
 * shown as "always on". Empty selection still works (base + personal only).
 *
 * See docs/composition.md for the model.
 */
import { useEffect, useRef, useState, type FormEvent } from "react"
import { getDefaultProfiles, getLoopStats, listProfiles, getContextRepos, listVaults, type LoopStats, type ProfileEntry, type ContextRepoSpec } from "../../api"

export function NewLoopDialog({
  onClose,
  onCreate,
  initialTitle,
}: {
  onClose: () => void
  onCreate: (opts: { title: string; repo?: string; profiles?: string[]; vault?: string }) => Promise<string> | string
  initialTitle?: string
}) {
  const [title, setTitle] = useState(initialTitle ?? "")
  const [repo, setRepo] = useState("")
  const [selectedProfiles, setSelectedProfiles] = useState<Set<string>>(new Set())
  const [defaultProfileNames, setDefaultProfileNames] = useState<string[]>([])
  const [vault, setVault] = useState("default")
  const [repos, setRepos] = useState<ContextRepoSpec[]>([])
  const [profiles, setProfiles] = useState<ProfileEntry[]>([])
  const [vaults, setVaults] = useState<string[]>([])
  const [stats, setStats] = useState<LoopStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    getContextRepos().then((r) => setRepos(r.repos))
    // Pre-check the user's default_profiles from personal config (diff style:
    // dialog opens with the user's typical setup, they add/remove from there).
    Promise.all([listProfiles(), getDefaultProfiles()]).then(([allProfiles, defaults]) => {
      setProfiles(allProfiles)
      setDefaultProfileNames(defaults)
      // Only pre-check defaults that actually exist as profiles in the workspace
      const available = new Set(allProfiles.map((p) => p.name))
      setSelectedProfiles(new Set(defaults.filter((n) => available.has(n) && n !== "base")))
    })
    listVaults().then((vs) => {
      setVaults(vs)
      if (vs.includes("default")) setVault("default")
      else if (vs.length > 0) setVault(vs[0])
    })
    inputRef.current?.focus()
  }, [])

  function resetToDefaults() {
    const available = new Set(profiles.map((p) => p.name))
    setSelectedProfiles(new Set(defaultProfileNames.filter((n) => available.has(n) && n !== "base")))
  }

  // Re-fetch loop stats when the selection changes (debounced so toggling
  // multiple checkboxes in quick succession only fires once).
  useEffect(() => {
    setStatsLoading(true)
    const t = setTimeout(() => {
      getLoopStats([...selectedProfiles])
        .then(setStats)
        .finally(() => setStatsLoading(false))
    }, 120)
    return () => clearTimeout(t)
  }, [selectedProfiles])

  const isDirtyFromDefaults = (() => {
    const defaults = new Set(defaultProfileNames.filter((n) => n !== "base"))
    if (defaults.size !== selectedProfiles.size) return true
    for (const d of defaults) if (!selectedProfiles.has(d)) return true
    return false
  })()

  // base is implicit (always-on per server). Show it but make it non-toggleable.
  const baseEntry = profiles.find((p) => p.name === "base")
  const nonBase = profiles.filter((p) => p.name !== "base")

  function toggleProfile(name: string) {
    setSelectedProfiles((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      await onCreate({
        title: title.trim() || "untitled",
        repo: repo || undefined,
        profiles: selectedProfiles.size > 0 ? [...selectedProfiles] : undefined,
        vault: vault || undefined,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[480px] mx-4 bg-white rounded-md shadow-xl border border-gray-200 p-4 md:p-5 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold text-gray-900 mb-4">New loop</div>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogField label="Repo" hint="Sets the workdir. Optional — leave (none) for an empty workdir.">
            <select
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded outline-none focus:border-gray-500 bg-white"
            >
              <option value="">(none — empty workdir)</option>
              {repos.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                  {r.git ? ` · ${r.git}` : ""}
                </option>
              ))}
            </select>
            {repos.length === 0 && (
              <div className="text-[11px] text-gray-400 mt-1">
                No repos in the roster. Add them on the Context → Repos page.
              </div>
            )}
          </DialogField>

          <DialogField
            label="Profiles"
            hint="Each profile contributes plugins + a CLAUDE.md fragment. Empty = base + personal only."
          >
            <div className="border border-gray-300 rounded p-2 max-h-44 overflow-y-auto bg-white flex flex-col gap-1">
              {baseEntry && (
                <label className="flex items-start gap-2 px-1.5 py-1 rounded text-sm text-gray-500 cursor-not-allowed bg-gray-50">
                  <input type="checkbox" checked disabled className="mt-0.5" />
                  <span className="flex-1">
                    <span className="font-medium">base</span>
                    <span className="ml-1 text-[11px] text-gray-400">(always on)</span>
                    {baseEntry.description && (
                      <span className="block text-[11px] text-gray-400 mt-0.5">{baseEntry.description}</span>
                    )}
                  </span>
                </label>
              )}
              {nonBase.map((p) => {
                const checked = selectedProfiles.has(p.name)
                const isDefault = defaultProfileNames.includes(p.name)
                return (
                  <label
                    key={p.name}
                    className={`flex items-start gap-2 px-1.5 py-1 rounded text-sm cursor-pointer hover:bg-gray-50 ${
                      checked ? "bg-blue-50" : ""
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleProfile(p.name)}
                      className="mt-0.5"
                    />
                    <span className="flex-1">
                      <span className="font-medium text-gray-900">{p.name}</span>
                      {isDefault && (
                        <span
                          className="ml-1.5 px-1 py-px text-[10px] rounded bg-gray-200 text-gray-600"
                          title="In your default_profiles (personal config)"
                        >
                          default
                        </span>
                      )}
                      {p.description && (
                        <span className="block text-[11px] text-gray-500 mt-0.5">{p.description}</span>
                      )}
                    </span>
                  </label>
                )
              })}
              {nonBase.length === 0 && !baseEntry && (
                <div className="text-[11px] text-gray-400 p-1.5">
                  No profiles in workspace. Create directories under{" "}
                  <code className="bg-gray-100 px-1 rounded">context/profiles/&lt;name&gt;/</code> with a
                  profile.json.
                </div>
              )}
            </div>
            <div className="flex items-center justify-between mt-1">
              <span className="text-[11px] text-gray-500">
                {selectedProfiles.size > 0
                  ? `Selected: ${[...selectedProfiles].join(", ")}`
                  : "No profiles selected (base + personal only)"}
              </span>
              {isDirtyFromDefaults && defaultProfileNames.length > 0 && (
                <button
                  type="button"
                  onClick={resetToDefaults}
                  className="text-[11px] text-gray-500 hover:text-gray-900 underline"
                  title="Restore default_profiles from your personal config"
                >
                  reset to defaults
                </button>
              )}
            </div>

            {/* Loop preview: total contributions across team + selected profiles.
                Includes plugin internals (skills/agents/MCPs from each enabled plugin's dir). */}
            <div className="mt-1.5 px-1.5 py-1 text-[11px] text-gray-600 bg-gray-50 border border-gray-200 rounded">
              {statsLoading && !stats ? (
                <span className="text-gray-400">computing…</span>
              ) : stats ? (
                <span title="Totals across team + selected profiles + their plugins (deduped by name)">
                  <span className={stats.plugins > 0 ? "" : "text-gray-400"}>{stats.plugins} plugins</span>
                  <span className="mx-1 text-gray-300">·</span>
                  <span className={stats.skills > 0 ? "" : "text-gray-400"}>{stats.skills} skills</span>
                  <span className="mx-1 text-gray-300">·</span>
                  <span className={stats.agents > 0 ? "" : "text-gray-400"}>{stats.agents} agents</span>
                  <span className="mx-1 text-gray-300">·</span>
                  <span className={stats.hooks > 0 ? "" : "text-gray-400"}>{stats.hooks} hooks</span>
                  <span className="mx-1 text-gray-300">·</span>
                  <span className={stats.mcpServers > 0 ? "" : "text-gray-400"}>{stats.mcpServers} MCP servers</span>
                  <span className="mx-1 text-gray-300">·</span>
                  <span className={stats.toolchain > 0 ? "" : "text-gray-400"} title="mise.toml [tools] entries, deduped across team + selected profiles">{stats.toolchain} toolchain</span>
                  {statsLoading && <span className="ml-1.5 text-gray-400">·</span>}
                  {statsLoading && <span className="ml-1 text-gray-400">updating…</span>}
                </span>
              ) : (
                <span className="text-gray-400">—</span>
              )}
            </div>
          </DialogField>

          <DialogField label="Vault" hint="Which credential set to inject. Only this vault is visible inside the loop.">
            <select
              value={vault}
              onChange={(e) => setVault(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded outline-none focus:border-gray-500 bg-white"
            >
              {vaults.length === 0 && <option value="default">default</option>}
              {vaults.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            {vaults.length === 0 && (
              <div className="text-[11px] text-gray-400 mt-1">
                No vaults yet — using default. Create more under{" "}
                <code className="bg-gray-100 px-1 rounded">personal/.loopat/vaults/&lt;name&gt;/</code>{" "}
                to isolate prod / test credentials.
              </div>
            )}
          </DialogField>

          <DialogField label="Name" hint="Optional — defaults to 'untitled'.">
            <input
              ref={inputRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="refactor-gateway"
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded outline-none focus:border-gray-500"
            />
          </DialogField>

          <div className="flex justify-end gap-2 mt-2 pt-3 border-t border-gray-100">
            <button
              type="button"
              onClick={onClose}
              className="px-3 h-8 text-sm rounded text-gray-700 hover:bg-gray-100"
            >
              cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-3 h-8 text-sm rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {busy ? "creating…" : "create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function DialogField({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-gray-700 font-medium">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-gray-400">{hint}</span>}
    </label>
  )
}
