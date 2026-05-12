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
import { NavLink, useParams, useNavigate } from "react-router-dom"
import {
  vaultList,
  vaultFlatList,
  vaultRead,
  vaultWrite,
  vaultCreateFile,
  vaultBacklinks,
  listRepos,
  getRepo,
  type VaultEntry,
  type VaultId,
  type RepoEntry,
  type RepoDetail,
  type Backlink,
} from "../api"
import { useEffect, useState, useCallback } from "react"
import { useWorkspace } from "../ctx"
import { useIsMobile } from "../lib/useIsMobile"
import { CodeEditor } from "../components/markdown/CodeEditor"
import { Markdown } from "../components/markdown/Markdown"
import { PanelLeftClose, PanelLeftOpen } from "lucide-react"

const SUBS: { id: VaultId; label: string }[] = [
  { id: "knowledge", label: "Knowledge" },
  { id: "notes", label: "Notes" },
  { id: "personal", label: "Personal" },
  { id: "repos", label: "Repos" },
]

const VALID = new Set<VaultId>(["knowledge", "notes", "personal", "repos"])

export function ContextPage() {
  const { sub } = useParams<{ sub: string }>()
  const active = (VALID.has(sub as VaultId) ? sub : "knowledge") as VaultId

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
        {active === "repos" ? <ReposPane /> : <VaultPane key={active} vault={active} />}
      </div>
    </div>
  )
}

// ============================================================================
// VaultPane: left tree + right DocView
// ============================================================================

const VAULT_TAGLINE: Record<VaultId, string> = {
  knowledge: "team's distilled materials",
  notes: "team · public",
  personal: "yours · private",
  repos: "registered code repos",
}

function VaultPane({ vault }: { vault: VaultId }) {
  const [tree, setTree] = useState<VaultEntry[]>([])
  const [flat, setFlat] = useState<VaultEntry[]>([])
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set())
  const [pickedPath, setPickedPath] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [showNewFile, setShowNewFile] = useState(false)
  const [query, setQuery] = useState("")
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const isMobile = useIsMobile()

  useEffect(() => {
    vaultList(vault).then((entries) => {
      setTree(entries)
      // auto-pick first .md file
      const findFirst = (arr: VaultEntry[]): string | null => {
        for (const e of arr) {
          if (e.type === "file" && e.path.endsWith(".md")) return e.path
        }
        return null
      }
      setPickedPath(findFirst(entries))
    })
    vaultFlatList(vault).then(setFlat)
    setOpenFolders(new Set())
    setQuery("")
  }, [vault, reloadKey])

  const toggleFolder = (path: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

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
            {tree.map((node) => (
              <TreeNode
                key={node.path}
                vault={vault}
                node={node}
                depth={0}
                openFolders={openFolders}
                toggleFolder={toggleFolder}
                picked={pickedPath}
                onPick={(p) => {
                  setPickedPath(p)
                  if (isMobile) setSidebarOpen(false)
                }}
              />
            ))}
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

function isSecretsFolder(vault: VaultId, path: string): boolean {
  return vault === "personal" && (path === ".loopat/secrets" || path.endsWith("/.loopat/secrets"))
}
function isSecretFile(vault: VaultId, path: string): boolean {
  return vault === "personal" && path.startsWith(".loopat/secrets/")
}

function TreeNode({
  vault,
  node,
  depth,
  openFolders,
  toggleFolder,
  picked,
  onPick,
}: {
  vault: VaultId
  node: VaultEntry
  depth: number
  openFolders: Set<string>
  toggleFolder: (path: string) => void
  picked: string | null
  onPick: (path: string) => void
}) {
  if (node.type === "dir") {
    const open = openFolders.has(node.path)
    const secretsFolder = isSecretsFolder(vault, node.path)
    return (
      <>
        <button
          type="button"
          onClick={() => toggleFolder(node.path)}
          className={
            secretsFolder
              ? "w-full py-1.5 flex items-center gap-1.5 bg-amber-50/40 hover:bg-amber-50 text-left border-y border-amber-200/60 mt-1"
              : "w-full py-1 flex items-center gap-1 hover:bg-gray-50 text-left"
          }
          style={{ paddingLeft: 8 + depth * 12, paddingRight: 8 }}
          title={secretsFolder ? "secrets · convention: encrypted (placeholder, not yet implemented)" : undefined}
        >
          <span className={secretsFolder ? "text-amber-700" : "text-gray-500"}>{open ? "▾" : "▸"}</span>
          <span className="text-[12px]">{secretsFolder ? "🔐" : "📁"}</span>
          <span
            className={
              secretsFolder
                ? "text-[12px] uppercase tracking-wider font-semibold text-amber-900"
                : "text-[13px] text-gray-900 truncate"
            }
          >
            {node.name}
          </span>
          {secretsFolder && (
            <span className="ml-auto text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
              encrypted
            </span>
          )}
        </button>
        {open && (
          <Branch
            vault={vault}
            path={node.path}
            depth={depth + 1}
            openFolders={openFolders}
            toggleFolder={toggleFolder}
            picked={picked}
            onPick={onPick}
          />
        )}
      </>
    )
  }
  const sel = picked === node.path
  const secret = isSecretFile(vault, node.path)
  return (
    <button
      type="button"
      onClick={() => onPick(node.path)}
      className={
        "w-full py-1 flex items-center gap-2 text-left " +
        (sel ? "bg-gray-100" : secret ? "hover:bg-amber-50/50" : "hover:bg-gray-50")
      }
      style={{ paddingLeft: 8 + depth * 12, paddingRight: 8 }}
      title={secret ? "secret · 仅可注入" : undefined}
    >
      <span className="w-4" />
      {secret ? (
        <span className="text-amber-600 text-[12px] shrink-0">🔒</span>
      ) : (
        <span className="text-gray-500">📄</span>
      )}
      <span
        className={
          "flex-1 min-w-0 truncate text-[13px] " + (secret ? "text-amber-900" : "text-gray-900")
        }
      >
        {node.name}
      </span>
    </button>
  )
}

function Branch({
  vault,
  path,
  depth,
  openFolders,
  toggleFolder,
  picked,
  onPick,
}: {
  vault: VaultId
  path: string
  depth: number
  openFolders: Set<string>
  toggleFolder: (p: string) => void
  picked: string | null
  onPick: (p: string) => void
}) {
  const [entries, setEntries] = useState<VaultEntry[]>([])
  useEffect(() => {
    vaultList(vault, path).then(setEntries)
  }, [vault, path])
  return (
    <>
      {entries.map((e) => (
        <TreeNode
          key={e.path}
          vault={vault}
          node={e}
          depth={depth}
          openFolders={openFolders}
          toggleFolder={toggleFolder}
          picked={picked}
          onPick={onPick}
        />
      ))}
    </>
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
  const isMobile = useIsMobile()

  useEffect(() => {
    setEditing(false)
    setLastCommit(null)
    vaultRead(vault, path).then((r) => {
      const c = r?.content ?? ""
      setOriginal(c)
      setDraft(c)
    })
    vaultBacklinks(vault, path).then(setBacklinks)
  }, [vault, path])

  const isSecret = isSecretPath(path)
  const isMd = path.endsWith(".md")
  const allowDirectEdit = vault !== "knowledge"
  const allowLoopEdit = !isSecret
  const allowDistill = vault === "notes" && !isSecret

  const dirty = draft !== original

  const save = useCallback(async () => {
    if (!dirty || saving) return
    setSaving(true)
    try {
      const r = await vaultWrite(vault, path, draft)
      if (r.ok) {
        setOriginal(draft)
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
  }, [vault, path, draft, dirty, saving, onSaved])

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
        // edit mode: split source / preview
        <div className="flex-1 min-h-0 min-w-0 flex flex-col md:flex-row">
          <div className="flex-1 min-w-0 min-h-0 border-r border-gray-200 flex flex-col">
            <div className="px-3 h-7 shrink-0 border-b border-gray-200 flex items-center text-[11px] text-gray-500">
              source · markdown
            </div>
            <div className="flex-1 min-h-0">
              <CodeEditor path={path} value={draft} onChange={setDraft} />
            </div>
          </div>
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            <div className="px-3 h-7 shrink-0 border-b border-gray-200 flex items-center text-[11px] text-gray-500">
              preview
            </div>
            <div className="flex-1 min-h-0 overflow-auto px-6 py-4">
              <div className="max-w-[760px]">
                <Markdown text={draft} onWikilink={onWikilink} />
              </div>
            </div>
          </div>
        </div>
      ) : (
        // read mode: article + backlinks
        <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
          <article className="flex-1 min-h-0 overflow-auto px-4 md:px-8 py-4 md:py-6">
            <div className="max-w-[760px]">
              {isSecret ? (
                <div className="font-mono text-[14px] text-gray-400 select-none">
                  ••••••••••••••••••••••••
                  <div className="mt-2 text-[12px] text-gray-500 font-sans">
                    点 edit 编辑（值不显示）
                  </div>
                </div>
              ) : isMd ? (
                <Markdown text={original} onWikilink={onWikilink} />
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
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const isMobile = useIsMobile()

  useEffect(() => {
    listRepos().then((rs) => {
      setRepos(rs)
      if (rs.length > 0 && !selectedName) setSelectedName(rs[0].name)
    })
  }, [])

  useEffect(() => {
    if (!selectedName) return
    getRepo(selectedName).then(setDetail)
  }, [selectedName])

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
            none · `ln -s` or `git clone` into ~/.loopat/context/repos/
          </div>
        )}
      </div>
      <button
        disabled
        className="m-3 px-2 py-1.5 rounded border border-gray-200 text-xs text-gray-400 cursor-default flex items-center gap-2"
        title="UI not wired yet — symlink/clone manually"
      >
        <span>↳</span>
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
          <RepoView repo={detail} onSpawnLoop={onSpawnLoop} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-[13px] text-gray-400 italic">
            select a repo
          </div>
        )}
      </main>
    </div>
  )
}

function RepoView({ repo, onSpawnLoop }: { repo: RepoDetail; onSpawnLoop: () => void }) {
  const navigate = useNavigate()
  return (
    <>
      <header className="px-5 h-10 shrink-0 border-b border-gray-200 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[13px]">
          <span
            className={
              repo.status === "online"
                ? "w-2 h-2 rounded-full bg-emerald-500"
                : "w-2 h-2 rounded-full bg-gray-300"
            }
          />
          <span className="text-gray-900 font-medium">{repo.name}</span>
          {repo.remote && <span className="text-gray-500">· {repo.remote}</span>}
        </div>
        <div className="text-xs text-gray-500">default branch: {repo.branch ?? "—"}</div>
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
                <Markdown text={repo.readme} />
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
