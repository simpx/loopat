/**
 * Loop "plugins" chip — sits in the composer toolbar next to ModelSelector.
 * Shows the count of plugin sub-commands available in the current loop and
 * opens a centered dialog with the full list (grouped by plugin). Clicking
 * a skill row inserts its `/plugin:skill` invocation into the composer.
 *
 * Data source: useLoopRuntime's availableSlashCommands. Plugin sub-commands
 * are the entries whose name contains ":" (per CC's plugin namespace
 * convention). The seed list (server/src/session.ts:buildInitialSlashCommands)
 * pre-populates these from each enabled plugin's host install dir, so the
 * chip is correct on first open — no need to wait for CC's init payload.
 */
import { useMemo, useState, useEffect } from "react"
import { Search, CornerDownLeft, ArrowUp, ArrowDown } from "lucide-react"
import { useLoopRuntimeExtra } from "@/useLoopRuntime"

type PluginGroup = {
  plugin: string
  skills: { name: string; description: string }[]
}

export default function PluginsButton({ onPick }: { onPick: (slashCommand: string) => void }) {
  const { availableSlashCommands } = useLoopRuntimeExtra()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [selectedIdx, setSelectedIdx] = useState(0)

  // Group plugin sub-commands by plugin name. `availableSlashCommands` may be
  // updated mid-render (CC init), so derive fresh every time.
  const groups = useMemo<PluginGroup[]>(() => {
    const byPlugin = new Map<string, PluginGroup>()
    for (const cmd of availableSlashCommands) {
      const colonAt = cmd.name.indexOf(":")
      if (colonAt < 0) continue
      const plugin = cmd.name.slice(0, colonAt)
      const skill = cmd.name.slice(colonAt + 1)
      const g = byPlugin.get(plugin) ?? { plugin, skills: [] }
      g.skills.push({ name: skill, description: cmd.description })
      byPlugin.set(plugin, g)
    }
    return [...byPlugin.values()].sort((a, b) => a.plugin.localeCompare(b.plugin))
  }, [availableSlashCommands])

  const total = useMemo(() => groups.reduce((n, g) => n + g.skills.length, 0), [groups])

  // Flat filtered list for keyboard navigation.
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    const out: { plugin: string; skill: string; description: string }[] = []
    for (const g of groups) {
      for (const s of g.skills) {
        if (q && !`${g.plugin}:${s.name}`.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q)) continue
        out.push({ plugin: g.plugin, skill: s.name, description: s.description })
      }
    }
    return out
  }, [groups, search])

  useEffect(() => {
    setSelectedIdx(0)
  }, [search, open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  // Don't render the chip if there are no plugins. Avoid noise in freeform loops.
  if (total === 0) return null

  const pick = (plugin: string, skill: string) => {
    setOpen(false)
    onPick(`/${plugin}:${skill} `)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelectedIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const item = filtered[selectedIdx]
      if (item) pick(item.plugin, item.skill)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-gray-100 transition-colors"
        title={`${total} plugin skill${total === 1 ? "" : "s"} available`}
        aria-label="Show plugins"
      >
        <span className="text-sm leading-none" aria-hidden="true">🧩</span>
        <span className="font-medium text-gray-700">{total}</span>
      </button>
    )
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/20" onClick={() => setOpen(false)} />
      <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={() => setOpen(false)}>
        <div
          className="w-[560px] max-h-[60vh] bg-white rounded-xl shadow-2xl border border-gray-200 flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleKeyDown}
        >
          {/* Search header */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 shrink-0">
            <Search className="h-4 w-4 text-gray-400 shrink-0" />
            <input
              autoFocus
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search plugins..."
              className="flex-1 text-sm outline-none text-gray-900 placeholder:text-gray-400"
            />
            <span className="text-[10px] text-gray-400">
              {filtered.length} / {total}
            </span>
            <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-400 font-mono">
              esc
            </kbd>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto py-2" role="listbox">
            {(() => {
              // Re-group filtered by plugin for display, preserving the flat
              // index used by selectedIdx (so keyboard nav and visual selection align).
              const display = new Map<string, { skill: string; description: string; idx: number }[]>()
              filtered.forEach((item, idx) => {
                const arr = display.get(item.plugin) ?? []
                arr.push({ skill: item.skill, description: item.description, idx })
                display.set(item.plugin, arr)
              })
              return Array.from(display.entries()).map(([plugin, skills]) => (
                <div key={plugin} className="mb-1">
                  <div className="flex items-center gap-1.5 px-4 py-1">
                    <span className="text-xs leading-none" aria-hidden="true">🧩</span>
                    <span className="text-[11px] font-medium text-gray-500">{plugin}</span>
                  </div>
                  {skills.map(({ skill, description, idx }) => {
                    const isSelected = idx === selectedIdx
                    return (
                      <button
                        key={skill}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => pick(plugin, skill)}
                        onMouseEnter={() => setSelectedIdx(idx)}
                        className={`w-full px-6 py-1.5 text-left flex flex-col gap-0.5 transition-colors ${
                          isSelected ? "bg-blue-50" : ""
                        }`}
                      >
                        <span className="font-mono text-[12px] text-gray-900">
                          /{plugin}:{skill}
                        </span>
                        {description && (
                          <span className="text-[11px] text-gray-500 line-clamp-2">{description}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              ))
            })()}

            {filtered.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-gray-400">
                {search ? "No skills match your search" : "No plugins available"}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center gap-4 px-4 py-2 border-t border-gray-100 text-[10px] text-gray-400 shrink-0">
            <span className="flex items-center gap-1">
              <ArrowUp className="h-3 w-3" />
              <ArrowDown className="h-3 w-3" />
              navigate
            </span>
            <span className="flex items-center gap-1">
              <CornerDownLeft className="h-3 w-3" />
              insert
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-gray-100 font-mono text-[9px]">esc</kbd>
              close
            </span>
          </div>
        </div>
      </div>
    </>
  )
}
