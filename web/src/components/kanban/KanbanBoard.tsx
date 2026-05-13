import { useEffect, useState, useCallback } from "react"
import {
  DndContext,
  DragOverlay,
  closestCorners,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { SortableContext, arrayMove, verticalListSortingStrategy, horizontalListSortingStrategy } from "@dnd-kit/sortable"
import { listKanbanColumns, getKanbanConfig, saveKanbanColumnOrder, toggleKanbanCard, moveKanbanCard, reorderKanbanCards, createKanbanColumn, type KanbanCard, type KanbanColumn } from "../../api"
import { KanbanColumn as KanbanColumnView } from "./KanbanColumn"
import { KanbanCardStatic } from "./KanbanCardView"

export function KanbanBoard({
  onCardClick,
  onCardArchive,
  showArchived,
}: {
  onCardClick: (card: KanbanCard, filename: string) => void
  onCardArchive: (card: KanbanCard, colFilename: string) => void
  showArchived: boolean
}) {
  const [columns, setColumns] = useState<KanbanColumn[]>([])
  const [orderedFiles, setOrderedFiles] = useState<string[]>([])
  const [colConfig, setColConfig] = useState<{ file: string; color?: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [activeCard, setActiveCard] = useState<KanbanCard | null>(null)
  const [activeColumn, setActiveColumn] = useState<KanbanColumn | null>(null)
  const [newColOpen, setNewColOpen] = useState(false)
  const [newColName, setNewColName] = useState("")

  const refresh = useCallback(() => {
    Promise.all([listKanbanColumns(), getKanbanConfig()]).then(([cols, cfg]) => {
      // sort: config order first, then remaining columns
      const sorted = [...cols].sort((a, b) => {
        const ai = cfg.findIndex((c) => c.file === a.filename)
        const bi = cfg.findIndex((c) => c.file === b.filename)
        if (ai >= 0 && bi >= 0) return ai - bi
        if (ai >= 0) return -1
        if (bi >= 0) return 1
        return a.title.localeCompare(b.title)
      })
      setColumns(sorted)
      setOrderedFiles(sorted.map((c) => c.filename))
      setColConfig(cfg)
      setLoading(false)
    })
  }, [])

  useEffect(() => { refresh() }, [refresh])

  function findCard(cid: string): [string, number] | null {
    for (const col of columns) {
      const idx = col.cards.findIndex((c) => c.cid === cid)
      if (idx >= 0) return [col.filename, idx]
    }
    return null
  }

  function handleDragStart(event: DragStartEvent) {
    const cid = event.active.id as string
    if (cid.startsWith("col:")) {
      const col = columns.find((c) => c.filename === cid.slice(4))
      if (col) setActiveColumn(col)
    } else {
      const card = event.active.data.current?.card as KanbanCard | undefined
      if (card) setActiveCard(card)
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveCard(null)
    setActiveColumn(null)
    const { active, over } = event
    if (!over) return

    const activeId = active.id as string

    // ── column reorder ──
    if (activeId.startsWith("col:")) {
      const fromFile = activeId.slice(4)
      let toFile = (over.id as string).startsWith("col:") ? (over.id as string).slice(4) : null
      if (!toFile) {
        // check if dropped on a column droppable
        if (columns.some((c) => c.filename === over.id)) toFile = over.id as string
      }
      if (!toFile || fromFile === toFile) return

      const oldIdx = orderedFiles.indexOf(fromFile)
      const newIdx = orderedFiles.indexOf(toFile)
      if (oldIdx < 0 || newIdx < 0) return

      const newOrder = arrayMove([...orderedFiles], oldIdx, newIdx)
      setOrderedFiles(newOrder)

      // re-sort columns
      setColumns((prev) => {
        const copy = [...prev]
        copy.sort((a, b) => {
          const ai = newOrder.indexOf(a.filename)
          const bi = newOrder.indexOf(b.filename)
          if (ai >= 0 && bi >= 0) return ai - bi
          if (ai >= 0) return -1
          if (bi >= 0) return 1
          return 0
        })
        return copy
      })
      saveKanbanColumnOrder(newOrder)
      return
    }

    // ── card drag ──
    const cid = activeId
    const from = findCard(cid)
    if (!from) return
    const [fromFile, srcIdx] = from

    let toFile: string | null = null
    let toIndex: number | undefined

    if (columns.some((c) => c.filename === over.id) || (over.id as string).startsWith("col:")) {
      toFile = (over.id as string).startsWith("col:") ? (over.id as string).slice(4) : over.id as string
    } else {
      const target = findCard(over.id as string)
      if (target) { toFile = target[0]; toIndex = target[1] }
    }
    if (!toFile) return

    setColumns((prev) => {
      const next = prev.map((col) => ({ ...col, cards: [...col.cards] }))
      const srcCol = next.find((c) => c.filename === fromFile)!
      const dstCol = next.find((c) => c.filename === toFile)!
      const si = srcCol.cards.findIndex((c) => c.cid === cid)
      if (si < 0) return next
      if (fromFile === toFile) {
        const ti = toIndex ?? dstCol.cards.length - 1
        if (si !== ti) dstCol.cards = arrayMove(dstCol.cards, si, ti)
      } else {
        const [moved] = srcCol.cards.splice(si, 1)
        if (toIndex !== undefined) dstCol.cards.splice(toIndex, 0, moved)
        else dstCol.cards.push(moved)
      }
      return next
    })

    if (fromFile !== toFile) {
      moveKanbanCard(fromFile, cid, toFile, toIndex)
    } else if (fromFile === toFile && toIndex !== undefined && srcIdx !== toIndex) {
      const col = columns.find((c) => c.filename === fromFile)
      if (col) {
        const cards = [...col.cards]
        const [moved] = cards.splice(srcIdx, 1)
        const ti = toIndex > srcIdx ? toIndex - 1 : toIndex
        cards.splice(ti, 0, moved)
        reorderKanbanCards(fromFile, cards.map((c) => c.cid))
      }
    }
  }

  function handleToggle(colFilename: string, card: KanbanCard) {
    const next = !card.done
    setColumns((prev) => prev.map((col) =>
      col.filename === colFilename
        ? { ...col, cards: col.cards.map((c) => (c.cid === card.cid ? { ...c, done: next } : c)) }
        : col
    ))
    toggleKanbanCard(colFilename, card.cid)
  }

  async function handleCreateColumn() {
    const name = newColName.trim()
    if (!name) return
    const ok = await createKanbanColumn(name)
    if (ok) { setNewColOpen(false); setNewColName(""); refresh() }
  }

  // Filter out archived.md unless showArchived is toggled
  const visibleColumns = columns.filter((c) => showArchived || c.filename !== "archived.md")
  const hasArchived = columns.some((c) => c.filename === "archived.md")

  if (loading) return <div className="flex items-center justify-center h-full"><div className="text-[12px] text-gray-400 italic">loading…</div></div>

  const totalCards = columns.reduce((s, c) => s + c.cards.length, 0)
  if (totalCards === 0 && columns.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3 text-gray-500">
          <div className="text-[13px]">no kanban columns in notes/todo/</div>
          <button onClick={() => setNewColOpen(true)} className="px-3 h-8 rounded text-sm bg-gray-900 text-white hover:bg-gray-700">+ Create first column</button>
        </div>
      </div>
    )
  }

  return (
    <DndContext collisionDetection={closestCorners} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <SortableContext items={visibleColumns.map((c) => `col:${c.filename}`)} strategy={horizontalListSortingStrategy}>
        <div className="h-full flex gap-3 px-4 py-3 overflow-x-auto">
          {visibleColumns.map((col) => {
            const cfg = colConfig.find((c) => c.file === col.filename)
            return (
            <SortableContext key={col.filename} items={col.cards.map((c) => c.cid)} strategy={verticalListSortingStrategy}>
              <KanbanColumnView
                column={{ id: col.filename, label: col.title }}
                cards={col.cards}
                onCardClick={(card) => onCardClick(card, col.filename)}
                onCardToggle={(card) => handleToggle(col.filename, card)}
                onCardArchive={(card) => onCardArchive(card, col.filename)}
                onCardSaved={refresh}
                onColumnSaved={refresh}
                color={cfg?.color}
              />
            </SortableContext>
          );})}
          {newColOpen ? (
            <div className="w-56 shrink-0 bg-gray-50 rounded-lg p-3 space-y-2 h-fit">
              <input type="text" value={newColName} onChange={(e) => setNewColName(e.target.value)} autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") handleCreateColumn() }}
                className="w-full text-[13px] border border-gray-300 rounded px-2 py-1.5 outline-none focus:border-gray-500" placeholder="Column name" />
              <div className="flex items-center gap-1.5">
                <button onClick={handleCreateColumn} disabled={!newColName.trim()} className="px-2.5 h-7 rounded text-[11px] bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40">Create</button>
                <button onClick={() => { setNewColOpen(false); setNewColName("") }} className="px-2.5 h-7 rounded text-[11px] text-gray-500 hover:bg-gray-200">✕</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setNewColOpen(true)} className="w-56 shrink-0 h-fit rounded-lg border border-dashed border-gray-300 bg-gray-50 hover:bg-gray-100 py-3 text-[12px] text-gray-400">+ New Column</button>
          )}
        </div>
      </SortableContext>
      <DragOverlay>
        {activeCard ? (
          <div className="rotate-2 w-64"><KanbanCardStatic card={activeCard} /></div>
        ) : activeColumn ? (
          <div className="w-64 shrink-0 flex flex-col rounded-lg bg-gray-50 shadow-xl opacity-90 min-h-[120px]">
            <div className="flex items-center gap-2 px-2 py-2">
              <span className="text-gray-400 text-[10px] shrink-0">⋮⋮</span>
              <span className="text-[11px] uppercase tracking-wider text-gray-500 font-medium">{activeColumn.title}</span>
              <span className="text-[10px] font-mono text-gray-400 bg-gray-200 px-1.5 py-0.5 rounded-full">{activeColumn.cards.length}</span>
            </div>
            <div className="flex-1 px-1 pb-1 flex flex-col gap-1.5">
              {activeColumn.cards.length === 0 ? (
                <div className="text-[11px] text-gray-300 italic px-2 py-4 text-center">drop here</div>
              ) : (
                activeColumn.cards.map((card) => (
                  <KanbanCardStatic key={card.cid} card={card} />
                ))
              )}
            </div>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
