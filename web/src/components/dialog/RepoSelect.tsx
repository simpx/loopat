import { useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronsUpDown, Search } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { fuzzyMatch } from "@/lib/fuzzy"

type RepoEntry = { name: string; remote?: string; path?: string }

const NONE_LABEL = "(none — empty workdir)"

export function RepoSelect({
  value,
  onChange,
  repos,
  className,
}: {
  value: string
  onChange: (name: string) => void
  repos: RepoEntry[]
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [activeIdx, setActiveIdx] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const selected = repos.find((repo) => repo.name === value)

  const filtered = useMemo(() => {
    const q = query.trim()
    if (!q) return repos
    const scored: { repo: RepoEntry; score: number }[] = []
    for (const repo of repos) {
      const best = Math.max(
        fuzzyMatch(q, repo.name) ?? -1,
        fuzzyMatch(q, repo.remote ?? "") ?? -1,
        fuzzyMatch(q, repo.path ?? "") ?? -1,
      )
      if (best >= 0) scored.push({ repo, score: best })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.map((entry) => entry.repo)
  }, [repos, query])

  const showNone = query.trim() === ""
  const totalCount = filtered.length + (showNone ? 1 : 0)

  useEffect(() => {
    if (open) {
      setQuery("")
      setActiveIdx(0)
      requestAnimationFrame(() => searchRef.current?.focus())
    }
  }, [open])

  useEffect(() => {
    if (activeIdx >= totalCount) setActiveIdx(Math.max(0, totalCount - 1))
  }, [activeIdx, totalCount])

  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`)
    el?.scrollIntoView({ block: "nearest" })
  }, [activeIdx, open])

  function pickByIndex(idx: number) {
    if (showNone && idx === 0) {
      onChange("")
    } else {
      const repo = filtered[idx - (showNone ? 1 : 0)]
      if (!repo) return
      onChange(repo.name)
    }
    setOpen(false)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIdx((i) => Math.min(totalCount - 1, i + 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIdx((i) => Math.max(0, i - 1))
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (totalCount > 0) pickByIndex(activeIdx)
    } else if (e.key === "Escape") {
      setOpen(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn(
            "w-full flex items-center justify-between gap-2 px-3 py-2.5 sm:py-1.5 text-base sm:text-sm border border-gray-300 rounded outline-none focus:border-gray-500 bg-white text-left",
            className,
          )}
        >
          {selected ? (
            <span className="min-w-0 flex-1 truncate">
              <span className="text-gray-900">{selected.name}</span>
              {selected.remote && <span className="text-gray-400"> · {selected.remote}</span>}
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-gray-500">{NONE_LABEL}</span>
          )}
          <ChevronsUpDown className="h-4 w-4 sm:h-3.5 sm:w-3.5 text-gray-400 shrink-0" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-[var(--radix-popover-trigger-width)] p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          searchRef.current?.focus()
        }}
      >
        <div className="flex items-center gap-1.5 border-b border-gray-200 px-2 py-1.5">
          <Search className="h-3.5 w-3.5 text-gray-400 shrink-0" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIdx(0)
            }}
            onKeyDown={onKeyDown}
            placeholder="Search repos..."
            className="w-full bg-transparent text-sm outline-none placeholder:text-gray-400"
          />
        </div>

        <div ref={listRef} role="listbox" className="max-h-64 overflow-y-auto py-1">
          {showNone && (
            <Row
              idx={0}
              active={activeIdx === 0}
              selected={value === ""}
              onMouseEnter={() => setActiveIdx(0)}
              onClick={() => pickByIndex(0)}
            >
              <div className="text-sm text-gray-500 italic">{NONE_LABEL}</div>
            </Row>
          )}
          {filtered.map((repo, i) => {
            const idx = i + (showNone ? 1 : 0)
            return (
              <Row
                key={repo.name}
                idx={idx}
                active={activeIdx === idx}
                selected={value === repo.name}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => pickByIndex(idx)}
              >
                <div className="text-sm text-gray-900">{repo.name}</div>
                {(repo.remote || repo.path) && (
                  <div className="text-[11px] text-gray-400 truncate">{repo.remote ?? repo.path}</div>
                )}
              </Row>
            )
          })}
          {filtered.length === 0 && !showNone && (
            <div className="px-3 py-4 text-center text-xs text-gray-400">No repos match.</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Row({
  idx,
  active,
  selected,
  onMouseEnter,
  onClick,
  children,
}: {
  idx: number
  active: boolean
  selected: boolean
  onMouseEnter: () => void
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      data-idx={idx}
      onMouseEnter={onMouseEnter}
      onMouseDown={(e) => {
        e.preventDefault()
      }}
      onClick={onClick}
      className={cn("flex items-start gap-2 px-2 py-1.5 cursor-pointer", active && "bg-gray-100")}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {selected && <Check className="h-3.5 w-3.5 text-gray-500 mt-0.5 shrink-0" />}
    </div>
  )
}
