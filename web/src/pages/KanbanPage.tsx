import { useState, useCallback, useRef, useEffect } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { KanbanBoard, type KanbanBoardHandle } from "../components/kanban/KanbanBoard"
import { CardDetailDialog } from "../components/kanban/CardDetailDialog"
import { moveKanbanCard, createKanbanColumn, listBoards, createBoard, renameBoard, saveNotes, notesBehind, refreshNotes, type KanbanCard } from "../api"

type UndoState = { cid: string; card: KanbanCard; fromFile: string; toFile: string } | null
const ARCHIVE_FILE = "archived.md"

export function KanbanPage() {
  const { board = "default" } = useParams<{ board: string }>()
  const navigate = useNavigate()
  const [selected, setSelected] = useState<{ card: KanbanCard; filename: string } | null>(null)
  const [undo, setUndo] = useState<UndoState>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [boards, setBoards] = useState<string[]>([])
  const [showNewBoard, setShowNewBoard] = useState(false)
  const [newBoardName, setNewBoardName] = useState("")
  const [renamingBoard, setRenamingBoard] = useState("")
  const [renameValue, setRenameValue] = useState("")
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const boardRef = useRef<KanbanBoardHandle>(null)

  const refresh = useCallback(() => boardRef.current?.refresh(), [])

  // notes/kanban share the user's notes worktree. Poll how far behind origin we
  // are every 5s (a hint), pull on Refresh, push on Save.
  const [behind, setBehind] = useState(0)
  const [syncing, setSyncing] = useState(false)
  useEffect(() => {
    const tick = () => notesBehind().then(setBehind).catch(() => {})
    tick()
    const id = setInterval(tick, 5000)
    return () => clearInterval(id)
  }, [])
  const doRefresh = useCallback(async () => {
    setSyncing(true)
    await refreshNotes().catch(() => {})
    setSyncing(false)
    setBehind(0)
    boardRef.current?.refresh()
  }, [])
  const doSave = useCallback(async () => {
    setSyncing(true)
    const r = await saveNotes()
    setSyncing(false)
    if (!r.ok) {
      if (r.conflict) alert(`保存了本地，但和远端冲突 (${(r.files ?? []).join(", ")})。本地保留——去 Notes 里 take remote 或手动解决。`)
      else alert(`推送到远端失败：${r.error ?? "unknown"}`)
    }
  }, [])

  useEffect(() => {
    listBoards().then(setBoards)
  }, [board])

  function clearUndo() { setUndo(null); if (undoTimer.current) clearTimeout(undoTimer.current) }
  function setUndoWithTimeout(s: UndoState) { clearUndo(); setUndo(s); undoTimer.current = setTimeout(clearUndo, 10000) }
  useEffect(() => { return () => { if (undoTimer.current) clearTimeout(undoTimer.current) } }, [])

  async function handleArchive(card: KanbanCard, colFilename: string) {
    // ensure archived column exists
    await createKanbanColumn(board, "archived")
    const ok = await moveKanbanCard(board, colFilename, card.cid, ARCHIVE_FILE)
    if (ok) { setUndoWithTimeout({ cid: card.cid, card, fromFile: colFilename, toFile: ARCHIVE_FILE }); refresh() }
  }

  async function handleUndo() {
    if (!undo) return
    await moveKanbanCard(board, undo.toFile, undo.cid, undo.fromFile)
    clearUndo(); refresh()
  }

  async function handleCreateBoard() {
    const name = newBoardName.trim()
    if (!name) return
    const ok = await createBoard(name)
    if (ok) {
      setShowNewBoard(false)
      setNewBoardName("")
      setBoards(await listBoards())
      navigate(`/kanban/${encodeURIComponent(name)}`)
    }
  }

  async function handleRename(oldName: string) {
    const name = renameValue.trim()
    if (!name || name === oldName) { setRenamingBoard(""); return }
    const ok = await renameBoard(oldName, name)
    if (ok) {
      setRenamingBoard("")
      setRenameValue("")
      const updated = await listBoards()
      setBoards(updated)
      navigate(`/kanban/${encodeURIComponent(name)}`)
    }
  }

  return (
    <div className="flex flex-col h-full w-full bg-white">
      {/* Board tabs */}
      <div className="h-9 shrink-0 flex items-center gap-1 px-3 border-b border-gray-200 overflow-x-auto">
        {boards.map((b) => (
          <div key={b} className="relative group">
            <button
              onClick={() => navigate(`/kanban/${encodeURIComponent(b)}`)}
              className={`shrink-0 h-7 px-3 rounded text-[12px] transition-colors whitespace-nowrap ${
                b === board
                  ? "bg-gray-900 text-white"
                  : "text-gray-500 hover:text-gray-900 hover:bg-gray-100"
              }`}
            >
              {b}
            </button>
            {b === board && (
              <button
                onClick={(e) => { e.stopPropagation(); setRenamingBoard(b); setRenameValue(b) }}
                className="absolute -top-0.5 -right-1 w-4 h-4 rounded-full bg-white border border-gray-300 text-[9px] text-gray-400 hover:text-gray-700 hidden group-hover:flex items-center justify-center shadow-sm"
                title="Rename board"
              >✎</button>
            )}
          </div>
        ))}
        {showNewBoard ? (
          <span className="inline-flex items-center gap-1 ml-1 shrink-0">
            <input
              type="text"
              value={newBoardName}
              onChange={(e) => setNewBoardName(e.target.value)}
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) handleCreateBoard(); if (e.key === "Escape") { setShowNewBoard(false); setNewBoardName("") } }}
              onBlur={() => { if (!newBoardName.trim()) { setShowNewBoard(false); setNewBoardName("") } }}
              className="w-24 h-7 px-2 text-[12px] border border-gray-300 rounded outline-none focus:border-gray-500"
              placeholder="board name"
            />
          </span>
        ) : (
          <button
            onClick={() => setShowNewBoard(true)}
            className="shrink-0 h-7 px-2 rounded text-[12px] text-gray-400 hover:text-gray-600 hover:bg-gray-100 ml-1"
            title="New board"
          >+</button>
        )}
        <div className="flex-1" />
        <button onClick={doSave} disabled={syncing}
          className="shrink-0 text-[11px] px-2 py-0.5 rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50 transition-colors"
          title="保存并推送到远端">
          {syncing ? "…" : "保存"}
        </button>
        {behind > 0 && (
          <span className="shrink-0 text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800" title="远端有更新，点 ↻ 拉取">
            远端 +{behind}
          </span>
        )}
        <button onClick={doRefresh} disabled={syncing}
          className="shrink-0 text-[11px] px-2 py-0.5 rounded border border-gray-200 text-gray-500 hover:text-gray-700 transition-colors disabled:opacity-50"
          title="拉取远端最新并刷新">
          ↻
        </button>
        <button onClick={() => setShowArchived((v) => !v)}
          className={`text-[11px] px-2 py-0.5 rounded border transition-colors shrink-0 ${showArchived ? "border-gray-400 bg-gray-200 text-gray-700" : "border-gray-200 text-gray-500 hover:text-gray-700"}`}>
          {showArchived ? "Hide archived" : "Archived"}
        </button>
        <button
          onClick={() => navigate(`/context/notes?file=focus/boards/${encodeURIComponent(board)}`)}
          className="shrink-0 text-[11px] text-gray-500 hover:text-gray-900 ml-2"
          title="edit files in notes/focus/"
        >
          <code className="text-gray-700">notes/focus/boards/{board}/</code>
          <span> ↗</span>
        </button>
      </div>

      {/* Rename board dialog */}
      {renamingBoard && (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center" onClick={() => setRenamingBoard("")}>
          <div className="bg-white rounded-md shadow-xl border border-gray-200 w-full max-w-xs mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-gray-100">
              <span className="text-sm font-medium text-gray-900">Rename board</span>
            </div>
            <div className="px-4 py-3 space-y-3">
              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) handleRename(renamingBoard); if (e.key === "Escape") setRenamingBoard("") }}
                className="w-full text-[13px] border border-gray-300 rounded px-2 py-1.5 outline-none focus:border-gray-500"
              />
              <div className="flex items-center gap-2">
                <button onClick={() => handleRename(renamingBoard)} disabled={!renameValue.trim()}
                  className="px-2.5 h-7 rounded text-[11px] bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40">Rename</button>
                <button onClick={() => setRenamingBoard("")}
                  className="px-2.5 h-7 rounded text-[11px] text-gray-500 hover:bg-gray-200">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      <main className="flex-1 min-h-0 overflow-hidden relative" key={board}>
        <KanbanBoard
          ref={boardRef}
          board={board}
          onCardClick={(card, filename) => setSelected({ card, filename })}
          onCardArchive={handleArchive}
          showArchived={showArchived}
        />
      </main>

      {selected && (
        <CardDetailDialog
          board={board}
          card={selected.card}
          colFilename={selected.filename}
          onClose={() => setSelected(null)}
          onSaved={refresh}
          onDeleted={() => { setSelected(null); refresh() }}
        />
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
