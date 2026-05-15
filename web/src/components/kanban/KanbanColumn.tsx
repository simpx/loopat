import { useState } from "react"
import { useDroppable } from "@dnd-kit/core"
import { useSortable } from "@dnd-kit/sortable"
import { addKanbanCard, renameKanbanColumn, deleteKanbanColumn, setKanbanColumnColor, moveKanbanCard, type KanbanCard } from "../../api"
import { KanbanCardView } from "./KanbanCardView"

const COLORS = ["", "#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899"]

export function KanbanColumn({
  column, cards, onCardClick, onCardToggle, onCardArchive, onCardSaved, onColumnSaved, color,
}: {
  column: { id: string; label: string }
  cards: KanbanCard[]
  onCardClick: (card: KanbanCard) => void
  onCardToggle: (card: KanbanCard) => void
  onCardArchive: (card: KanbanCard) => void
  onCardSaved: () => void
  onColumnSaved: () => void
  color?: string
}) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: column.id })
  const { attributes: hAttrs, listeners: hListeners, setNodeRef: setHeaderRef, transform: colTransform, transition: colTransition, isDragging: headerDragging } =
    useSortable({ id: `col:${column.id}`, data: { columnId: column.id } })
  const colStyle = colTransform && (colTransform.x !== 0 || colTransform.y !== 0)
    ? { transform: `translate3d(${colTransform.x}px, ${colTransform.y}px, 0)`, transition: colTransition } : undefined

  const [adding, setAdding] = useState(false)
  const [newText, setNewText] = useState("")
  const [saving, setSaving] = useState(false)
  const [showEdit, setShowEdit] = useState(false)

  // column edit dialog
  const [editingCol, setEditingCol] = useState(false)
  const [colTitle, setColTitle] = useState(column.label)
  const [colColor, setColColor] = useState(color ?? "")
  const [deleting, setDeleting] = useState(false)

  async function handleAdd() {
    const text = newText.trim()
    if (!text || saving) return
    setSaving(true)
    const r = await addKanbanCard(column.id, { text })
    setSaving(false)
    if (r.cid) { setNewText(""); setAdding(false); onCardSaved() }
  }

  async function handleRename() {
    const name = colTitle.trim()
    if (!name || name === column.label) { setEditingCol(false); return }
    const newFile = name.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-|-$/g, "") + ".md"
    await renameKanbanColumn(column.id, newFile)
    setEditingCol(false); onColumnSaved()
  }

  async function handleColorChange(c: string) {
    setColColor(c)
    await setKanbanColumnColor(column.id, c)
    onColumnSaved()
  }

  async function handleDelete() {
    if (!confirm(`Delete column "${column.label}" and all its cards?`)) return
    setDeleting(true)
    // archive all cards first
    for (const card of cards) {
      await moveKanbanCard(column.id, card.cid, "archived.md")
    }
    await deleteKanbanColumn(column.id)
    setDeleting(false); setEditingCol(false); onColumnSaved()
  }

  return (
    <div ref={(node) => { setDropRef(node); setHeaderRef(node) }} {...hAttrs} style={colStyle}
      onMouseEnter={() => setShowEdit(true)} onMouseLeave={() => setShowEdit(false)}
      onTouchStart={() => setShowEdit(true)}
      className={`w-64 shrink-0 flex flex-col rounded-lg transition-colors ${isOver ? "bg-gray-100" : "bg-gray-50"}`}>

      {/* header */}
      <div className={`flex items-center gap-1.5 px-2 py-2 shrink-0 select-none rounded-t-lg ${headerDragging ? "opacity-30" : ""}`}>
        <span {...hListeners} className="text-gray-400 text-[10px] shrink-0 cursor-grab active:cursor-grabbing hover:text-gray-600">⋮⋮</span>
        <span className="text-[11px] uppercase tracking-wider text-gray-500 font-medium flex-1 min-w-0 truncate">{column.label}</span>
        <span className="text-[10px] font-mono text-gray-400 bg-gray-200 px-1.5 py-0.5 rounded-full shrink-0">{cards.length}</span>
        {showEdit && (
          <>
            <button onClick={(e) => { e.stopPropagation(); setEditingCol(true); setColTitle(column.label); setColColor(color ?? "") }}
              className="text-[10px] text-gray-400 hover:text-gray-700" title="Edit column">✎</button>
            <button onClick={(e) => { e.stopPropagation(); handleDelete() }}
              className="text-[10px] text-gray-400 hover:text-red-500" title="Delete column">×</button>
          </>
        )}
      </div>

      {/* color bar */}
      {color && <div className="h-0.5 shrink-0 mx-2 rounded" style={{ backgroundColor: color }} />}

      {/* cards */}
      <div className="flex-1 min-h-0 overflow-y-auto px-1 pb-1 flex flex-col gap-1.5">
        {cards.length === 0 && !isOver && !adding ? (
          <div className="text-[11px] text-gray-300 italic px-2 py-4 text-center">drop here</div>
        ) : (
          cards.map((card) => (
            <KanbanCardView key={card.cid} card={card} colFilename={column.id}
              onClick={() => onCardClick(card)} onToggle={() => onCardToggle(card)}
              onArchive={() => onCardArchive(card)} />
          ))
        )}
        {adding && (
          <div className="rounded-lg border border-gray-300 bg-white px-2 py-1.5">
            <input type="text" value={newText} onChange={(e) => setNewText(e.target.value)} autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAdd() }; if (e.key === "Escape") { setAdding(false); setNewText("") } }}
              onBlur={() => { if (!newText.trim()) { setAdding(false); setNewText("") } }}
              className="w-full text-[13px] border-0 outline-none bg-transparent text-gray-900 placeholder:text-gray-400" placeholder="Card title…" />
            <div className="flex items-center gap-1.5 mt-1.5">
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={handleAdd} disabled={!newText.trim() || saving}
                className="px-2 h-6 rounded text-[11px] bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40">{saving ? "…" : "Add"}</button>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { setAdding(false); setNewText("") }}
                className="text-gray-400 hover:text-gray-600 text-sm">✕</button>
            </div>
          </div>
        )}
      </div>
      {!adding && (
        <button type="button" onClick={() => setAdding(true)}
          className="mx-1 mb-1 shrink-0 rounded-lg border border-dashed border-gray-300 hover:border-gray-400 text-[11px] text-gray-400 hover:text-gray-600 py-2 transition-colors">
          + Add card
        </button>
      )}

      {/* column edit dialog */}
      {editingCol && (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center" onClick={() => setEditingCol(false)}>
          <div className="bg-white rounded-md shadow-xl border border-gray-200 w-full max-w-xs mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
              <span className="text-sm font-medium text-gray-900">Edit Column</span>
              <div className="flex-1" />
              <button onClick={() => setEditingCol(false)} className="text-gray-400 hover:text-gray-700">✕</button>
            </div>
            <div className="px-4 py-3 space-y-3">
              <label className="flex flex-col gap-1"><span className="text-[10px] text-gray-400 uppercase tracking-wider">Title</span>
                <input type="text" value={colTitle} onChange={(e) => setColTitle(e.target.value)} autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") handleRename() }}
                  className="w-full text-[13px] border border-gray-300 rounded px-2 py-1.5 outline-none focus:border-gray-500" />
              </label>
              <label className="flex flex-col gap-1"><span className="text-[10px] text-gray-400 uppercase tracking-wider">Color</span>
                <div className="flex gap-1.5">
                  {COLORS.map((c) => (
                    <button key={c} onClick={() => handleColorChange(c)}
                      className={`w-6 h-6 rounded-full border-2 ${colColor === c ? "border-gray-900" : "border-gray-200"} ${c ? "" : "bg-white"}`}
                      style={c ? { backgroundColor: c } : undefined} title={c || "none"} />
                  ))}
                </div>
              </label>
              <button onClick={handleDelete} disabled={deleting}
                className="w-full text-[12px] text-red-500 hover:text-red-700 text-left">{deleting ? "Deleting…" : "Delete column"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
