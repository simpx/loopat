import { useState, useEffect, useMemo } from "react"
import { createPortal } from "react-dom"
import { FileText, FolderOpen, ChevronRight, ChevronDown } from "lucide-react"
import { listFiles, type FileEntry } from "@/api"

interface FilePickerProps {
  loopId: string
  onPick: (path: string) => void
  onClose: () => void
  anchorRect?: DOMRect
}

async function fetchAllFiles(loopId: string, dir: string): Promise<FileEntry[]> {
  const entries = await listFiles(loopId, dir).catch(() => [] as FileEntry[])
  const result: FileEntry[] = []
  for (const e of entries) {
    result.push(e)
    if (e.type === "dir") {
      const children = await fetchAllFiles(loopId, e.path)
      result.push(...children)
    }
  }
  return result
}

export function FilePicker({ loopId, onPick, onClose, anchorRect }: FilePickerProps) {
  const posStyle = anchorRect ? {
    position: "fixed" as const,
    top: Math.min(anchorRect.top - 280, window.innerHeight - 300),
    left: Math.max(4, anchorRect.left),
  } : {
    position: "fixed" as const,
    bottom: "5rem",
    left: "1rem",
  }
  const [roots, setRoots] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")

  useEffect(() => {
    setLoading(true)
    Promise.all([
      fetchAllFiles(loopId, "workdir").catch(() => [] as FileEntry[]),
      fetchAllFiles(loopId, "context").catch(() => [] as FileEntry[]),
    ]).then(([wd, ctx]) => {
      setRoots([...wd, ...ctx])
      setLoading(false)
    })
  }, [loopId])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return []
    return roots.filter((e) => e.type === "file" && e.name.toLowerCase().includes(q))
  }, [roots, search])

  // Show tree when not searching, search results when searching
  const showSearch = search.trim().length > 0

  return createPortal(
    <>
      <div className="fixed inset-0 z-50" onClick={onClose} />
      <div style={posStyle} className="z-50 w-72 max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg" onClick={(e) => e.stopPropagation()}>
        <div className="p-1.5 border-b border-gray-100">
          <input
            autoFocus
            placeholder="Search files..."
            className="w-full px-2 py-1 text-[12px] border border-gray-200 rounded outline-none focus:border-gray-400"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="py-0.5">
          {loading ? (
            <div className="px-3 py-2 text-[11px] text-gray-400">Loading...</div>
          ) : showSearch ? (
            filtered.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-gray-400">No matches</div>
            ) : (
              filtered.map((entry) => (
                <FileSearchRow key={entry.path} entry={entry} onPick={onPick} />
              ))
            )
          ) : roots.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-gray-400">No files found</div>
          ) : (
            roots.map((entry) => (
              <FileTreeRow key={entry.path} entry={entry} loopId={loopId} depth={0} onPick={onPick} />
            ))
          )}
        </div>
      </div>
    </>,
    document.body,
  )
}

/** Simple file row for search results — shows full path */
function FileSearchRow({ entry, onPick }: { entry: FileEntry; onPick: (p: string) => void }) {
  return (
    <button
      className="flex items-center gap-1.5 w-full text-left px-2 py-1 text-[12px] hover:bg-gray-50 transition-colors"
      onClick={() => onPick(entry.path)}
    >
      <FileText size={12} className="text-blue-400 shrink-0" />
      <span className="truncate">{entry.path}</span>
    </button>
  )
}

function FileTreeRow({ entry, loopId, depth, onPick }: { entry: FileEntry; loopId: string; depth: number; onPick: (p: string) => void }) {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<FileEntry[] | null>(null)
  const isDir = entry.type === "dir"

  const toggle = async () => {
    if (!isDir) {
      onPick(entry.path)
      return
    }
    if (!open && children === null) {
      const c = await listFiles(loopId, entry.path).catch(() => [] as FileEntry[])
      setChildren(c)
    }
    setOpen(!open)
  }

  return (
    <>
      <button
        className="flex items-center gap-1.5 w-full text-left px-2 py-1 text-[12px] hover:bg-gray-50 transition-colors"
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={toggle}
      >
        {isDir ? (
          <>
            {open ? <ChevronDown size={10} className="text-gray-300" /> : <ChevronRight size={10} className="text-gray-300" />}
            <FolderOpen size={12} className="text-amber-500 shrink-0" />
          </>
        ) : (
          <>
            <span className="w-2.5 shrink-0" />
            <FileText size={12} className="text-blue-400 shrink-0" />
          </>
        )}
        <span className="truncate">{entry.name}</span>
      </button>
      {open && children && children.map((c) => (
        <FileTreeRow key={c.path} entry={c} loopId={loopId} depth={depth + 1} onPick={onPick} />
      ))}
    </>
  )
}
