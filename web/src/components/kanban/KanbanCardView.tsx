import { useState } from "react"
import { useSortable } from "@dnd-kit/sortable"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { updateKanbanCard, type KanbanCard } from "../../api"
import { TopicChip } from "../TopicChip"
import { useNavigate } from "react-router-dom"

function InlineMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <>{children}</>,
        strong: ({ children }) => <strong className="font-bold">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            className="text-blue-700 hover:underline"
          >
            {children}
          </a>
        ),
        code: ({ children }) => (
          <code className="bg-gray-100 text-gray-800 rounded px-1 font-mono text-[11px]">{children}</code>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

function getAssignees(card: KanbanCard): string[] {
  if (!card.assignee) return []
  return card.assignee.split(/[,;，；]+/).map((s) => s.trim()).filter(Boolean)
}

const PRIO_CLASS: Record<string, string> = {
  P0: "bg-red-50 text-red-700 border-red-200",
  P1: "bg-orange-50 text-orange-700 border-orange-200",
}

export function KanbanCardStatic({ card }: { card: KanbanCard }) {
  const pct = card.subtasks.length > 0
    ? Math.round(card.subtasks.filter((s) => s.done).length / card.subtasks.length * 100)
    : 0
  const assignees = getAssignees(card)
  return (
    <div className={`text-left rounded-lg border bg-white px-3 py-2.5 w-full shadow-lg ${card.done ? "opacity-60" : "border-gray-300"}`}>
      <div className="flex items-start gap-2">
        <span className={`shrink-0 mt-0.5 w-4 h-4 rounded border border-gray-300 flex items-center justify-center text-xs ${card.done ? "bg-emerald-50 border-emerald-400" : ""}`}>{card.done ? "✓" : ""}</span>
        <h4 className={`text-[13px] font-medium flex-1 min-w-0 ${card.done ? "text-gray-400 line-through" : "text-gray-900"}`}><InlineMarkdown text={card.text} /></h4>
        {card.priority && <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 border ${PRIO_CLASS[card.priority] ?? "bg-gray-50 text-gray-600 border-gray-200"}`}>{card.priority.toUpperCase()}</span>}
      </div>
      {(assignees.length > 0 || card.due) && (
        <div className="mt-1.5 flex items-center gap-2 text-[10px]">
          {assignees.map((a, i) => <span key={i} className="w-5 h-5 rounded-full bg-gray-200 text-gray-600 text-[9px] flex items-center justify-center font-medium" title={a}>{a.slice(0, 2).toUpperCase()}</span>)}
          {card.due && <span className="text-gray-400 ml-auto">{card.due}</span>}
        </div>
      )}
      {card.topics.length > 0 && <div className="mt-1.5 flex items-center gap-1 flex-wrap">{card.topics.map((t) => <TopicChip key={t} name={t} onClick={() => {}} />)}</div>}
      {card.subtasks.length > 0 && (
        <div className="mt-2 flex items-center gap-2">
          <div className="flex-1 h-1 bg-gray-100 rounded-full overflow-hidden"><div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} /></div>
          <span className="text-[10px] font-mono text-gray-500 shrink-0">{card.subtasks.filter((s) => s.done).length}/{card.subtasks.length}</span>
        </div>
      )}
    </div>
  )
}

export function KanbanCardView({
  board, card, colFilename, onClick, onToggle, onArchive,
}: {
  board: string; card: KanbanCard; colFilename: string; onClick: () => void; onToggle: () => void; onArchive?: () => void
}) {
  const navigate = useNavigate()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.cid, data: { card, colFilename },
  })
  const hasTransform = transform && (transform.x !== 0 || transform.y !== 0)
  const style = hasTransform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, transition } : undefined

  const [editingTitle, setEditingTitle] = useState(false)
  const [titleText, setTitleText] = useState(card.text)

  async function saveTitle() {
    const t = titleText.trim()
    if (!t || t === card.text) { setEditingTitle(false); return }
    await updateKanbanCard(board, colFilename, card.cid, { text: t })
    setEditingTitle(false)
  }

  const pct = card.subtasks.length > 0
    ? Math.round(card.subtasks.filter((s) => s.done).length / card.subtasks.length * 100)
    : 0
  const assignees = getAssignees(card)

  return (
    <div className="relative group/card">
      <div ref={setNodeRef} {...listeners} {...attributes} style={style} onClick={editingTitle ? undefined : onClick}
        role="button" tabIndex={0}
        className={`text-left rounded-lg border bg-white px-3 py-2.5 transition-all w-full cursor-grab active:cursor-grabbing
          ${isDragging ? "opacity-30 shadow-lg" : "border-gray-200 hover:border-gray-400 hover:shadow-sm"} ${card.done ? "opacity-60" : ""}`}>
        <div className="flex items-start gap-2">
          <span className="shrink-0 mt-0.5 w-4 h-4 rounded border border-gray-300 flex items-center justify-center cursor-pointer hover:border-gray-500"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onToggle() }}>
            {card.done && <span className="text-emerald-600 text-xs">✓</span>}
          </span>
          {editingTitle ? (
            <input type="text" value={titleText} onChange={(e) => setTitleText(e.target.value)} autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveTitle() }; if (e.key === "Escape") { setEditingTitle(false); setTitleText(card.text) } }}
              onBlur={saveTitle}
              onPointerDown={(e) => e.stopPropagation()}
              className="flex-1 min-w-0 text-[13px] font-medium border border-gray-300 rounded px-1 py-0.5 outline-none focus:border-gray-500" />
          ) : (
            <h4 className={`text-[13px] font-medium flex-1 min-w-0 cursor-text ${card.done ? "text-gray-400 line-through" : "text-gray-900"}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); setTitleText(card.text); setEditingTitle(true) }}>
              <InlineMarkdown text={card.text} />
            </h4>
          )}
          {card.priority && <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 border ${PRIO_CLASS[card.priority] ?? "bg-gray-50 text-gray-600 border-gray-200"}`}>{card.priority.toUpperCase()}</span>}
        </div>
        {(assignees.length > 0 || card.due) && (
          <div className="mt-1.5 flex items-center gap-2 text-[10px]">
            <div className="flex items-center gap-0.5">{assignees.map((a, i) => <span key={i} className="w-5 h-5 rounded-full bg-gray-200 text-gray-600 text-[9px] flex items-center justify-center font-medium" title={a}>{a.slice(0, 2).toUpperCase()}</span>)}</div>
            {card.due && <span className="text-gray-400 ml-auto">{card.due}</span>}
          </div>
        )}
        {card.topics.length > 0 && (
          <div className="mt-1.5 flex items-center gap-1 flex-wrap" onClick={(e) => e.stopPropagation()}>
            {card.topics.map((t) => (<TopicChip key={t} name={t} onClick={() => navigate(`/topic/${encodeURIComponent(t)}`)} onEdit={onClick} />))}
          </div>
        )}
        {card.subtasks.length > 0 && (
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 h-1 bg-gray-100 rounded-full overflow-hidden"><div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} /></div>
            <span className="text-[10px] font-mono text-gray-500 shrink-0">{card.subtasks.filter((s) => s.done).length}/{card.subtasks.length}</span>
          </div>
        )}
        {card.loopId && <div className="mt-1.5"><span className="text-[10px] font-mono text-gray-400 bg-gray-100 px-1 py-0.5 rounded">L:{card.loopId.slice(0, 6)}</span></div>}
      </div>
      {/* hover buttons */}
      <button type="button" onClick={(e) => { e.stopPropagation(); onClick() }}
        className="absolute top-2 right-2 z-10 w-5 h-5 rounded-full bg-white border border-gray-300 text-[10px] text-gray-400 hover:text-gray-700 hover:border-gray-500 opacity-100 sm:opacity-0 sm:group-hover/card:opacity-100 transition-opacity flex items-center justify-center shadow-sm" title="Edit card">✎</button>
      {card.done && onArchive && (
        <button type="button" onClick={(e) => { e.stopPropagation(); onArchive() }}
          className="absolute top-2 right-9 z-10 w-5 h-5 rounded-full bg-white border border-gray-300 text-[10px] text-gray-400 hover:text-orange-600 hover:border-orange-400 opacity-100 sm:opacity-0 sm:group-hover/card:opacity-100 transition-opacity flex items-center justify-center shadow-sm" title="Archive card">◧</button>
      )}
    </div>
  )
}
