/**
 * Context tab. Layout/visuals ported from phase1-prototype/src/pages/context.tsx
 * — sub-nav (knowledge/notes/personal/repos; agents skipped) + vault tree +
 * markdown editor. Backed by real fs via /api/workspace/*. Saves auto-commit.
 */
import { NavLink, useParams } from "react-router-dom"
import {
  vaultList,
  vaultRead,
  vaultWrite,
  vaultCreateFile,
  listRepos,
  type VaultEntry,
  type VaultId,
  type RepoEntry,
} from "../api"
import { useEffect, useState, useCallback } from "react"

const SUBS: { id: VaultId; label: string; hint?: string }[] = [
  { id: "knowledge", label: "Knowledge", hint: "团队沉淀" },
  { id: "notes", label: "Notes", hint: "团队 prose" },
  { id: "personal", label: "Personal", hint: "私有" },
  { id: "repos", label: "Repos", hint: "代码仓" },
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
            {s.hint && <span className="text-[10px] text-gray-400">{s.hint}</span>}
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
// VaultPane: left tree + right doc viewer/editor (knowledge / notes / personal)
// ============================================================================

function VaultPane({ vault }: { vault: VaultId }) {
  const [tree, setTree] = useState<VaultEntry[]>([])
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set())
  const [pickedPath, setPickedPath] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [showNewFile, setShowNewFile] = useState(false)

  useEffect(() => {
    vaultList(vault).then(setTree)
    setPickedPath(null)
    setOpenFolders(new Set())
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

  const footerHint = vaultFooter(vault)

  return (
    <div className="flex h-full w-full">
      <aside className="w-64 shrink-0 border-r border-gray-200 bg-white flex flex-col">
        <div className="px-3 h-9 flex items-center gap-1 border-b border-gray-200">
          <span className="text-[11px] uppercase tracking-wide text-gray-500 font-medium">{vault}</span>
          <div className="flex-1" />
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
          {tree.map((node) => (
            <TreeNode
              key={node.path}
              vault={vault}
              node={node}
              depth={0}
              openFolders={openFolders}
              toggleFolder={toggleFolder}
              picked={pickedPath}
              onPick={setPickedPath}
            />
          ))}
          {tree.length === 0 && (
            <div className="px-3 py-4 text-[12px] text-gray-400 italic">
              empty · click + 创建第一个文件
            </div>
          )}
        </div>
        <div className="px-3 h-9 border-t border-gray-200 flex items-center text-[11px] text-gray-500">
          {footerHint}
        </div>
      </aside>
      <main className="flex-1 min-w-0 flex flex-col bg-white">
        {pickedPath ? (
          <DocView vault={vault} path={pickedPath} onSaved={() => setReloadKey((k) => k + 1)} />
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

function vaultFooter(v: VaultId): string {
  switch (v) {
    case "knowledge":
      return "git: ~/.loopat/1001/context/knowledge"
    case "notes":
      return "git: ~/.loopat/1001/context/notes"
    case "personal":
      return "~/.loopat/1001/personal/simpx"
    default:
      return ""
  }
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
    return (
      <>
        <button
          type="button"
          onClick={() => toggleFolder(node.path)}
          className="w-full py-1 flex items-center gap-1 hover:bg-gray-50 text-left"
          style={{ paddingLeft: 8 + depth * 12, paddingRight: 8 }}
        >
          <span className="text-gray-500">{open ? "▾" : "▸"}</span>
          <span className="text-gray-500">📁</span>
          <span className="text-[13px] text-gray-900 truncate">{node.name}</span>
        </button>
        {open && <Branch vault={vault} path={node.path} depth={depth + 1} openFolders={openFolders} toggleFolder={toggleFolder} picked={picked} onPick={onPick} />}
      </>
    )
  }
  const sel = picked === node.path
  return (
    <button
      type="button"
      onClick={() => onPick(node.path)}
      className={
        "w-full py-1 flex items-center gap-2 text-left " +
        (sel ? "bg-gray-100" : "hover:bg-gray-50")
      }
      style={{ paddingLeft: 8 + depth * 12, paddingRight: 8 }}
    >
      <span className="w-4" />
      <span className="text-gray-500">📄</span>
      <span className="flex-1 min-w-0 truncate text-[13px] text-gray-900">{node.name}</span>
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
// DocView: view + edit selected file
// ============================================================================

function DocView({ vault, path, onSaved }: { vault: VaultId; path: string; onSaved: () => void }) {
  const [original, setOriginal] = useState("")
  const [draft, setDraft] = useState("")
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [lastCommit, setLastCommit] = useState<string | null>(null)

  useEffect(() => {
    setEditing(false)
    setLastCommit(null)
    vaultRead(vault, path).then((r) => {
      const c = r?.content ?? ""
      setOriginal(c)
      setDraft(c)
    })
  }, [vault, path])

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
      } else {
        alert(`save failed: ${r.error}`)
      }
    } finally {
      setSaving(false)
    }
  }, [vault, path, draft, dirty, saving, onSaved])

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="h-10 shrink-0 border-b border-gray-200 px-4 flex items-center gap-3">
        <span className="font-mono text-[12px] text-gray-500 truncate flex-1">{path}</span>
        {lastCommit && !dirty && (
          <span className="text-[10px] text-emerald-700 font-mono">commit {lastCommit}</span>
        )}
        {editing ? (
          <>
            <button
              onClick={() => {
                setDraft(original)
                setEditing(false)
              }}
              className="px-2 h-6 text-xs rounded text-gray-600 hover:bg-gray-100"
            >
              cancel
            </button>
            <button
              onClick={save}
              disabled={!dirty || saving}
              className="px-2 h-6 text-xs rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {saving ? "saving…" : dirty ? "save" : "saved"}
            </button>
          </>
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="px-2 h-6 text-xs rounded text-gray-700 hover:bg-gray-100"
          >
            ✎ edit
          </button>
        )}
      </header>
      <div className="flex-1 min-h-0 overflow-auto">
        {editing ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="w-full h-full p-4 text-[13px] font-mono leading-relaxed bg-white text-gray-900 outline-none resize-none border-0"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                e.preventDefault()
                save()
              }
            }}
          />
        ) : (
          <pre className="p-6 m-0 text-[13px] leading-relaxed whitespace-pre-wrap text-gray-900 font-sans">
            {original || <span className="italic text-gray-400">(empty)</span>}
          </pre>
        )}
      </div>
    </div>
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
        className="w-[420px] bg-white rounded-md shadow-xl border border-gray-200 p-5"
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
  const [repos, setRepos] = useState<RepoEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    listRepos()
      .then(setRepos)
      .finally(() => setLoaded(true))
  }, [])
  return (
    <div className="h-full overflow-auto px-6 py-6">
      <div className="max-w-[760px]">
        <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-3">repos · {repos.length}</div>
        {!loaded ? (
          <div className="text-gray-400">…</div>
        ) : repos.length === 0 ? (
          <div className="text-sm text-gray-500">
            还没有注册的代码仓。在 `~/.loopat/1001/context/repos/` 下 `git clone` 或 `ln -s` 一个进来。
            <div className="text-[11px] text-gray-400 mt-2">
              （5.3 会加 UI 注册按钮 + git worktree 集成）
            </div>
          </div>
        ) : (
          <ul className="space-y-2">
            {repos.map((r) => (
              <li key={r.path} className="border border-gray-200 rounded p-3 bg-white">
                <div className="flex items-center gap-2">
                  <span className="text-base">⌥</span>
                  <span className="text-sm font-medium text-gray-900">{r.name}</span>
                </div>
                <div className="text-[12px] text-gray-500 mt-1 font-mono truncate">{r.path}</div>
                {r.remote && (
                  <div className="text-[12px] text-gray-500 mt-0.5 font-mono truncate">↪ {r.remote}</div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
