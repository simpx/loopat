import { useState, useEffect, useMemo, useRef, useCallback } from "react"
import { createPortal } from "react-dom"
import { FileText, FolderOpen, ChevronRight, ChevronDown, Search, CornerDownLeft, ArrowUp, ArrowDown } from "lucide-react"
import { listFiles, listFilesTree, type FileEntry } from "@/api"
import { cn } from "@/lib/utils"

interface FilePickerProps {
  loopId: string
  onPick: (path: string) => void
  onClose: () => void
}

type VisibleEntry = { entry: FileEntry; depth: number }

export function FilePicker({ loopId, onPick, onClose }: FilePickerProps) {
  const [roots, setRoots] = useState<FileEntry[]>([])
  const [allFiles, setAllFiles] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [dirChildren, setDirChildren] = useState<Record<string, FileEntry[]>>({})
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      listFiles(loopId, "workdir").catch(() => [] as FileEntry[]),
      listFilesTree(loopId, "workdir").catch(() => [] as FileEntry[]),
    ]).then(([wd, tree]) => {
      setRoots(wd)
      // tree already includes the shallow entries plus all descendants
      setAllFiles(tree)
      setLoading(false)
    })
  }, [loopId])

  const showSearch = search.trim().length > 0

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return []
    return allFiles.filter((e) => e.type === "file" && (e.path.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)))
  }, [allFiles, search])

  // Build flat list of visible tree entries
  const visibleTree = useMemo(() => {
    if (showSearch) return []
    const result: VisibleEntry[] = []
    function walk(entries: FileEntry[], depth: number) {
      for (const e of entries) {
        result.push({ entry: e, depth })
        if (e.type === "dir" && expandedDirs.has(e.path) && dirChildren[e.path]) {
          walk(dirChildren[e.path], depth + 1)
        }
      }
    }
    walk(roots, 0)
    return result
  }, [roots, showSearch, expandedDirs, dirChildren])

  useEffect(() => { setSelectedIdx(0) }, [search])

  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.children[selectedIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: "nearest" })
  }, [selectedIdx])

  const toggleDir = useCallback(async (entry: FileEntry) => {
    if (expandedDirs.has(entry.path)) {
      setExpandedDirs((prev) => { const next = new Set(prev); next.delete(entry.path); return next })
    } else {
      if (!dirChildren[entry.path]) {
        const c = await listFiles(loopId, entry.path).catch(() => [] as FileEntry[])
        setDirChildren((prev) => ({ ...prev, [entry.path]: c }))
      }
      setExpandedDirs((prev) => new Set(prev).add(entry.path))
    }
  }, [expandedDirs, dirChildren, loopId])

  const onPickOrToggle = useCallback((entry: FileEntry) => {
    if (entry.type === "dir") { toggleDir(entry); return }
    onPick(entry.path)
  }, [toggleDir, onPick])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return }
    if (showSearch) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1)) }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIdx((i) => Math.max(i - 1, 0)) }
      else if (e.key === "Enter") { e.preventDefault(); if (filtered[selectedIdx]) onPick(filtered[selectedIdx].path) }
    } else {
      if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIdx((i) => Math.min(i + 1, visibleTree.length - 1)) }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIdx((i) => Math.max(i - 1, 0)) }
      else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault()
        const cur = visibleTree[selectedIdx]
        if (!cur || cur.entry.type !== "dir") return
        const isOpen = expandedDirs.has(cur.entry.path)
        if (e.key === "ArrowRight" && !isOpen) toggleDir(cur.entry)
        else if (e.key === "ArrowLeft" && isOpen) toggleDir(cur.entry)
      }
      else if (e.key === "Enter") { e.preventDefault(); if (visibleTree[selectedIdx]) onPickOrToggle(visibleTree[selectedIdx].entry) }
    }
  }

  return createPortal(
    <>
      <div className="fixed inset-0 z-50 bg-black/20" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={onClose}>
        <div
          className="w-[420px] max-w-[calc(100vw-2rem)] max-h-[60vh] bg-white rounded-xl shadow-2xl border border-gray-200 flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleKeyDown}
        >
          <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 shrink-0">
            <Search className="h-4 w-4 text-gray-400 shrink-0" />
            <input
              ref={inputRef}
              autoFocus
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search files..."
              className="flex-1 text-sm outline-none text-gray-900 placeholder:text-gray-400"
            />
          </div>

          <div ref={listRef} className="flex-1 overflow-y-auto py-2" role="listbox">
            {loading ? (
              <div className="px-4 py-8 text-center text-sm text-gray-400">Loading...</div>
            ) : showSearch ? (
              filtered.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-gray-400">No files match your search</div>
              ) : (
                filtered.map((entry, i) => (
                  <button
                    key={entry.path}
                    type="button"
                    role="option"
                    aria-selected={i === selectedIdx}
                    onClick={() => onPick(entry.path)}
                    onMouseEnter={() => setSelectedIdx(i)}
                    className={cn("w-full px-6 py-1.5 text-left flex items-center gap-2 transition-colors text-[12px]", i === selectedIdx && "bg-blue-50")}
                  >
                    <FileText size={12} className="text-blue-400 shrink-0" />
                    <span className="truncate font-mono text-gray-700">{entry.path}</span>
                  </button>
                ))
              )
            ) : roots.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-400">No files found</div>
            ) : (
              visibleTree.map(({ entry, depth }, i) => {
                const isDir = entry.type === "dir"
                const isOpen = expandedDirs.has(entry.path)
                return (
                  <button
                    key={entry.path}
                    type="button"
                    role="option"
                    aria-selected={i === selectedIdx}
                    onClick={() => onPickOrToggle(entry)}
                    onMouseEnter={() => setSelectedIdx(i)}
                    className={cn("w-full text-left flex items-center gap-1.5 px-2 py-1 text-[12px] transition-colors", i === selectedIdx && "bg-blue-50")}
                    style={{ paddingLeft: 12 + depth * 16 }}
                  >
                    {isDir ? (
                      <>
                        {isOpen ? <ChevronDown size={11} className="text-gray-300 shrink-0" /> : <ChevronRight size={11} className="text-gray-300 shrink-0" />}
                        <FolderOpen size={13} className="text-amber-500 shrink-0" />
                      </>
                    ) : (
                      <>
                        <span className="w-[11px] shrink-0" />
                        <FileText size={13} className="text-blue-400 shrink-0" />
                      </>
                    )}
                    <span className="truncate">{entry.name}</span>
                  </button>
                )
              })
            )}
          </div>

          <div className="flex items-center gap-4 px-4 py-2 border-t border-gray-100 text-[10px] text-gray-400 shrink-0">
            <span className="flex items-center gap-1"><ArrowUp className="h-3 w-3" /><ArrowDown className="h-3 w-3" />navigate</span>
            <span className="flex items-center gap-1"><CornerDownLeft className="h-3 w-3" />select</span>
            <span className="flex items-center gap-1"><kbd className="px-1 py-0.5 rounded bg-gray-100 font-mono text-[9px]">esc</kbd>close</span>
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}
