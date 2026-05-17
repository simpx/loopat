/**
 * Context tab. Layout/visuals + behavior ported from
 * phase1-prototype/src/pages/context.tsx (VaultPane + DocView).
 *   - sub-nav: Knowledge / Notes / Personal / Repos (Agents skipped)
 *   - VaultPane: tree (left) + DocView (right)
 *   - DocView read mode: markdown + wikilinks + Backlinks panel (right w-64)
 *   - DocView edit mode: split source (CodeMirror) + live preview
 *   - Header buttons: distill (notes), edit by loop (non-secret), edit (non-knowledge)
 *   - Save → auto-commit (server side)
 */
import { NavLink, useParams, useNavigate, useSearchParams } from "react-router-dom"
import {
  vaultList,
  vaultFlatList,
  vaultRead,
  vaultWrite,
  vaultCreateFile,
  vaultCreateFolder,
  vaultDeleteFile,
  vaultBacklinks,
  listRepos,
  getRepo,
  pullRepo,
  addRepo,
  listSandboxes,
  readSandbox,
  writeSandbox,
  deleteSandbox,
  type VaultEntry,
  type VaultId,
  type RepoEntry,
  type RepoDetail,
  type Backlink,
  type SandboxEntry,
  type SandboxFile,
} from "../api"
import { useEffect, useState, useCallback, useRef, type FormEvent } from "react"
import { useWorkspace } from "../ctx"
import { useIsMobile } from "../lib/useIsMobile"
import { lazy, Suspense } from "react"
const CodeEditor = lazy(() => import("../components/markdown/CodeEditor").then(m => ({ default: m.CodeEditor })))
const Markdown = lazy(() => import("../components/markdown/Markdown").then(m => ({ default: m.Markdown })))
import { PanelLeftClose, PanelLeftOpen, Trash2, File, Eye, FilePlus, FolderPlus, Upload, RefreshCw } from "lucide-react"
import { Tree, type TreeNodeData, type TreeContextAction } from "../components/Tree"

type SubId = VaultId | "sandboxes"

const SUBS: { id: SubId; label: string }[] = [
  { id: "knowledge", label: "Knowledge" },
  { id: "notes", label: "Notes" },
  { id: "personal", label: "Personal" },
  { id: "repos", label: "Repos" },
  { id: "sandboxes", label: "Sandboxes" },
]

const VALID = new Set<SubId>(["knowledge", "notes", "personal", "repos", "sandboxes"])

export function ContextPage() {
  const { sub } = useParams<{ sub: string }>()
  const [searchParams] = useSearchParams()
  const active = (VALID.has(sub as SubId) ? sub : "knowledge") as SubId
  const initialFile = searchParams.get("file") || undefined

  return (
    <div className="flex flex-col h-full w-full">
      <nav className="flex items-center gap-1 px-3 h-9 shrink-0 border-b border-gray-200 bg-white">
        {SUBS.map((s) => (
          <NavLink
            key={s.id}
            to={`/context/${s.id}`}
            className={({ isActive }) =>
              isActive
                ? "h-7 px-2.5 rounded flex items-center gap-1.5 text-xs bg-gray-100 text-gray-900"
                : "h-7 px-2.5 rounded flex items-center gap-1.5 text-xs text-gray-500 hover:bg-gray-50 hover:text-gray-900"
            }
          >
            <span>{s.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="flex-1 min-h-0 min-w-0">
        {active === "repos" ? <ReposPane />
          : active === "sandboxes" ? <SandboxesPane />
          : <VaultPane key={active} vault={active as VaultId} initialFile={initialFile} />}
      </div>
    </div>
  )
}

// ============================================================================
// VaultPane: left tree + right DocView
// ============================================================================

const VAULT_TAGLINE: Record<VaultId, string> = {
  knowledge: "workspace's distilled materials",
  notes: "workspace · public",
  personal: "yours · private",
  repos: "registered code repos",
}

function VaultPane({ vault, initialFile }: { vault: VaultId; initialFile?: string }) {
  const [tree, setTree] = useState<VaultEntry[]>([])
  const [flat, setFlat] = useState<VaultEntry[]>([])
  const [pickedPath, setPickedPath] = useState<string | null>(initialFile ?? null)
  const [reloadKey, setReloadKey] = useState(0)
  const [showNewFile, setShowNewFile] = useState(false)
  const [query, setQuery] = useState("")
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [creating, setCreating] = useState<{ type: "file" | "folder"; path: string } | null>(null)
  const [newName, setNewName] = useState("")
  const isMobile = useIsMobile()

  // initialize expansion and file selection from ?file= query param
  const initRef = useRef(false)
  if (!initRef.current && initialFile) {
    initRef.current = true
    const treeId = `vault-${vault}`
    const parentDir = initialFile.includes("/") ? initialFile.substring(0, initialFile.lastIndexOf("/")) : ""
    if (parentDir) {
      try {
        const key = "loopat:tree:expanded:" + treeId
        const raw = localStorage.getItem(key)
        const expanded: string[] = raw ? JSON.parse(raw) : []
        for (let p = parentDir; p; p = p.includes("/") ? p.substring(0, p.lastIndexOf("/")) : "") {
          if (!expanded.includes(p)) expanded.push(p)
        }
        localStorage.setItem(key, JSON.stringify(expanded))
      } catch {}
    }
  }

  useEffect(() => {
    vaultList(vault).then((entries) => {
      setTree(entries)
      setPickedPath((prev) => {
        if (prev) return prev
        const first = entries.find((e) => e.type === "file" && e.path.endsWith(".md"))
        return first ? first.path : null
      })
    })
    vaultFlatList(vault).then(setFlat)
    setQuery("")
  }, [vault, reloadKey])

  const onCreate = async (path: string) => {
    const r = await vaultCreateFile(vault, path)
    if (r.ok) {
      setShowNewFile(false)
      setReloadKey((k) => k + 1)
      setPickedPath(path)
    } else {
      alert(`failed: ${r.error}`)
    }
  }

  const handleCreate = async () => {
    if (!creating || !newName.trim()) { setCreating(null); return }
    const targetPath = creating.path + "/" + newName.trim()
    if (creating.type === "file") {
      const r = await vaultCreateFile(vault, targetPath)
      if (!r.ok) { alert(`create failed: ${r.error}`); return }
    } else {
      const r = await vaultCreateFolder(vault, targetPath)
      if (!r.ok) { alert(`create failed: ${r.error}`); return }
    }
    setCreating(null)
    setNewName("")
    setReloadKey((k) => k + 1)
  }

  const handleAction = useCallback((action: string, node: TreeNodeData) => {
    if (action === "view") {
      setPickedPath(node.path)
    } else if (action === "new-file" || action === "new-folder") {
      setCreating({ type: action === "new-file" ? "file" : "folder", path: node.path })
      setNewName("")
    } else if (action === "delete") {
      if (!confirm(`Delete "${node.name}"?`)) return
      vaultDeleteFile(vault, node.path).then((r) => {
        if (r.ok) {
          setPickedPath((p) => p === node.path ? null : p)
          setReloadKey((k) => k + 1)
        } else {
          alert(`delete failed: ${r.error}`)
        }
      })
    }
  }, [vault])

  const getContextActions = useCallback((node: TreeNodeData): TreeContextAction[] => {
    if (isSecretsFolder(vault, node.path)) return []
    if (node.type === "dir") {
      return [
        { label: "New file", icon: <FilePlus size={12} />, action: "new-file" },
        { label: "New folder", icon: <FolderPlus size={12} />, action: "new-folder" },
        { label: "Delete", icon: <Trash2 size={12} />, action: "delete", danger: true },
      ]
    }
    if (isSecretFile(vault, node.path)) {
      return []
    }
    return [
      { label: "View", icon: <Eye size={12} />, action: "view" },
      { label: "Delete", icon: <Trash2 size={12} />, action: "delete", danger: true },
    ]
  }, [vault])

  const handleLoadChildren = useCallback((path: string) => {
    return vaultList(vault, path).then((entries) => entries as TreeNodeData[])
  }, [vault])

  const getNodeClassName = useCallback((node: TreeNodeData, depth: number, isOpen: boolean, isPicked: boolean): string => {
    if (node.type === "dir") {
      const secretsFolder = isSecretsFolder(vault, node.path)
      if (secretsFolder) {
        return "w-full py-1.5 flex items-center gap-1.5 bg-amber-50/40 hover:bg-amber-50 text-left border-y border-amber-200/60 mt-1"
      }
      return "w-full py-1 flex items-center gap-1 hover:bg-gray-50 text-left"
    }
    const secret = isSecretFile(vault, node.path)
    return (
      "w-full py-1 flex items-center gap-2 text-left " +
      (isPicked ? "bg-gray-100" : secret ? "hover:bg-amber-50/50" : "hover:bg-gray-50")
    )
  }, [vault])

  const q = query.trim().toLowerCase()
  const searching = q.length > 0
  const matches = searching
    ? flat
        .filter((e) => e.path.toLowerCase().includes(q))
        .slice(0, 60)
    : []

  const sidebar = (
    <aside className="w-64 shrink-0 border-r border-gray-200 bg-white flex flex-col h-full">
      <div className="px-3 h-9 flex items-center gap-1 border-b border-gray-200">
        {isMobile && (
          <button
            onClick={() => setSidebarOpen(false)}
            className="text-gray-500 hover:text-gray-900 px-1 rounded hover:bg-gray-100 mr-1"
            title="close sidebar"
          >
            <PanelLeftClose size={14} />
          </button>
        )}
        <SearchIcon />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search files…"
          className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-gray-700 placeholder:text-gray-400"
        />
        <button
          onClick={() => setShowNewFile(true)}
          className="text-gray-500 hover:text-gray-900 px-1.5 rounded hover:bg-gray-100 text-xs"
          title="new file"
        >
          +
        </button>
        <button
          onClick={() => setReloadKey((k) => k + 1)}
          className="text-gray-500 hover:text-gray-900 px-1.5 rounded hover:bg-gray-100 text-xs"
          title="refresh"
        >
          ↻
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto py-2">
        {searching ? (
          matches.length === 0 ? (
            <div className="px-3 py-4 text-[12px] text-gray-400 italic">no matches</div>
          ) : (
            matches.map((e) => (
              <button
                key={e.path}
                type="button"
                onClick={() => {
                  setPickedPath(e.path)
                  if (isMobile) setSidebarOpen(false)
                }}
                className={
                  "w-full px-3 py-1.5 flex items-center gap-2 text-left " +
                  (pickedPath === e.path ? "bg-gray-100" : "hover:bg-gray-50")
                }
                title={e.path}
              >
                <span className="text-gray-500">📄</span>
                <span className="flex-1 min-w-0 truncate text-[13px] text-gray-900">{e.path}</span>
              </button>
            ))
          )
        ) : (
          <>
            <Tree
              treeId={`vault-${vault}`}
              entries={tree as TreeNodeData[]}
              onPick={(path) => {
                setPickedPath(path)
                if (isMobile) setSidebarOpen(false)
              }}
              picked={pickedPath}
              onLoadChildren={handleLoadChildren}
              getContextActions={getContextActions}
              onAction={handleAction}
              nodeClassName={getNodeClassName}
              reloadKey={reloadKey}
            />
            {tree.length === 0 && (
              <div className="px-3 py-4 text-[12px] text-gray-400 italic">
                empty · click + 创建第一个文件
              </div>
            )}
          </>
        )}
      </div>
      <div className="px-3 h-9 border-t border-gray-200 flex items-center text-[11px] text-gray-500">
        {VAULT_TAGLINE[vault]}
      </div>
    </aside>
  )

  return (
    <div className="flex h-full w-full">
      {isMobile ? (
        <>
          {sidebarOpen ? (
            <div className="fixed inset-0 z-30" onClick={() => setSidebarOpen(false)}>
              <div className="absolute inset-0 bg-black/30" />
              <div className="absolute left-0 top-0 bottom-0 w-64 max-w-[80vw] shadow-xl" onClick={(e) => e.stopPropagation()}>
                {sidebar}
              </div>
            </div>
          ) : (
            <aside className="w-9 shrink-0 border-r border-gray-200 bg-white flex flex-col items-center pt-2">
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="w-7 h-7 flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded"
                title="open file tree"
              >
                <PanelLeftOpen size={16} />
              </button>
            </aside>
          )}
        </>
      ) : (
        sidebar
      )}
      <main className="flex-1 min-w-0 flex flex-col bg-white min-h-0">
        {pickedPath ? (
          <DocView
            vault={vault}
            path={pickedPath}
            onSelect={setPickedPath}
            onSaved={() => setReloadKey((k) => k + 1)}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-[13px] text-gray-400 italic">
            选一个文件，或点 + 新建
          </div>
        )}
      </main>
      {showNewFile && <NewFileDialog vault={vault} onClose={() => setShowNewFile(false)} onCreate={onCreate} />}
      {creating && (
        <CreateItemDialog
          type={creating.type}
          parentPath={creating.path}
          value={newName}
          onChange={setNewName}
          onSubmit={handleCreate}
          onCancel={() => setCreating(null)}
        />
      )}
    </div>
  )
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" className="text-gray-400 shrink-0">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        d="M11 11l3 3M7 12.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z"
      />
    </svg>
  )
}

/**
 * Anything under `.loopat/vaults/<vaultName>/...` is secret-bearing.
 *
 * "secrets folder" = the vault root and any directory inside it (gets the
 * amber "encrypted" treatment in the tree).
 * "secret file" = any file inside a vault (Context page redacts on read,
 * lets the user overwrite blind on edit).
 */
function isSecretsFolder(vault: VaultId, path: string): boolean {
  if (vault !== "personal") return false
  if (!path.startsWith(".loopat/vaults/")) return false
  const rest = path.slice(".loopat/vaults/".length)
  return rest.length > 0
}
function isSecretFile(vault: VaultId, path: string): boolean {
  if (vault !== "personal") return false
  if (!path.startsWith(".loopat/vaults/")) return false
  const rest = path.slice(".loopat/vaults/".length)
  return rest.includes("/")
}

function CreateItemDialog({ type, parentPath, value, onChange, onSubmit, onCancel }: {
  type: "file" | "folder";
  parentPath: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const label = type === "file" ? "New file" : "New folder"
  const placeholder = type === "file" ? "filename.md" : "folder-name"
  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center" onClick={onCancel}>
      <div
        className="w-full max-w-[420px] mx-4 bg-white rounded-md shadow-xl border border-gray-200 p-4 md:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold text-gray-900 mb-3">{label} in <span className="font-mono text-[13px]">{parentPath || "root"}</span></div>
        <input
          autoFocus
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit()
            if (e.key === "Escape") onCancel()
          }}
          placeholder={placeholder}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded outline-none focus:border-gray-500 font-mono"
        />
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onCancel} className="px-3 h-8 text-sm rounded text-gray-700 hover:bg-gray-100">
            cancel
          </button>
          <button
            onClick={() => value.trim() && onSubmit()}
            disabled={!value.trim()}
            className="px-3 h-8 text-sm rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
          >
            create
          </button>
        </div>
      </div>
    </div>
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
        placeholder={type === "file" ? "filename.md" : "folder-name"}
        className="flex-1 px-1.5 py-0.5 text-[12px] border border-gray-300 rounded outline-none focus:border-gray-900"
      />
      <button onClick={onSubmit} className="text-[10px] text-emerald-600 hover:text-emerald-800 px-1">✓</button>
      <button onClick={onCancel} className="text-[10px] text-gray-400 hover:text-gray-600 px-1">✕</button>
    </div>
  )
}

// ============================================================================
// DocView: header (3 action buttons) + read mode (markdown + backlinks) +
// edit mode (split source / preview).  Mirrors phase-1.
// ============================================================================

function isSecretPath(path: string): boolean {
  // convention: anything under a `secrets/` segment is a secret
  return /(^|\/)secrets\//.test(path) || path === "secrets"
}

function DocView({
  vault,
  path,
  onSelect,
  onSaved,
}: {
  vault: VaultId
  path: string
  onSelect: (path: string) => void
  onSaved: () => void
}) {
  const ws = useWorkspace()
  const navigate = useNavigate()
  const [original, setOriginal] = useState("")
  const [draft, setDraft] = useState("")
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [backlinks, setBacklinks] = useState<Backlink[]>([])
  const [lastCommit, setLastCommit] = useState<string | null>(null)
  const [showBacklinks, setShowBacklinks] = useState(false)
  // Server flags secret files; the response never carries plaintext, so
  // `original` stays empty and the only way to mutate is to type a new value.
  const [secretFromServer, setSecretFromServer] = useState(false)
  const isMobile = useIsMobile()

  useEffect(() => {
    setEditing(false)
    setLastCommit(null)
    setSecretFromServer(false)
    vaultRead(vault, path).then((r) => {
      const c = r?.content ?? ""
      setOriginal(c)
      setDraft(c)
      setSecretFromServer(!!r?.secret)
    })
    vaultBacklinks(vault, path).then(setBacklinks)
  }, [vault, path])

  const isSecret = isSecretPath(path) || secretFromServer
  const isMd = path.endsWith(".md")
  const allowDirectEdit = vault !== "knowledge"
  const allowLoopEdit = !isSecret
  const allowDistill = vault === "notes" && !isSecret

  // For secrets, the editor opens empty and a non-empty draft is always
  // considered "dirty" (a replacement). For non-secrets, the diff between
  // draft and the loaded original drives dirty state.
  const dirty = isSecret ? draft.length > 0 : draft !== original

  const save = useCallback(async () => {
    if (!dirty || saving) return
    setSaving(true)
    try {
      const r = await vaultWrite(vault, path, draft)
      if (r.ok) {
        // For secrets, throw the just-typed value away from React state
        // immediately after the write returns ok — otherwise re-entering
        // edit would surface it. The server never reads it back to us.
        if (isSecret) {
          setOriginal("")
          setDraft("")
        } else {
          setOriginal(draft)
        }
        setLastCommit(r.commit ?? null)
        setEditing(false)
        onSaved()
        // refresh backlinks (links may have changed)
        vaultBacklinks(vault, path).then(setBacklinks)
      } else {
        alert(`save failed: ${r.error}`)
      }
    } finally {
      setSaving(false)
    }
  }, [vault, path, draft, dirty, saving, onSaved, isSecret])

  const startEdit = () => setEditing(true)

  const cancelEdit = () => {
    setDraft(original)
    setEditing(false)
  }

  const startEditByLoop = async () => {
    const m = await ws.createLoop({ title: `edit ${vault}/${path}` })
    navigate(`/loop/${m.id}`)
  }

  const startDistill = async () => {
    const m = await ws.createLoop({ title: `distill ${path} → knowledge` })
    navigate(`/loop/${m.id}`)
  }

  // wikilink target → file path: try `<target>.md` in same dir as current path,
  // then `<target>.md` from vault root, then `<target>` literal
  const onWikilink = (target: string) => {
    const candidates = [
      path.replace(/[^/]+$/, "") + target + ".md",
      target + ".md",
      target,
    ]
    // try first candidate (we don't have a file-existence check here; just navigate
    // and let read return null if missing — empty content for now)
    onSelect(candidates[0].replace(/^\//, ""))
  }

  return (
    <>
      <header className="px-3 md:px-5 h-10 shrink-0 border-b border-gray-200 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[13px] min-w-0">
          <span className="text-gray-500 shrink-0">{isSecret ? "🔒" : "📄"}</span>
          <span className="font-mono text-[12px] text-gray-500 truncate">{path}</span>
          {lastCommit && !dirty && !editing && (
            <span className="hidden md:inline text-[10px] text-emerald-700 font-mono">commit {lastCommit}</span>
          )}
        </div>
        <div className="flex items-center gap-1 md:gap-2 text-xs text-gray-500">
          {editing ? (
            <>
              <button
                onClick={cancelEdit}
                className="px-2.5 h-7 rounded text-xs text-gray-600 hover:bg-gray-100"
              >
                cancel
              </button>
              <button
                onClick={save}
                disabled={!dirty || saving}
                className="px-2.5 h-7 rounded text-xs bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
              >
                {saving ? "saving…" : "save"}
              </button>
            </>
          ) : (
            <>
              {allowDistill && (
                <button
                  onClick={startDistill}
                  className="px-2.5 h-7 rounded text-xs bg-amber-100 text-amber-900 hover:bg-amber-200 flex items-center gap-1"
                  title="open a loop to distill this notes file into knowledge"
                >
                  <span>↑</span>
                  <span>distill</span>
                </button>
              )}
              {allowLoopEdit && (
                <button
                  onClick={startEditByLoop}
                  className={
                    allowDistill
                      ? "px-2.5 h-7 rounded text-xs border border-gray-200 hover:bg-gray-100 text-gray-900 flex items-center gap-1"
                      : "px-2.5 h-7 rounded text-xs bg-gray-900 text-white hover:bg-gray-700 flex items-center gap-1"
                  }
                  title="open a new loop with AI assist for this file"
                >
                  <span>↻</span>
                  <span>edit by loop</span>
                </button>
              )}
              {allowDirectEdit && (
                <button
                  onClick={startEdit}
                  className="px-2.5 h-7 rounded text-xs border border-gray-200 hover:bg-gray-100 text-gray-900"
                  title="direct edit (fastpath)"
                >
                  edit
                </button>
              )}
              {isMobile && isMd && (
                <button
                  onClick={() => setShowBacklinks((v) => !v)}
                  className={`px-2.5 h-7 rounded text-xs border ${showBacklinks ? "bg-gray-900 text-white" : "border-gray-200 hover:bg-gray-100 text-gray-900"}`}
                  title="toggle backlinks"
                >
                  ⇄ {backlinks.length}
                </button>
              )}
            </>
          )}
        </div>
      </header>

      {editing ? (
        isSecret ? (
          // edit mode for a secret: single full-width editor starting empty;
          // save sends the typed value as a full replacement.
          <div className="flex-1 min-h-0 min-w-0 flex flex-col">
            <div className="px-3 h-7 shrink-0 border-b border-gray-200 flex items-center gap-2 text-[11px] text-gray-500">
              <span className="text-amber-700">🔒</span>
              <span>new value · saved encrypted (whatever's currently stored will be replaced)</span>
            </div>
            <div className="flex-1 min-h-0">
              <Suspense fallback={<div className="flex-1 flex items-center justify-center text-gray-400 text-sm">Loading editor...</div>}>
                <CodeEditor path={path} value={draft} onChange={setDraft} />
              </Suspense>
            </div>
          </div>
        ) : isMd ? (
          // edit mode for markdown: split source / preview
          <div className="flex-1 min-h-0 min-w-0 flex flex-col md:flex-row">
            <div className="flex-1 min-w-0 min-h-0 border-r border-gray-200 flex flex-col">
              <div className="px-3 h-7 shrink-0 border-b border-gray-200 flex items-center text-[11px] text-gray-500">
                source · markdown
              </div>
              <div className="flex-1 min-h-0">
                <Suspense fallback={<div className="flex-1 flex items-center justify-center text-gray-400 text-sm">Loading editor...</div>}><CodeEditor path={path} value={draft} onChange={setDraft} /></Suspense>
              </div>
            </div>
            <div className="flex-1 min-w-0 min-h-0 flex flex-col">
              <div className="px-3 h-7 shrink-0 border-b border-gray-200 flex items-center text-[11px] text-gray-500">
                preview
              </div>
              <div className="flex-1 min-h-0 overflow-auto px-6 py-4">
                <div className="max-w-[760px]">
                  <Suspense fallback={<div className="text-gray-400 text-sm">Loading preview...</div>}><Markdown text={draft} onWikilink={onWikilink} /></Suspense>
                </div>
              </div>
            </div>
          </div>
        ) : (
          // edit mode for non-markdown: full-width editor
          <div className="flex-1 min-h-0 min-w-0 flex flex-col">
            <div className="px-3 h-7 shrink-0 border-b border-gray-200 flex items-center gap-2 text-[11px] text-gray-500">
              <span>source · {path.includes(".") ? path.split(".").pop() : "text"}</span>
              {path.endsWith(".json") && (
                <button
                  type="button"
                  onClick={() => {
                    try {
                      const formatted = JSON.stringify(JSON.parse(draft), null, 2)
                      setDraft(formatted)
                    } catch (e: any) {
                      alert("Invalid JSON: " + (e?.message ?? "parse error"))
                    }
                  }}
                  className="ml-auto px-2 h-5 rounded text-[10px] bg-gray-100 hover:bg-gray-200 text-gray-600"
                  title="Format JSON"
                >
                  format
                </button>
              )}
            </div>
            <div className="flex-1 min-h-0">
              <Suspense fallback={<div className="flex-1 flex items-center justify-center text-gray-400 text-sm">Loading editor...</div>}><CodeEditor path={path} value={draft} onChange={setDraft} /></Suspense>
            </div>
          </div>
        )
      ) : (
        // read mode: article + backlinks
        <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
          <article className="flex-1 min-h-0 overflow-auto px-4 md:px-8 py-4 md:py-6">
            <div className="max-w-[760px]">
              {isSecret ? (
                <div className="font-sans text-[13px] text-gray-600 leading-relaxed">
                  <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-amber-50 border border-amber-200 text-amber-800 text-[12px] font-medium">
                    encrypted · value hidden by design
                  </div>
                  <div className="mt-3 text-[12px] text-gray-500">
                    Click <b>edit</b> to overwrite. The current value is never
                    returned by the server, so editing means typing a new
                    replacement — there is no decrypt-and-view.
                  </div>
                </div>
              ) : isMd ? (
                <Suspense fallback={<div className="text-gray-400 text-sm">Loading...</div>}><Markdown text={original} onWikilink={onWikilink} /></Suspense>
              ) : (
                <pre className="font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-gray-900">
                  {original || <span className="text-gray-400 italic">(empty)</span>}
                </pre>
              )}
            </div>
          </article>
          {isMd && !isMobile && (
            <aside className="w-64 shrink-0 border-l border-gray-200 bg-gray-50 overflow-auto">
              <div className="px-3 h-9 flex items-center border-b border-gray-200">
                <span className="text-[11px] text-gray-500">Backlinks</span>
                <span className="ml-auto text-[11px] text-gray-500">{backlinks.length}</span>
              </div>
              {backlinks.length === 0 ? (
                <div className="px-3 py-4 text-xs text-gray-500">No documents link here yet.</div>
              ) : (
                <ul className="py-2">
                  {backlinks.map((b) => (
                    <li key={b.path}>
                      <button
                        type="button"
                        onClick={() => onSelect(b.path)}
                        className="w-full px-3 py-2 text-left hover:bg-gray-100"
                      >
                        <div className="text-xs font-medium text-gray-900 truncate">{b.path}</div>
                        <div className="text-[11px] text-gray-500 mt-0.5 leading-snug line-clamp-2">{b.preview}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          )}
          {isMobile && isMd && showBacklinks && (
            <div className="fixed inset-0 z-30" onClick={() => setShowBacklinks(false)}>
              <div className="absolute inset-0 bg-black/30" />
              <div className="absolute right-0 top-0 bottom-0 w-64 max-w-[80vw] bg-gray-50 border-l border-gray-200 shadow-xl overflow-auto" onClick={(e) => e.stopPropagation()}>
                <div className="px-3 h-9 flex items-center border-b border-gray-200">
                  <span className="text-[11px] text-gray-500">Backlinks</span>
                  <span className="ml-auto text-[11px] text-gray-500">{backlinks.length}</span>
                  <button
                    onClick={() => setShowBacklinks(false)}
                    className="ml-2 text-gray-400 hover:text-gray-700 px-1"
                    title="close backlinks"
                  >
                    ✕
                  </button>
                </div>
                {backlinks.length === 0 ? (
                  <div className="px-3 py-4 text-xs text-gray-500">No documents link here yet.</div>
                ) : (
                  <ul className="py-2">
                    {backlinks.map((b) => (
                      <li key={b.path}>
                        <button
                          type="button"
                          onClick={() => {
                            onSelect(b.path)
                            setShowBacklinks(false)
                          }}
                          className="w-full px-3 py-2 text-left hover:bg-gray-100"
                        >
                          <div className="text-xs font-medium text-gray-900 truncate">{b.path}</div>
                          <div className="text-[11px] text-gray-500 mt-0.5 leading-snug line-clamp-2">{b.preview}</div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  )
}

function NewFileDialog({
  vault,
  onClose,
  onCreate,
}: {
  vault: VaultId
  onClose: () => void
  onCreate: (path: string) => void
}) {
  const [path, setPath] = useState("")
  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center" onClick={onClose}>
      <div
        className="w-full max-w-[420px] mx-4 bg-white rounded-md shadow-xl border border-gray-200 p-4 md:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold text-gray-900 mb-3">new file in {vault}/</div>
        <input
          autoFocus
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="loopat/new-doc.md"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded outline-none focus:border-gray-500 font-mono"
        />
        <div className="text-[11px] text-gray-400 mt-1">relative path. directories created as needed.</div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-3 h-8 text-sm rounded text-gray-700 hover:bg-gray-100">
            cancel
          </button>
          <button
            onClick={() => path.trim() && onCreate(path.trim())}
            disabled={!path.trim()}
            className="px-3 h-8 text-sm rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
          >
            create
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// ReposPane: list of registered code repos
// ============================================================================

function ReposPane() {
  const ws = useWorkspace()
  const navigate = useNavigate()
  const [repos, setRepos] = useState<RepoEntry[]>([])
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [detail, setDetail] = useState<RepoDetail | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const isMobile = useIsMobile()

  const refreshList = useCallback(async () => {
    const rs = await listRepos()
    setRepos(rs)
    return rs
  }, [])

  useEffect(() => {
    refreshList().then((rs) => {
      if (rs.length > 0 && !selectedName) setSelectedName(rs[0].name)
    })
  }, [refreshList])

  useEffect(() => {
    if (!selectedName) return
    getRepo(selectedName).then(setDetail)
  }, [selectedName, reloadKey])

  const onSpawnLoop = async () => {
    if (!selectedName) return
    const m = await ws.createLoop({ title: `${selectedName} loop`, repo: selectedName })
    navigate(`/loop/${m.id}`)
  }

  const repoList = (
    <aside className="w-64 shrink-0 border-r border-gray-200 bg-white flex flex-col h-full">
      <div className="px-3 h-9 flex items-center justify-between border-b border-gray-200">
        {isMobile ? (
          <button
            onClick={() => setSidebarOpen(false)}
            className="text-gray-500 hover:text-gray-900 px-1 rounded hover:bg-gray-100"
            title="close repos"
          >
            <PanelLeftClose size={14} />
          </button>
        ) : (
          <span className="text-[11px] uppercase tracking-wide text-gray-500 font-medium">repos</span>
        )}
        <span className="text-[11px] text-gray-400 ml-auto">{repos.length}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto py-2">
        {repos.map((r) => {
          const sel = selectedName === r.name
          return (
            <button
              key={r.name}
              type="button"
              onClick={() => {
                setSelectedName(r.name)
                if (isMobile) setSidebarOpen(false)
              }}
              className={
                sel
                  ? "w-full px-3 py-2 flex items-center gap-2 text-left bg-gray-100"
                  : "w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-gray-50"
              }
            >
              <span className="w-2 h-2 rounded-full shrink-0 bg-emerald-500" />
              <span className="text-[13px] text-gray-900 flex-1 min-w-0 truncate">{r.name}</span>
            </button>
          )
        })}
        {repos.length === 0 && (
          <div className="px-3 py-4 text-[12px] text-gray-400 italic">
            none yet · click "add repo" below
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => setShowAdd(true)}
        className="m-3 px-2 py-1.5 rounded border border-gray-200 text-xs text-gray-700 hover:bg-gray-50 flex items-center gap-2"
        title="clone a remote URL or symlink a local directory"
      >
        <span>+</span>
        <span>add repo</span>
      </button>
    </aside>
  )

  return (
    <div className="flex h-full w-full">
      {isMobile ? (
        <>
          {sidebarOpen ? (
            <div className="fixed inset-0 z-30" onClick={() => setSidebarOpen(false)}>
              <div className="absolute inset-0 bg-black/30" />
              <div className="absolute left-0 top-0 bottom-0 w-64 max-w-[80vw] shadow-xl" onClick={(e) => e.stopPropagation()}>
                {repoList}
              </div>
            </div>
          ) : (
            <aside className="w-9 shrink-0 border-r border-gray-200 bg-white flex flex-col items-center pt-2">
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="w-7 h-7 flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded"
                title="open repos list"
              >
                <PanelLeftOpen size={16} />
              </button>
            </aside>
          )}
        </>
      ) : (
        repoList
      )}
      <main className="flex-1 min-w-0 flex flex-col bg-white min-h-0">
        {detail ? (
          <RepoView
            key={detail.name}
            repo={detail}
            onSpawnLoop={onSpawnLoop}
            onPulled={() => setReloadKey((k) => k + 1)}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-[13px] text-gray-400 italic">
            select a repo
          </div>
        )}
      </main>
      {showAdd && (
        <AddRepoDialog
          existingNames={repos.map((r) => r.name)}
          onClose={() => setShowAdd(false)}
          onAdded={async (name) => {
            setShowAdd(false)
            await refreshList()
            setSelectedName(name)
          }}
        />
      )}
    </div>
  )
}

const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

function deriveRepoName(source: string): string {
  let s = source.trim().replace(/[?#].*$/, "")
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "")
  const m = s.match(/[/:]([^/:]+)$/)
  return (m ? m[1] : s).trim()
}

function AddRepoDialog({
  existingNames,
  onClose,
  onAdded,
}: {
  existingNames: string[]
  onClose: () => void
  onAdded: (name: string) => void
}) {
  const [source, setSource] = useState("")
  const [name, setName] = useState("")
  const [nameTouched, setNameTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const derived = deriveRepoName(source)
  const effectiveName = nameTouched ? name : derived
  const isUrl = /:\/\//.test(source.trim()) || /^git@/.test(source.trim())

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const finalName = effectiveName.trim()
    if (!source.trim()) { setErr("source required"); return }
    if (!REPO_NAME_RE.test(finalName)) {
      setErr("invalid name (letters/digits/_.-, max 64, must start with alnum)")
      return
    }
    if (existingNames.includes(finalName)) {
      setErr("name already exists")
      return
    }
    setErr(null)
    setBusy(true)
    const r = await addRepo({ name: finalName, source: source.trim() })
    setBusy(false)
    if (!r.ok) { setErr(r.error ?? "add failed"); return }
    onAdded(finalName)
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center" onClick={onClose}>
      <div
        className="w-full max-w-[480px] mx-4 bg-white rounded-md shadow-xl border border-gray-200 p-4 md:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold text-gray-900 mb-4">Add repo</div>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-700 font-medium">Source</span>
            <input
              autoFocus
              type="text"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="git@github.com:user/repo.git  or  ~/code/myrepo"
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded outline-none focus:border-gray-500 font-mono"
            />
            <span className="text-[11px] text-gray-400">
              {source.trim() === "" ? "git URL (clone) or local path (symlink)" : isUrl ? "→ git clone into context/repos/" : "→ symlink into context/repos/"}
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-700 font-medium">Name</span>
            <input
              type="text"
              value={effectiveName}
              onChange={(e) => { setName(e.target.value); setNameTouched(true) }}
              placeholder="repo-name"
              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded outline-none focus:border-gray-500 font-mono"
            />
            <span className="text-[11px] text-gray-400">directory name under context/repos/</span>
          </label>
          {err && <div className="text-[11px] text-red-600 break-words">{err}</div>}
          <div className="flex justify-end gap-2 mt-2 pt-3 border-t border-gray-100">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="px-3 h-8 text-sm rounded text-gray-700 hover:bg-gray-100 disabled:opacity-50"
            >
              cancel
            </button>
            <button
              type="submit"
              disabled={busy || !source.trim() || !effectiveName.trim()}
              className="px-3 h-8 text-sm rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {busy ? "adding…" : "add"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function RepoView({ repo, onSpawnLoop, onPulled }: { repo: RepoDetail; onSpawnLoop: () => void; onPulled: () => void }) {
  const navigate = useNavigate()
  const [pulling, setPulling] = useState(false)
  const [pullMsg, setPullMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const onPull = async () => {
    if (pulling) return
    setPulling(true)
    setPullMsg(null)
    const r = await pullRepo(repo.name)
    setPulling(false)
    if (r.ok) {
      setPullMsg({ ok: true, text: r.output?.split("\n").pop() || "up to date" })
      onPulled()
    } else {
      setPullMsg({ ok: false, text: r.error ?? "pull failed" })
    }
  }

  return (
    <>
      <header className="px-5 h-10 shrink-0 border-b border-gray-200 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[13px] min-w-0">
          <span
            className={
              repo.status === "online"
                ? "w-2 h-2 rounded-full bg-emerald-500 shrink-0"
                : "w-2 h-2 rounded-full bg-gray-300 shrink-0"
            }
          />
          <span className="text-gray-900 font-medium truncate">{repo.name}</span>
          {repo.remote && <span className="text-gray-500 truncate">· {repo.remote}</span>}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {pullMsg && (
            <span className={"text-[11px] truncate max-w-[260px] " + (pullMsg.ok ? "text-emerald-700" : "text-red-600")} title={pullMsg.text}>
              {pullMsg.text}
            </span>
          )}
          <span className="text-xs text-gray-500">default branch: {repo.branch ?? "—"}</span>
          <button
            onClick={onPull}
            disabled={pulling || repo.status !== "online"}
            className="px-2.5 h-7 rounded text-xs border border-gray-200 hover:bg-gray-100 text-gray-900 flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
            title="git pull --ff-only from origin"
          >
            <RefreshCw size={12} className={pulling ? "animate-spin" : ""} />
            <span>{pulling ? "syncing…" : "sync"}</span>
          </button>
        </div>
      </header>
      <article className="flex-1 min-h-0 overflow-auto px-4 md:px-8 py-4 md:py-6">
        <div className="max-w-[820px]">
          <section className="mb-6">
            <h3 className="text-[13px] font-medium text-gray-900 mb-2">Recent loops on this repo</h3>
            {repo.recentLoops.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {repo.recentLoops.map((loop) => (
                  <li key={loop.id}>
                    <button
                      onClick={() => navigate(`/loop/${loop.id}`)}
                      className="w-full px-3 py-2 rounded hover:bg-gray-100 flex items-center gap-3 text-[13px] text-left"
                    >
                      <span className="text-gray-500">⑂</span>
                      <span className="text-gray-900">{loop.title}</span>
                      <span className="text-gray-500 font-mono text-[11px]">{loop.branch ?? "main"}</span>
                      <span className="text-gray-500 ml-auto text-[11px]">
                        {new Date(loop.createdAt).toLocaleString()}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-gray-500">No active loops yet.</p>
            )}
            <button
              onClick={onSpawnLoop}
              className="mt-3 px-3 py-1.5 rounded bg-gray-900 text-white text-xs hover:bg-gray-700 flex items-center gap-2"
            >
              <span>+</span>
              <span>spawn new loop on a branch</span>
            </button>
          </section>
          <section>
            <h3 className="text-[13px] font-medium text-gray-900 mb-2">README</h3>
            <div className="max-w-[760px]">
              {repo.readme ? (
                <Suspense fallback={<div className="text-gray-400 text-sm">Loading...</div>}><Markdown text={repo.readme} /></Suspense>
              ) : (
                <p className="text-[13px] text-gray-500 italic">No README found at repo root.</p>
              )}
            </div>
          </section>
        </div>
      </article>
    </>
  )
}

// ============================================================================
// SandboxesPane: list of sandboxes (mise.toml + sandbox.json) with simple editor
// ============================================================================

const SANDBOX_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

const SANDBOX_FILES: SandboxFile[] = ["mise.toml", "sandbox.json"]

// Seeded into new sandboxes. Picks a small useful set so terminals work out of
// the box; users can edit / delete any line they don't want.
const NEW_SANDBOX_MISE_TOML = `# mise.toml — runtime toolchain for this sandbox. Docs: https://mise.jdx.dev
[tools]
# Use \`ubi:owner/repo\` for any GitHub release; bare names hit mise's registry.
"ubi:fish-shell/fish-shell" = { version = "latest", exe = "fish" }
bun = "latest"
uv = "latest"
gh = "latest"
jq = "latest"
`

// sandbox.json — loopat-side metadata. `shell` decides which binary the terminal
// PTY runs (resolved against sandbox PATH; the mise tools above provide fish).
const NEW_SANDBOX_META_JSON = `{
  "shell": "fish"
}
`

function SandboxesPane() {
  const [sandboxes, setSandboxes] = useState<SandboxEntry[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  // Per-file state — switching tabs doesn't lose unsaved edits in the other.
  // null = file doesn't exist yet (e.g. sandbox created before sandbox.json was a thing)
  const [contents, setContents] = useState<Record<SandboxFile, string>>({ "mise.toml": "", "sandbox.json": "" })
  const [originals, setOriginals] = useState<Record<SandboxFile, string | null>>({ "mise.toml": null, "sandbox.json": null })
  const [activeFile, setActiveFile] = useState<SandboxFile>("mise.toml")
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState("")
  const [newErr, setNewErr] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const isMobile = useIsMobile()

  const refreshList = useCallback(async () => {
    const xs = await listSandboxes()
    setSandboxes(xs)
    return xs
  }, [])

  useEffect(() => {
    refreshList().then((xs) => {
      if (xs.length > 0 && !selected) setSelected(xs[0].name)
    })
  }, [refreshList])

  useEffect(() => {
    if (!selected) {
      setContents({ "mise.toml": "", "sandbox.json": "" })
      setOriginals({ "mise.toml": null, "sandbox.json": null })
      return
    }
    setLoading(true)
    setErr(null)
    setActiveFile("mise.toml")
    // Load both files in parallel; null original means "file doesn't exist
    // on disk yet" — first save will create it.
    Promise.all(SANDBOX_FILES.map((f) => readSandbox(selected, f))).then((vals) => {
      const newContents: Record<SandboxFile, string> = { "mise.toml": "", "sandbox.json": "" }
      const newOriginals: Record<SandboxFile, string | null> = { "mise.toml": null, "sandbox.json": null }
      SANDBOX_FILES.forEach((f, i) => {
        const text = vals[i] ?? ""
        newContents[f] = text
        newOriginals[f] = vals[i]
      })
      setContents(newContents)
      setOriginals(newOriginals)
      setLoading(false)
    })
  }, [selected])

  const isDirty = (f: SandboxFile) => contents[f] !== (originals[f] ?? "")
  const activeDirty = isDirty(activeFile)

  const onSave = async () => {
    if (!selected || saving) return
    setSaving(true)
    setErr(null)
    const r = await writeSandbox(selected, contents[activeFile], activeFile)
    setSaving(false)
    if (!r.ok) {
      setErr(r.error ?? "save failed")
      return
    }
    setOriginals((prev) => ({ ...prev, [activeFile]: contents[activeFile] }))
    // Surface lock / commit issues — both are best-effort follow-ups after
    // the write succeeded, but the user wants to know if they happened.
    const issues: string[] = []
    if (activeFile === "mise.toml" && r.locked === false) {
      issues.push(`lock failed: ${r.lockError ?? "unknown"}`)
    }
    if (r.committed === false) {
      issues.push(`commit failed: ${r.commitError ?? "unknown"}`)
    }
    if (issues.length) setErr(`saved, but ${issues.join("; ")}`)
  }

  const onDelete = async (name: string) => {
    if (!confirm(`delete sandbox "${name}"? per-loop snapshots already created stay intact.`)) return
    const r = await deleteSandbox(name)
    if (!r.ok) {
      setErr(r.error ?? "delete failed")
      return
    }
    if (selected === name) setSelected(null)
    await refreshList()
  }

  const onSubmitNew = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = newName.trim()
    if (!SANDBOX_NAME_RE.test(trimmed)) {
      setNewErr("invalid name (letters/digits/_.-, max 64, must start with alnum)")
      return
    }
    if (sandboxes.some((x) => x.name === trimmed)) {
      setNewErr("name already exists")
      return
    }
    setNewErr(null)
    // Seed both files. Write mise.toml first (which also generates the
    // initial lockfile); sandbox.json second.
    const r1 = await writeSandbox(trimmed, NEW_SANDBOX_MISE_TOML, "mise.toml")
    if (!r1.ok) {
      setNewErr(r1.error ?? "create failed (mise.toml)")
      return
    }
    const r2 = await writeSandbox(trimmed, NEW_SANDBOX_META_JSON, "sandbox.json")
    if (!r2.ok) {
      setNewErr(r2.error ?? "create failed (sandbox.json)")
      return
    }
    await refreshList()
    setShowNew(false)
    setNewName("")
    setSelected(trimmed)
  }

  const sandboxList = (
    <aside className="w-64 shrink-0 border-r border-gray-200 bg-white flex flex-col h-full">
      <div className="px-3 h-9 flex items-center justify-between border-b border-gray-200">
        {isMobile ? (
          <button
            onClick={() => setSidebarOpen(false)}
            className="text-gray-500 hover:text-gray-900 px-1 rounded hover:bg-gray-100"
            title="close sandboxes"
          >
            <PanelLeftClose size={14} />
          </button>
        ) : (
          <span className="text-[11px] uppercase tracking-wide text-gray-500 font-medium">sandboxes</span>
        )}
        <span className="text-[11px] text-gray-400 ml-auto">{sandboxes.length}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto py-2">
        {sandboxes.map((e) => {
          const sel = selected === e.name
          return (
            <div
              key={e.name}
              className={
                "group/sandboxrow relative flex items-stretch " +
                (sel ? "bg-gray-100" : "hover:bg-gray-50")
              }
            >
              <button
                type="button"
                onClick={() => {
                  setSelected(e.name)
                  if (isMobile) setSidebarOpen(false)
                }}
                className="flex-1 min-w-0 px-3 py-2 flex items-center gap-2 text-left"
              >
                <span className="text-[13px] text-gray-900 flex-1 min-w-0 truncate">{e.name}</span>
              </button>
              <button
                type="button"
                onClick={(ev) => { ev.stopPropagation(); onDelete(e.name) }}
                className="opacity-0 group-hover/sandboxrow:opacity-100 transition-opacity w-7 flex items-center justify-center text-gray-400 hover:text-red-600"
                title={`delete sandbox "${e.name}"`}
              >
                <Trash2 size={13} />
              </button>
            </div>
          )
        })}
        {sandboxes.length === 0 && (
          <div className="px-3 py-4 text-[12px] text-gray-400 italic">
            no sandboxes yet · click "new sandbox" below
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => { setShowNew(true); setNewName(""); setNewErr(null) }}
        className="m-3 px-2 py-1.5 rounded border border-gray-200 text-xs text-gray-700 hover:bg-gray-50 flex items-center gap-2"
      >
        <span>+</span>
        <span>new sandbox</span>
      </button>
    </aside>
  )

  return (
    <div className="flex h-full w-full">
      {isMobile ? (
        <>
          {sidebarOpen ? (
            <div className="fixed inset-0 z-30" onClick={() => setSidebarOpen(false)}>
              <div className="absolute inset-0 bg-black/30" />
              <div className="absolute left-0 top-0 bottom-0 w-64 max-w-[80vw] shadow-xl" onClick={(e) => e.stopPropagation()}>
                {sandboxList}
              </div>
            </div>
          ) : (
            <aside className="w-9 shrink-0 border-r border-gray-200 bg-white flex flex-col items-center pt-2">
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="w-7 h-7 flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded"
                title="open sandboxes list"
              >
                <PanelLeftOpen size={16} />
              </button>
            </aside>
          )}
        </>
      ) : (
        sandboxList
      )}
      <main className="flex-1 min-w-0 flex flex-col bg-white min-h-0">
        {selected ? (
          <>
            <header className="h-9 shrink-0 border-b border-gray-200 px-3 flex items-center gap-1">
              <span className="text-[11px] text-gray-400 mr-2 font-mono">{selected}/</span>
              {SANDBOX_FILES.map((f) => {
                const isActive = activeFile === f
                const dirty = isDirty(f)
                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setActiveFile(f)}
                    className={
                      "h-7 px-2.5 text-[12px] rounded flex items-center gap-1 " +
                      (isActive
                        ? "bg-gray-100 text-gray-900"
                        : "text-gray-500 hover:bg-gray-50 hover:text-gray-900")
                    }
                  >
                    <span>{f}</span>
                    {dirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" title="unsaved" />}
                  </button>
                )
              })}
              <div className="flex-1" />
              {err && <span className="text-[11px] text-red-600">{err}</span>}
              <button
                type="button"
                onClick={onSave}
                disabled={!activeDirty || saving || loading}
                className="px-2.5 h-7 rounded text-xs bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {saving ? "saving…" : activeDirty ? "save" : "saved"}
              </button>
            </header>
            <div className="flex-1 min-h-0">
              {loading ? (
                <div className="p-3 text-[13px] text-gray-400 italic">loading…</div>
              ) : (
                // path drives language detection (.toml / .json). key includes
                // both sandbox + file so CodeMirror remounts when switching either,
                // keeping per-file undo history clean.
                <Suspense fallback={<div className="p-3 text-[13px] text-gray-400 italic">loading editor…</div>}>
                  <CodeEditor
                    key={`${selected}/${activeFile}`}
                    path={`${selected}/${activeFile}`}
                    value={contents[activeFile]}
                    onChange={(v) => setContents((prev) => ({ ...prev, [activeFile]: v }))}
                  />
                </Suspense>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-[13px] text-gray-400 italic">
            {sandboxes.length === 0 ? "create a new sandbox to get started" : "select a sandbox"}
          </div>
        )}
      </main>

      {showNew && (
        <div
          className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center"
          onClick={() => setShowNew(false)}
        >
          <div
            className="w-full max-w-[420px] mx-4 bg-white rounded-md shadow-xl border border-gray-200 p-4 md:p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-base font-semibold text-gray-900 mb-4">New sandbox</div>
            <form onSubmit={onSubmitNew} className="flex flex-col gap-4">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-gray-700 font-medium">Name</span>
                <input
                  autoFocus
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="coding-agent"
                  className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded outline-none focus:border-gray-500"
                />
                <span className="text-[11px] text-gray-400">
                  filename will be {newName.trim() ? `${newName.trim()}.toml` : "<name>.toml"}
                </span>
                {newErr && <span className="text-[11px] text-red-600">{newErr}</span>}
              </label>
              <div className="flex justify-end gap-2 mt-2 pt-3 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setShowNew(false)}
                  className="px-3 h-8 text-sm rounded text-gray-700 hover:bg-gray-100"
                >
                  cancel
                </button>
                <button
                  type="submit"
                  className="px-3 h-8 text-sm rounded bg-gray-900 text-white hover:bg-gray-700"
                >
                  create
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
