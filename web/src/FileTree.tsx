/**
 * File tree for loop workdir, using the generic Tree component.
 */
import { useEffect, useState, useRef, useCallback } from "react"
import { listFiles, uploadFile, writeFile, type FileEntry } from "./api"
import { Tree, type TreeNodeData, type TreeContextAction, type TreeProps } from "./components/Tree"
import { Upload, Trash2, Eye, FilePlus, FolderPlus } from "lucide-react"

const ROOTS: { name: string; section: "context" | "workdir"; emoji: string; hint?: string }[] = [
  { name: "context", section: "context", emoji: "🧷", hint: "knowledge / notes / personal" },
  { name: "workdir", section: "workdir", emoji: "▣" },
]

export interface FileTreeHandle {
  triggerUpload: () => void
}

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
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploadTarget, setUploadTarget] = useState<string>("")
  const [creating, setCreating] = useState<{ type: "file" | "folder"; path: string } | null>(null)
  const [newName, setNewName] = useState("")

  const triggerUpload = useCallback((targetPath?: string) => {
    setUploadTarget(targetPath ?? "workdir")
    fileInputRef.current?.click()
  }, [])

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setReloadKey((k) => k + 1)
    if (fileInputRef.current) fileInputRef.current.value = ""
    setUploadTarget("")
  }

  const handleCreate = async () => {
    if (!creating || !newName.trim()) { setCreating(null); return }
    const targetPath = creating.path + "/" + newName.trim()
    if (creating.type === "file") {
      await writeFile(loopId, targetPath, "")
    } else {
      // TODO: mkdir API when available
    }
    setCreating(null)
    setNewName("")
    setReloadKey((k) => k + 1)
  }

  const handleAction = useCallback((action: string, node: TreeNodeData) => {
    if (action === "upload") {
      triggerUpload(node.path)
    } else if (action === "new-file" || action === "new-folder") {
      setCreating({ type: action === "new-file" ? "file" : "folder", path: node.path })
      setNewName("")
    } else if (action === "delete") {
      // TODO: delete API
      setReloadKey((k) => k + 1)
    }
  }, [triggerUpload])

  const getContextActions = useCallback((node: TreeNodeData): TreeContextAction[] => {
    if (node.type === "dir") {
      return [
        { label: "Upload here", icon: <Upload size={12} />, action: "upload" },
        { label: "New file", icon: <FilePlus size={12} />, action: "new-file" },
        { label: "New folder", icon: <FolderPlus size={12} />, action: "new-folder" },
        { label: "Delete", icon: <Trash2 size={12} />, action: "delete", danger: true },
      ]
    }
    return [
      { label: "View", icon: <Eye size={12} />, action: "view" },
      { label: "Delete", icon: <Trash2 size={12} />, action: "delete", danger: true },
    ]
  }, [])

  const handleLoadChildren = useCallback((path: string) => {
    return listFiles(loopId, path).then((entries) => entries as TreeNodeData[])
  }, [loopId])

  return (
    <aside className="flex-1 min-h-0 overflow-auto py-2 text-[13px]">
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleUpload}
      />
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
          onUpload={() => triggerUpload(r.name)}
          onReload={() => setReloadKey((k) => k + 1)}
          reloadKey={reloadKey}
          getContextActions={getContextActions}
          onAction={handleAction}
          treeId={`loop-${loopId}`}
        />
      ))}
      {creating && (
        <CreateInline
          depth={1}
          type={creating.type}
          value={newName}
          onChange={setNewName}
          onSubmit={handleCreate}
          onCancel={() => setCreating(null)}
        />
      )}
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
  onUpload,
  onReload,
  reloadKey,
  getContextActions,
  onAction,
  treeId,
}: {
  loopId: string
  name: string
  section: "context" | "workdir"
  emoji: string
  hint?: string
  onPick: (path: string) => void
  picked: string | null
  onUpload: () => void
  onReload: () => void
  reloadKey: number
  getContextActions: (node: TreeNodeData) => TreeContextAction[]
  onAction: (action: string, node: TreeNodeData) => void
  treeId: string
}) {
  const [open, setOpen] = useState(true)
  const sectionClass =
    section === "context"
      ? "w-full py-1.5 flex items-center gap-1.5 bg-cyan-50/50 hover:bg-cyan-50 text-left border-y border-cyan-100/70"
      : "w-full py-1.5 flex items-center gap-1.5 bg-emerald-50/40 hover:bg-emerald-50 text-left border-y border-emerald-100/70"

  const handleLoadChildren = useCallback((path: string) => {
    return listFiles(loopId, path).then((entries) => entries as TreeNodeData[])
  }, [loopId])

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
        {section === "workdir" && (
          <>
            <div className="flex-1" />
            <span
              onClick={(e) => { e.stopPropagation(); onUpload() }}
              className="text-gray-400 hover:text-gray-700 px-1 rounded hover:bg-emerald-100/50 flex items-center gap-0.5"
              title="upload file"
            >
              <Upload size={12} />
            </span>
          </>
        )}
      </button>
      {open && (
        <Tree
          treeId={`${treeId}-${name}`}
          entries={[{ name, path: name, type: "dir" }]}
          onPick={onPick}
          picked={picked}
          onLoadChildren={handleLoadChildren}
          getContextActions={getContextActions}
          onAction={onAction}
          depthOffset={1}
        />
      )}
    </>
  )
}

function CreateInline({ depth, type, value, onChange, onSubmit, onCancel }: {
  depth: number;
  type: "file" | "folder";
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus() }, [])

  return (
    <div className="flex items-center gap-1 py-0.5" style={{ paddingLeft: 8 + depth * 12 }}>
      <span className="text-gray-400">{type === "file" ? "📄" : "📁"}</span>
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit()
          if (e.key === "Escape") onCancel()
        }}
        placeholder={type === "file" ? "filename.txt" : "folder-name"}
        className="flex-1 px-1.5 py-0.5 text-[12px] border border-gray-300 rounded outline-none focus:border-gray-900"
      />
      <button onClick={onSubmit} className="text-[10px] text-emerald-600 hover:text-emerald-800 px-1">✓</button>
      <button onClick={onCancel} className="text-[10px] text-gray-400 hover:text-gray-600 px-1">✕</button>
    </div>
  )
}
