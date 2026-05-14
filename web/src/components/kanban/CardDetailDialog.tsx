import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { useWorkspace } from "../../ctx"
import {
  toggleKanbanCard,
  updateKanbanCardBlock,
  deleteKanbanCard,
  assignKanbanDriver,
  type KanbanCard,
} from "../../api"
import { TopicChip } from "../TopicChip"

type SubtaskItem = { text: string; done: boolean }

function buildCardBlock(title: string, done: boolean, priority: string, assignee: string, due: string, description: string, subtasks: SubtaskItem[], topics: string[]): string {
  const ch = done ? "x" : " "
  const topicSuffix = topics.length > 0 ? " " + topics.map((t) => `#${t}`).join(" ") : ""
  const lines = [`- [${ch}] ${title}${topicSuffix}`]
  if (priority) lines.push(`  > priority: ${priority}`)
  if (assignee) lines.push(`  > assignee: ${assignee}`)
  if (due) lines.push(`  > due: ${due}`)
  if (description) {
    for (const dl of description.split("\n")) lines.push(`  ${dl}`)
  }
  for (const st of subtasks) {
    const sc = st.done ? "x" : " "
    lines.push(`  - [${sc}] ${st.text}`)
  }
  return lines.join("\n")
}

export function CardDetailDialog({
  card, colFilename, onClose, onSaved, onDeleted,
}: {
  card: KanbanCard; colFilename: string; onClose: () => void; onSaved: () => void; onDeleted: () => void
}) {
  const ws = useWorkspace()
  const navigate = useNavigate()
  const loggedIn = !!ws.currentUser

  const [title, setTitle] = useState(card.text)
  const [done, setDone] = useState(card.done)
  const [priority, setPriority] = useState(card.priority ?? "")
  const [assignee, setAssignee] = useState(card.assignee ?? "")
  const [due, setDue] = useState(card.due ?? "")
  const [desc, setDesc] = useState(card.description)
  const [subtasks, setSubtasks] = useState<SubtaskItem[]>(card.subtasks.map((s) => ({ ...s })))
  const [topics, setTopics] = useState<string[]>(card.topics ?? [])
  const [newTopic, setNewTopic] = useState("")
  const [addingTag, setAddingTag] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [assigning, setAssigning] = useState(false)

  function toggleSub(i: number) { setSubtasks((p) => p.map((s, j) => j === i ? { ...s, done: !s.done } : s)) }
  function setSubText(i: number, t: string) { setSubtasks((p) => p.map((s, j) => j === i ? { ...s, text: t } : s)) }
  function removeSub(i: number) { setSubtasks((p) => p.filter((_, j) => j !== i)) }
  function addSub() { setSubtasks((p) => [...p, { text: "", done: false }]) }

  function addTopic() {
    const t = newTopic.trim().replace(/^#/, "")
    if (t && !topics.includes(t)) { setTopics([...topics, t]); setNewTopic("") }
  }
  function removeTopic(t: string) { setTopics(topics.filter((x) => x !== t)) }

  async function handleSave() {
    setSaving(true)
    const block = buildCardBlock(title.trim() || card.text, done, priority, assignee.trim(), due.trim(), desc.trim(), subtasks, topics)
    await updateKanbanCardBlock(colFilename, card.cid, block)
    setSaving(false)
    onSaved()
  }

  async function handleToggleDone() {
    await toggleKanbanCard(colFilename, card.cid)
    setDone((v) => !v)
  }

  async function handleDelete() {
    if (!confirm("Delete this card?")) return
    setDeleting(true)
    await deleteKanbanCard(colFilename, card.cid)
    setDeleting(false)
    onDeleted()
  }

  async function handleAssignDriver() {
    setAssigning(true)
    const r = await assignKanbanDriver(colFilename, card.cid)
    setAssigning(false)
    if (r.ok) { onSaved() }
    else { alert("No associated loop on this card") }
  }

  function handleCreateLoop() {
    onClose()
    ws.setNewLoopDialogOpen(true, card.text, { filename: colFilename, cid: card.cid })
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/30 flex items-center justify-center" onClick={onClose}>
      <div className="bg-white rounded-md shadow-xl border border-gray-200 w-full max-w-lg max-h-[90vh] overflow-y-auto mx-4" onClick={(e) => e.stopPropagation()}>

        {/* header: title + done + close */}
        <div className="flex items-start gap-2 px-4 py-3 border-b border-gray-100">
          <button type="button" onClick={handleToggleDone}
            className={`shrink-0 mt-0.5 w-4 h-4 rounded border flex items-center justify-center text-xs hover:border-gray-500 ${done ? "bg-emerald-50 border-emerald-400 text-emerald-600" : "border-gray-300"}`}>
            {done ? "✓" : ""}
          </button>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
            className={`flex-1 text-[14px] font-medium border-0 outline-none bg-transparent ${done ? "text-gray-400 line-through" : "text-gray-900"}`} />
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-sm shrink-0">✕</button>
        </div>

        <div className="px-4 py-3 space-y-3">

          {/* subtasks */}
          <div className="space-y-1.5">
            <div className="text-[10px] text-gray-400 uppercase tracking-wider">Subtasks</div>
            {subtasks.map((st, i) => (
              <div key={i} className="flex items-center gap-2">
                <button type="button" onClick={() => toggleSub(i)}
                  className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center text-[10px] hover:border-gray-500 ${st.done ? "bg-emerald-50 border-emerald-400 text-emerald-600" : "border-gray-300"}`}>
                  {st.done ? "✓" : ""}
                </button>
                <input type="text" value={st.text} onChange={(e) => setSubText(i, e.target.value)}
                  className={`flex-1 text-[12px] border border-gray-200 rounded px-1.5 py-0.5 outline-none focus:border-gray-400 ${st.done ? "text-gray-400 line-through" : "text-gray-700"}`} />
                <button type="button" onClick={() => removeSub(i)} className="text-gray-400 hover:text-red-500 text-sm shrink-0">×</button>
              </div>
            ))}
            <button type="button" onClick={addSub} className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded px-2 py-0.5 -ml-1 transition-colors">+ Add subtask</button>
          </div>

          {/* tags */}
          <div className="space-y-1.5">
            <div className="text-[10px] text-gray-400 uppercase tracking-wider">Tags</div>
            <div className="flex items-center gap-1 flex-wrap">
              {topics.map((t) => (
                <TopicChip key={t} name={t} onClick={() => navigate(`/topic/${encodeURIComponent(t)}`)} onEdit={() => removeTopic(t)} />
              ))}
              {addingTag ? (
                <span className="inline-flex items-center gap-1">
                  <input type="text" value={newTopic} onChange={(e) => setNewTopic(e.target.value)} autoFocus
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTopic(); setAddingTag(false) }; if (e.key === "Escape") { setAddingTag(false); setNewTopic("") } }}
                    onBlur={() => { setAddingTag(false); setNewTopic("") }}
                    className="w-20 text-[11px] border border-gray-300 rounded px-1.5 py-0.5 outline-none focus:border-gray-400" placeholder="tag" />
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { addTopic(); setAddingTag(false) }}
                    className="text-[11px] text-gray-500 hover:text-gray-700">Add</button>
                </span>
              ) : (
                <button type="button" onClick={() => setAddingTag(true)}
                  className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded px-2 py-0.5 transition-colors">
                  + Add tag
                </button>
              )}
            </div>
          </div>

          {/* divider */}
          <div className="border-t border-gray-100" />

          {/* form fields */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Priority">
              <select value={priority} onChange={(e) => setPriority(e.target.value)}
                className="w-full text-[12px] border border-gray-300 rounded px-2 py-1 outline-none focus:border-gray-500">
                <option value="">---</option><option value="P0">P0</option><option value="P1">P1</option><option value="P2">P2</option><option value="P3">P3</option>
              </select>
            </Field>
            <Field label="Assignee">
              <input type="text" value={assignee} onChange={(e) => setAssignee(e.target.value)}
                className="w-full text-[12px] border border-gray-300 rounded px-2 py-1 outline-none focus:border-gray-500" placeholder="alice, bob" />
            </Field>
            <Field label="Due">
              <input type="text" value={due} onChange={(e) => setDue(e.target.value)}
                className="w-full text-[12px] border border-gray-300 rounded px-2 py-1 outline-none focus:border-gray-500" placeholder="2026-05-20" />
            </Field>
          </div>
          <Field label="Description">
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3}
              className="w-full text-[12px] border border-gray-300 rounded px-2 py-1.5 outline-none focus:border-gray-500 resize-none" placeholder="Notes…" />
          </Field>

          {card.loopId && (
            <div className="text-[11px] text-gray-400">Loop: <button onClick={() => navigate(`/loop/${card.loopId}`)} className="text-blue-700 hover:underline font-mono">{card.loopId.slice(0, 8)}</button></div>
          )}
        </div>

        {/* actions */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-100">
          {loggedIn && <button type="button" disabled={assigning} onClick={handleAssignDriver} className="px-2.5 h-7 rounded text-[11px] border border-gray-200 hover:bg-gray-100 text-gray-700 disabled:opacity-50">{assigning ? "…" : "Assign Driver"}</button>}
          {loggedIn && <button type="button" onClick={handleCreateLoop} className="px-2.5 h-7 rounded text-[11px] border border-gray-200 hover:bg-gray-100 text-gray-700">Create Loop</button>}
          <div className="flex-1" />
          {loggedIn && <button type="button" disabled={saving} onClick={handleSave} className="px-3 h-7 rounded text-[11px] bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50">{saving ? "Saving…" : "Save"}</button>}
          {loggedIn && <button type="button" disabled={deleting} onClick={handleDelete} className="px-2.5 h-7 rounded text-[11px] text-red-600 hover:bg-red-50 disabled:opacity-50">{deleting ? "…" : "Delete"}</button>}
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1"><span className="text-[10px] text-gray-400 uppercase tracking-wider">{label}</span>{children}</label>
}
