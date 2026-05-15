import { useState, useCallback, useRef, useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { KanbanBoard } from "../components/kanban/KanbanBoard"
import { CardDetailDialog } from "../components/kanban/CardDetailDialog"
import { moveKanbanCard, createKanbanColumn, type KanbanCard } from "../api"

type UndoState = { cid: string; card: KanbanCard; fromFile: string; toFile: string } | null
const ARCHIVE_FILE = "archived.md"

export function KanbanPage() {
  const navigate = useNavigate()
  const [selected, setSelected] = useState<{ card: KanbanCard; filename: string } | null>(null)
  const [undo, setUndo] = useState<UndoState>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), [])

  function clearUndo() { setUndo(null); if (undoTimer.current) clearTimeout(undoTimer.current) }
  function setUndoWithTimeout(s: UndoState) { clearUndo(); setUndo(s); undoTimer.current = setTimeout(clearUndo, 10000) }
  useEffect(() => { return () => { if (undoTimer.current) clearTimeout(undoTimer.current) } }, [])

  async function handleArchive(card: KanbanCard, colFilename: string) {
    // ensure archived column exists
    await createKanbanColumn("archived")
    const ok = await moveKanbanCard(colFilename, card.cid, ARCHIVE_FILE)
    if (ok) { setUndoWithTimeout({ cid: card.cid, card, fromFile: colFilename, toFile: ARCHIVE_FILE }); refresh() }
  }

  async function handleUndo() {
    if (!undo) return
    await moveKanbanCard(undo.toFile, undo.cid, undo.fromFile)
    clearUndo(); refresh()
  }

  return (
    <div className="flex flex-col h-full w-full bg-white">
      <header className="h-10 shrink-0 flex items-center gap-3 px-3 sm:px-6 border-b border-gray-200">
        <span className="text-[13px] text-gray-700 tracking-tight">kanban · notes/todo/</span>
        <div className="flex-1" />
        <button onClick={() => setShowArchived((v) => !v)}
          className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${showArchived ? "border-gray-400 bg-gray-200 text-gray-700" : "border-gray-200 text-gray-500 hover:text-gray-700"}`}>
          {showArchived ? "Hide archived" : "Archived"}
        </button>
        <button onClick={() => navigate("/context/notes")}
          className="text-[11px] text-gray-500 hover:text-gray-900" title="edit files in notes/todo/">
          <code className="text-gray-700">notes/todo/</code>
          <span> ↗</span>
        </button>
      </header>

      <main className="flex-1 min-h-0 overflow-hidden relative" key={refreshKey}>
        <KanbanBoard onCardClick={(card, filename) => setSelected({ card, filename })}
          onCardArchive={handleArchive} showArchived={showArchived} />
      </main>

      {selected && (
        <CardDetailDialog card={selected.card} colFilename={selected.filename}
          onClose={() => setSelected(null)} onSaved={refresh}
          onDeleted={() => { setSelected(null); refresh() }} />
      )}

      {undo && (
        <div className="fixed bottom-4 left-4 z-50 bg-white border border-gray-300 rounded-lg shadow-lg px-4 py-2.5 flex items-center gap-3">
          <span className="text-[12px] text-gray-600">Card archived</span>
          <button onClick={handleUndo} className="text-[12px] text-blue-600 hover:text-blue-800 font-medium">Undo</button>
          <button onClick={clearUndo} className="text-gray-400 hover:text-gray-600 text-sm">✕</button>
        </div>
      )}
    </div>
  )
}
