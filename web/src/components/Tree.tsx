/**
 * Generic reusable tree component with:
 * - Visual hierarchy (icons, indentation)
 * - Right-click context menu (portal-rendered)
 * - Persisted expansion state (localStorage)
 */
import { useEffect, useState, useRef, useCallback, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { Folder, FolderOpen, File, Upload, Trash2, Eye, FilePlus, FolderPlus, Plus } from "lucide-react"

const EXPANDED_PREFIX = "loopat:tree:expanded:"

function getExpanded(treeId: string): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_PREFIX + treeId)
    if (!raw) return new Set()
    return new Set(JSON.parse(raw))
  } catch {
    return new Set()
  }
}

function setExpanded(treeId: string, paths: Set<string>) {
  try {
    localStorage.setItem(EXPANDED_PREFIX + treeId, JSON.stringify([...paths]))
  } catch {}
}

export type TreeNodeData = {
  name: string
  path: string
  type: "file" | "dir"
  size?: number
}

export type TreeContextAction = {
  label: string
  icon: ReactNode
  action: string
  danger?: boolean
  hidden?: boolean
}

export type TreeProps = {
  /** Unique ID for persisting expansion state */
  treeId: string
  /** Root entries to render */
  entries: TreeNodeData[]
  /** Called when a file is picked */
  onPick: (path: string) => void
  /** Currently picked file path */
  picked: string | null
  /** Called to load children of a directory */
  onLoadChildren: (path: string) => Promise<TreeNodeData[]>
  /** Returns context menu items for a node */
  getContextActions: (node: TreeNodeData) => TreeContextAction[]
  /** Called when a context action is triggered */
  onAction: (action: string, node: TreeNodeData) => void
  /** Depth offset (default 0) */
  depthOffset?: number
  /** Custom node renderer (optional) */
  renderNode?: (node: TreeNodeData, depth: number, isOpen: boolean, toggleOpen: () => void) => ReactNode
}

export function Tree({
  treeId,
  entries,
  onPick,
  picked,
  onLoadChildren,
  getContextActions,
  onAction,
  depthOffset = 0,
  renderNode,
}: TreeProps) {
  return (
    <>
      {entries.map((e) => (
        <TreeNode
          key={e.path}
          treeId={treeId}
          entry={e}
          depth={depthOffset}
          onPick={onPick}
          picked={picked}
          onLoadChildren={onLoadChildren}
          getContextActions={getContextActions}
          onAction={onAction}
          renderNode={renderNode}
        />
      ))}
    </>
  )
}

function TreeNode({
  treeId,
  entry,
  depth,
  onPick,
  picked,
  onLoadChildren,
  getContextActions,
  onAction,
  renderNode,
}: {
  treeId: string
  entry: TreeNodeData
  depth: number
  onPick: (path: string) => void
  picked: string | null
  onLoadChildren: (path: string) => Promise<TreeNodeData[]>
  getContextActions: (node: TreeNodeData) => TreeContextAction[]
  onAction: (action: string, node: TreeNodeData) => void
  renderNode?: (node: TreeNodeData, depth: number, isOpen: boolean, toggleOpen: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<TreeNodeData[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const expanded = getExpanded(treeId)
    setOpen(expanded.has(entry.path))
  }, [treeId, entry.path])

  const toggleOpen = useCallback(() => {
    const expanded = getExpanded(treeId)
    if (expanded.has(entry.path)) expanded.delete(entry.path)
    else expanded.add(entry.path)
    setExpanded(treeId, expanded)
    setOpen((o) => !o)
  }, [treeId, entry.path])

  useEffect(() => {
    if (!open || children !== null) return
    setLoading(true)
    onLoadChildren(entry.path)
      .then(setChildren)
      .finally(() => setLoading(false))
  }, [open, entry.path, onLoadChildren, children])

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setMenuPos({ x: e.clientX, y: e.clientY })
  }

  const paddingLeft = 8 + depth * 12

  if (entry.type === "dir") {
    if (renderNode) {
      return (
        <>
          <div onContextMenu={handleContextMenu}>
            {renderNode(entry, depth, open, toggleOpen)}
          </div>
          {open && children && (
            <>
              {children.map((child) => (
                <TreeNode
                  key={child.path}
                  treeId={treeId}
                  entry={child}
                  depth={depth + 1}
                  onPick={onPick}
                  picked={picked}
                  onLoadChildren={onLoadChildren}
                  getContextActions={getContextActions}
                  onAction={onAction}
                  renderNode={renderNode}
                />
              ))}
            </>
          )}
          {menuPos && (
            <ContextMenu
              x={menuPos.x}
              y={menuPos.y}
              items={getContextActions(entry).filter((a) => !a.hidden)}
              onAction={(action) => onAction(action, entry)}
              onClose={() => setMenuPos(null)}
            />
          )}
        </>
      )
    }

    return (
      <>
        <div onContextMenu={handleContextMenu}>
          <button
            type="button"
            onClick={toggleOpen}
            className="w-full py-1 flex items-center gap-1.5 hover:bg-gray-50 text-left group"
            style={{ paddingLeft, paddingRight: 8 }}
          >
            <span className="text-gray-500 w-3">{open ? "▾" : "▸"}</span>
            <span className="text-gray-500">{open ? <FolderOpen size={13} /> : <Folder size={13} />}</span>
            <span className="text-[13px] text-gray-900 truncate">{entry.name}</span>
          </button>
        </div>
        {loading && (
          <div className="text-[12px] text-gray-400 italic" style={{ paddingLeft: paddingLeft + 12 }}>
            ...
          </div>
        )}
        {open && children && (
          <>
            {children.map((child) => (
              <TreeNode
                key={child.path}
                treeId={treeId}
                entry={child}
                depth={depth + 1}
                onPick={onPick}
                picked={picked}
                onLoadChildren={onLoadChildren}
                getContextActions={getContextActions}
                onAction={onAction}
                renderNode={renderNode}
              />
            ))}
            {children.length === 0 && (
              <div className="text-[12px] text-gray-400 italic py-1" style={{ paddingLeft: paddingLeft + 12 }}>
                (empty)
              </div>
            )}
          </>
        )}
        {menuPos && (
          <ContextMenu
            x={menuPos.x}
            y={menuPos.y}
            items={getContextActions(entry).filter((a) => !a.hidden)}
            onAction={(action) => onAction(action, entry)}
            onClose={() => setMenuPos(null)}
          />
        )}
      </>
    )
  }

  const isPicked = picked === entry.path

  if (renderNode) {
    return (
      <>
        <div
          onContextMenu={handleContextMenu}
          onClick={() => onPick(entry.path)}
        >
          {renderNode(entry, depth, false, () => {})}
        </div>
        {menuPos && (
          <ContextMenu
            x={menuPos.x}
            y={menuPos.y}
            items={getContextActions(entry).filter((a) => !a.hidden)}
            onAction={(action) => onAction(action, entry)}
            onClose={() => setMenuPos(null)}
          />
        )}
      </>
    )
  }

  return (
    <>
      <div
        className="relative"
        onContextMenu={handleContextMenu}
      >
        <button
          type="button"
          onClick={() => onPick(entry.path)}
          className={
            "w-full py-1 flex items-center gap-2 text-left " +
            (isPicked ? "bg-gray-100" : "hover:bg-gray-50")
          }
          style={{ paddingLeft, paddingRight: 8 }}
        >
          <span className="w-3 text-gray-400"><File size={13} /></span>
          <span className="text-[13px] text-gray-900 flex-1 min-w-0 truncate">{entry.name}</span>
        </button>
        {menuPos && (
          <ContextMenu
            x={menuPos.x}
            y={menuPos.y}
            items={getContextActions(entry).filter((a) => !a.hidden)}
            onAction={(action) => onAction(action, entry)}
            onClose={() => setMenuPos(null)}
          />
        )}
      </div>
    </>
  )
}

function ContextMenu({ x, y, items, onAction, onClose }: {
  x: number; y: number;
  items: { label: string; icon: ReactNode; action: string; danger?: boolean }[];
  onAction: (action: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      e.preventDefault()
      onClose()
    }
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", handler)
    document.addEventListener("keydown", keyHandler)
    return () => {
      document.removeEventListener("mousedown", handler)
      document.removeEventListener("keydown", keyHandler)
    }
  }, [onClose])

  return createPortal(
    <div
      className="fixed z-[9999] bg-white border border-gray-200 rounded-lg shadow-lg py-1 text-[12px] min-w-[140px]"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.action}
          onClick={() => onAction(item.action)}
          className={
            "w-full px-3 py-1.5 flex items-center gap-2 text-left hover:bg-gray-50 " +
            (item.danger ? "text-red-600 hover:bg-red-50" : "text-gray-700")
          }
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  )
}
