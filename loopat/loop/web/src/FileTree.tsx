/**
 * File tree, structurally ported from phase1-prototype/src/pages/loop.tsx
 * (FileTreeNode + workdir layout). Loop dir contains 2 top-level
 * "section" folders: `context` (cyan) and `workdir` (emerald).
 */
import { useEffect, useState } from "react"
import { listFiles, type FileEntry } from "./api"

const ROOTS: { name: string; section: "context" | "workdir"; emoji: string; hint?: string }[] = [
  { name: "context", section: "context", emoji: "🧷", hint: "knowledge / notes / personal" },
  { name: "workdir", section: "workdir", emoji: "▣" },
]

export function FileTree({
  loopId,
  onPick,
  picked,
}: {
  loopId: string
  onPick: (path: string) => void
  picked: string | null
}) {
  const [reloadKey, setReloadKey] = useState(0)
  return (
    <aside className="flex-1 min-h-0 overflow-auto py-2 text-[13px]">
      <div className="px-3 pb-2 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-gray-400">workdir</span>
        <button
          onClick={() => setReloadKey((k) => k + 1)}
          className="text-[11px] text-gray-400 hover:text-gray-700 px-1 rounded hover:bg-gray-100"
          title="refresh"
        >
          ↻
        </button>
      </div>
      {ROOTS.map((r) => (
        <SectionFolder
          key={r.name + reloadKey}
          loopId={loopId}
          name={r.name}
          section={r.section}
          emoji={r.emoji}
          hint={r.hint}
          onPick={onPick}
          picked={picked}
        />
      ))}
    </aside>
  )
}

function SectionFolder({
  loopId,
  name,
  section,
  emoji,
  hint,
  onPick,
  picked,
}: {
  loopId: string
  name: string
  section: "context" | "workdir"
  emoji: string
  hint?: string
  onPick: (path: string) => void
  picked: string | null
}) {
  const [open, setOpen] = useState(true)
  const sectionClass =
    section === "context"
      ? "w-full py-1.5 flex items-center gap-1.5 bg-cyan-50/50 hover:bg-cyan-50 text-left border-y border-cyan-100/70"
      : "w-full py-1.5 flex items-center gap-1.5 bg-emerald-50/40 hover:bg-emerald-50 text-left border-y border-emerald-100/70"
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={sectionClass}
        style={{ paddingLeft: "0.5rem", paddingRight: "0.5rem" }}
      >
        <span className="text-gray-500">{open ? "▾" : "▸"}</span>
        <span className="text-[12px]">{emoji}</span>
        <span className="text-[11px] uppercase tracking-wider font-semibold text-gray-700">{name}</span>
        {hint && <span className="text-[10px] text-gray-500 italic ml-1">{hint}</span>}
      </button>
      {open && <Branch loopId={loopId} path={name} depth={1} onPick={onPick} picked={picked} initialOpen />}
    </>
  )
}

function Branch({
  loopId,
  path,
  depth,
  onPick,
  picked,
  initialOpen = false,
}: {
  loopId: string
  path: string
  depth: number
  onPick: (path: string) => void
  picked: string | null
  initialOpen?: boolean
}) {
  const [entries, setEntries] = useState<FileEntry[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!initialOpen) return
    setLoading(true)
    listFiles(loopId, path)
      .then(setEntries)
      .finally(() => setLoading(false))
  }, [loopId, path, initialOpen])

  if (loading)
    return (
      <div className="text-[12px] text-gray-400 italic" style={{ paddingLeft: 8 + depth * 12 }}>
        ...
      </div>
    )
  if (!entries) return null
  if (entries.length === 0)
    return (
      <div className="text-[12px] text-gray-400 italic py-1" style={{ paddingLeft: 8 + depth * 12 }}>
        (empty)
      </div>
    )

  return (
    <>
      {entries.map((e) => (
        <Node key={e.path} entry={e} loopId={loopId} depth={depth} onPick={onPick} picked={picked} />
      ))}
    </>
  )
}

function Node({
  entry,
  loopId,
  depth,
  onPick,
  picked,
}: {
  entry: FileEntry
  loopId: string
  depth: number
  onPick: (p: string) => void
  picked: string | null
}) {
  const [open, setOpen] = useState(false)
  const isPicked = picked === entry.path
  if (entry.type === "dir") {
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="w-full py-1 flex items-center gap-1.5 hover:bg-gray-50 text-left"
          style={{ paddingLeft: 8 + depth * 12, paddingRight: 8 }}
        >
          <span className="text-gray-500">{open ? "▾" : "▸"}</span>
          <span className="text-gray-500">📁</span>
          <span className="text-[13px] text-gray-900 truncate">{entry.name}</span>
        </button>
        {open && <Branch loopId={loopId} path={entry.path} depth={depth + 1} onPick={onPick} picked={picked} initialOpen />}
      </>
    )
  }
  return (
    <button
      type="button"
      onClick={() => onPick(entry.path)}
      className={
        "w-full py-1 flex items-center gap-2 text-left " +
        (isPicked ? "bg-gray-100" : "hover:bg-gray-50")
      }
      style={{ paddingLeft: 8 + depth * 12, paddingRight: 8 }}
    >
      <span className="w-4" />
      <span className="text-[13px] text-gray-900 flex-1 min-w-0 truncate">{entry.name}</span>
    </button>
  )
}
