/**
 * Git diff sidebar — lists unstaged / staged changes with inline actions.
 * Opens a modal for full diff on text files.
 * Includes commit box, git graph, and right-click context menu.
 */
import { useEffect, useState, useCallback, useRef } from "react"
import { RotateCw, Plus, Minus, Undo2, Search, Pencil, GitCommit, GitBranch } from "lucide-react"
import {
  getGitStatus, getGitDiff, gitStageFiles, gitDiscardFile, gitCommit, getGitLog,
  type GitStatus, type GitFileInfo, type GitCommit as GitCommitType,
} from "../api"
import { DiffModal } from "./DiffModal"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  A: { label: "A", color: "text-emerald-600" },
  M: { label: "M", color: "text-amber-600" },
  D: { label: "D", color: "text-red-600" },
  R: { label: "R", color: "text-purple-600" },
  "?": { label: "?", color: "text-gray-400" },
}

export function GitDiffSidebar({ loopId, onClose, onPickFile }: { loopId: string; onClose: () => void; onPickFile: (path: string) => void }) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [unstagedOpen, setUnstagedOpen] = useState(true)
  const [stagedOpen, setStagedOpen] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
  const [commitMsg, setCommitMsg] = useState("")
  const [committing, setCommitting] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  const [commits, setCommits] = useState<GitCommitType[]>([])
  const [loadingLog, setLoadingLog] = useState(false)
  const [graphOpen, setGraphOpen] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const s = await getGitStatus(loopId)
      setStatus(s)
    } catch {
      setError("Failed to load git status")
    } finally {
      setLoading(false)
    }
  }, [loopId])

  const refreshLog = useCallback(async () => {
    setLoadingLog(true)
    try {
      const c = await getGitLog(loopId, 50)
      setCommits(c)
    } catch {
      // silently fail
    } finally {
      setLoadingLog(false)
    }
  }, [loopId])

  useEffect(() => { refresh(); refreshLog() }, [refresh, refreshLog])

  const stageAll = async () => {
    if (!status?.unstaged.length) return
    const files = status.unstaged.map((f) => f.path)
    const ok = await gitStageFiles(loopId, files)
    if (ok) refresh()
  }

  const unstageAll = async () => {
    if (!status?.staged.length) return
    const files = status.staged.map((f) => f.path)
    const ok = await gitStageFiles(loopId, files, true)
    if (ok) refresh()
  }

  const stageOne = async (file: string) => {
    const ok = await gitStageFiles(loopId, [file])
    if (ok) refresh()
  }

  const unstageOne = async (file: string) => {
    const ok = await gitStageFiles(loopId, [file], true)
    if (ok) refresh()
  }

  const discardOne = async (file: string) => {
    const ok = await gitDiscardFile(loopId, file)
    if (ok) refresh()
  }

  const handleCommit = async () => {
    if (!commitMsg.trim()) return
    setCommitting(true)
    setCommitError(null)
    const res = await gitCommit(loopId, commitMsg.trim())
    setCommitting(false)
    if (res.ok) {
      setCommitMsg("")
      refresh()
      refreshLog()
    } else {
      setCommitError(res.error ?? "Commit failed")
    }
  }

  const filterText = filter.trim().toLowerCase()
  const filteredUnstaged = status ? status.unstaged.filter((f) => !filterText || f.path.toLowerCase().includes(filterText)) : []
  const filteredStaged = status ? status.staged.filter((f) => !filterText || f.path.toLowerCase().includes(filterText)) : []
  const empty = !status || (status.unstaged.length === 0 && status.staged.length === 0)

  return (
    <aside className="w-full h-full min-w-0 bg-white flex flex-col">
      {/* Header */}
      <header className="px-3 h-8 shrink-0 border-b border-gray-200 flex items-center gap-1 text-[11px] text-gray-500">
        <span className="tracking-wide">Git Changes</span>
        <div className="flex-1" />
        <button
          onClick={() => { refresh(); refreshLog() }}
          className="text-gray-500 hover:text-gray-900 px-1 rounded hover:bg-gray-100"
          title="refresh"
        >
          <RotateCw size={13} className={loading || loadingLog ? "animate-spin" : ""} />
        </button>
        <button
          className="text-gray-500 hover:text-gray-900 px-1 rounded hover:bg-gray-100"
          onClick={onClose}
          title="close"
        >
          ✕
        </button>
      </header>

      {/* Commit box */}
      <div className="px-3 py-2 border-b border-gray-100">
        <textarea
          placeholder="Commit message..."
          value={commitMsg}
          onChange={(e) => { setCommitMsg(e.target.value); setCommitError(null) }}
          rows={2}
          className="w-full px-2 py-1.5 text-[12px] border border-gray-200 rounded outline-none focus:border-gray-300 placeholder:text-gray-300 resize-none mb-1.5"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={handleCommit}
            disabled={committing || !commitMsg.trim()}
            className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-[11px] rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <GitCommit size={12} />
            {committing ? "Committing..." : "Commit"}
          </button>
          {status && status.staged.length > 0 && (
            <span className="text-[10px] text-gray-400">{status.staged.length} staged</span>
          )}
        </div>
        {commitError && (
          <div className="mt-1 text-[10px] text-red-500">{commitError}</div>
        )}
      </div>

      {/* Filter input */}
      <div className="px-3 py-2 border-b border-gray-100">
        <input
          type="text"
          placeholder="Filter files..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="w-full px-2 py-1 text-[12px] border border-gray-200 rounded outline-none focus:border-gray-300 placeholder:text-gray-300"
        />
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto text-[13px]">
        <div className="overflow-auto py-2">
          {loading && !status && (
            <div className="px-5 py-4 text-[12px] text-gray-400 italic">loading git status...</div>
          )}
          {error && (
            <div className="px-5 py-4 text-[12px] text-red-500">{error}</div>
          )}
          {empty && !loading && (
            <div className="px-5 py-4 text-[12px] text-gray-400 italic">no changes</div>
          )}

          {/* Unstaged section */}
          {filteredUnstaged.length > 0 && (
            <Section
              title="Unstaged Changes"
              count={filteredUnstaged.length}
              open={unstagedOpen}
              onToggle={() => setUnstagedOpen((o) => !o)}
              bulkAction={{ label: "Stage all", icon: <Plus size={12} />, onClick: stageAll }}
            >
              {filteredUnstaged.map((f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  loopId={loopId}
                  staged={false}
                  onStage={() => stageOne(f.path)}
                  onUnstage={() => unstageOne(f.path)}
                  onDiscard={() => discardOne(f.path)}
                  onEdit={(p) => onPickFile(p)}
                  onRefresh={refresh}
                />
              ))}
            </Section>
          )}

          {/* Staged section */}
          {filteredStaged.length > 0 && (
            <Section
              title="Staged Changes"
              count={filteredStaged.length}
              open={stagedOpen}
              onToggle={() => setStagedOpen((o) => !o)}
              bulkAction={{ label: "Unstage all", icon: <Minus size={12} />, onClick: unstageAll }}
            >
              {filteredStaged.map((f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  loopId={loopId}
                  staged
                  onStage={() => stageOne(f.path)}
                  onUnstage={() => unstageOne(f.path)}
                  onDiscard={() => discardOne(f.path)}
                  onEdit={(p) => onPickFile(p)}
                  onRefresh={refresh}
                />
              ))}
            </Section>
          )}
        </div>

        {/* Git Graph */}
        <div className="border-t border-gray-200">
          <div
            role="button"
            tabIndex={0}
            onClick={() => setGraphOpen((o) => !o)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setGraphOpen((o) => !o) }}
            className="w-full px-3 py-1.5 flex items-center gap-1.5 hover:bg-gray-50 text-left cursor-pointer select-none"
          >
            <span className="text-gray-500">{graphOpen ? "▾" : "▸"}</span>
            <GitBranch size={12} className="text-gray-500" />
            <span className="text-[11px] uppercase tracking-wide text-gray-500">History</span>
            <span className="text-[11px] text-gray-400">({commits.length})</span>
          </div>
          {graphOpen && (
            <div className="px-2 pb-2 max-h-64 overflow-auto">
              {loadingLog ? (
                <div className="px-3 py-3 text-[11px] text-gray-400 italic">loading history...</div>
              ) : commits.length === 0 ? (
                <div className="px-3 py-3 text-[11px] text-gray-400 italic">no commits</div>
              ) : (
                <GitGraph commits={commits} />
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}

function GitGraph({ commits }: { commits: GitCommitType[] }) {
  const colors = ["bg-blue-500", "bg-emerald-500", "bg-purple-500", "bg-amber-500", "bg-pink-500", "bg-cyan-500"]
  const branchColorMap = new Map<string, string>()
  let colorIdx = 0

  const getColor = (branch: string) => {
    if (!branchColorMap.has(branch)) {
      branchColorMap.set(branch, colors[colorIdx % colors.length])
      colorIdx++
    }
    return branchColorMap.get(branch)!
  }

  return (
    <div className="space-y-0">
      {commits.map((commit, idx) => {
        const primaryRef = commit.branch ?? commit.branches[0] ?? null
        const color = primaryRef ? getColor(primaryRef) : "bg-gray-400"
        const isHead = idx === 0
        const dateStr = new Date(commit.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })
        const timeStr = new Date(commit.date).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })

        return (
          <div
            key={commit.hash}
            className="group/graph-row flex items-start gap-2 py-0.5 px-1.5 rounded hover:bg-gray-100 cursor-default text-[11px]"
            title={`${commit.subject}\n${commit.author} · ${dateStr} ${timeStr}`}
          >
            <div className="flex flex-col items-center shrink-0">
              <div className={`w-2.5 h-2.5 rounded-full ${color} ring-2 ring-white ${isHead ? "ring-blue-300" : ""}`} />
              {idx < commits.length - 1 && (
                <div className={`w-0.5 h-10 ${color} opacity-10`} />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[10px] text-gray-400 truncate">{commit.shortHash}</span>
                {isHead && (
                  <span className="text-[9px] px-1 py-0 rounded bg-blue-100 text-blue-700 font-medium">HEAD</span>
                )}
                {commit.branches.slice(0, 2).map((b) => (
                  <span key={b} className="text-[9px] px-1 py-0 rounded bg-emerald-100 text-emerald-700 font-medium truncate max-w-[60px]">{b}</span>
                ))}
                {commit.tags.map((t) => (
                  <span key={t} className="text-[9px] px-1 py-0 rounded bg-purple-100 text-purple-700 font-medium">{t}</span>
                ))}
              </div>
              <div className="text-gray-700 truncate">{commit.subject}</div>
              <div className="text-gray-400 text-[10px]">{commit.author} · {dateStr}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Section({
  title,
  count,
  open,
  onToggle,
  bulkAction,
  children,
}: {
  title: string
  count: number
  open: boolean
  onToggle: () => void
  bulkAction: { label: string; icon: React.ReactNode; onClick: () => void }
  children: React.ReactNode
}) {
  return (
    <div className="mb-2">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onToggle() }}
        className="w-full px-3 py-1.5 flex items-center gap-1.5 hover:bg-gray-50 text-left group/section cursor-pointer select-none"
      >
        <span className="text-gray-500">{open ? "▾" : "▸"}</span>
        <span className="text-[11px] uppercase tracking-wide text-gray-500">{title}</span>
        <span className="text-[11px] text-gray-400">({count})</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); bulkAction.onClick() }}
          className="opacity-100 sm:opacity-0 sm:group-hover/section:opacity-100 transition-opacity px-1 py-0.5 rounded hover:bg-gray-200 text-gray-500 hover:text-gray-900 flex items-center gap-0.5"
          title={bulkAction.label}
        >
          {bulkAction.icon}
        </button>
      </div>
      {open && <div>{children}</div>}
    </div>
  )
}

type ContextMenuAction = {
  label: string
  icon?: React.ReactNode
  onClick: () => void
  danger?: boolean
  separator?: boolean
}

function FileRow({
  file,
  loopId,
  staged,
  onStage,
  onUnstage,
  onDiscard,
  onEdit,
  onRefresh,
}: {
  file: GitFileInfo
  loopId: string
  staged: boolean
  onStage: () => void
  onUnstage: () => void
  onDiscard: () => void
  onEdit: (editorPath: string) => void
  onRefresh: () => void
}) {
  const [showDiff, setShowDiff] = useState(false)
  const [diff, setDiff] = useState<string | null>(null)
  const [loadingDiff, setLoadingDiff] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    if (contextMenu) {
      document.addEventListener("mousedown", handleClick)
      return () => document.removeEventListener("mousedown", handleClick)
    }
  }, [contextMenu])

  const openDiff = async () => {
    if (file.isBinary) return
    setShowDiff(true)
    if (diff === null) {
      setLoadingDiff(true)
      const d = await getGitDiff(loopId, file.path, staged)
      setDiff(d ?? "")
      setLoadingDiff(false)
    }
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  const editorPath = `workdir/${file.path}`

  const actions: ContextMenuAction[] = [
    {
      label: "Open in Editor",
      icon: <Pencil size={12} />,
      onClick: () => { onEdit(editorPath); setContextMenu(null) },
    },
    {
      label: "View Diff",
      icon: <Search size={12} />,
      onClick: () => { openDiff(); setContextMenu(null) },
    },
    { separator: true, label: "", onClick: () => {} },
    staged
      ? {
          label: "Unstage",
          icon: <Minus size={12} />,
          onClick: () => { onUnstage(); setContextMenu(null) },
        }
      : {
          label: "Stage",
          icon: <Plus size={12} />,
          onClick: () => { onStage(); setContextMenu(null) },
        },
    !staged && {
      label: "Discard Changes",
      icon: <Undo2 size={12} />,
      onClick: () => { setConfirmDiscard(true); setContextMenu(null) },
      danger: true,
    },
  ].filter(Boolean) as ContextMenuAction[]

  const si = STATUS_LABEL[file.status] ?? { label: file.status, color: "text-gray-500" }
  const lastSlash = file.path.lastIndexOf("/")
  const fileName = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path
  const dirName = lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : null

  return (
    <>
      <div
        className="group/row relative flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50"
        onContextMenu={handleContextMenu}
      >
        {/* Status badge */}
        <span className={`w-5 text-center text-[11px] font-mono font-semibold ${si.color}`}>
          {si.label}
        </span>

        {/* Filename + directory */}
        <span className="flex-1 min-w-0 truncate text-[13px] font-mono">
          <span className="text-gray-900">{fileName}</span>
          {dirName && <span className="text-gray-400 ml-0.5">{dirName}</span>}
        </span>

        {/* Diff stats */}
        {!file.isBinary && (file.additions > 0 || file.deletions > 0) && (
          <span className="text-[11px] font-mono flex items-center gap-0.5 shrink-0">
            <span className="text-emerald-600">+{file.additions}</span>
            <span className="text-red-500">-{file.deletions}</span>
          </span>
        )}

        {/* Hover actions */}
        <span className="inline-flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover/row:opacity-100 transition-opacity shrink-0">
          <button
            type="button"
            onClick={() => onEdit(editorPath)}
            className="w-5 h-5 flex items-center justify-center text-gray-400 hover:text-blue-600 rounded"
            title="edit file"
          >
            <Pencil size={13} />
          </button>

          {staged && (
            <button
              type="button"
              onClick={openDiff}
              className="w-5 h-5 flex items-center justify-center text-gray-400 hover:text-gray-700 rounded"
              title="view diff"
              disabled={file.isBinary}
            >
              <Search size={13} />
            </button>
          )}

          {staged ? (
            <button
              type="button"
              onClick={onUnstage}
              className="w-5 h-5 flex items-center justify-center text-gray-400 hover:text-amber-600 rounded"
              title="unstage"
            >
              <Minus size={13} />
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setConfirmDiscard(true)}
                className="w-5 h-5 flex items-center justify-center text-gray-400 hover:text-red-500 rounded"
                title="discard changes"
              >
                <Undo2 size={13} />
              </button>
              <button
                type="button"
                onClick={onStage}
                className="w-5 h-5 flex items-center justify-center text-gray-400 hover:text-emerald-600 rounded"
                title="stage"
              >
                <Plus size={13} />
              </button>
            </>
          )}
        </span>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[160px] py-1 bg-white border border-gray-200 rounded-md shadow-lg text-[12px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {actions.map((action, idx) =>
            action.separator ? (
              <div key={idx} className="my-1 border-t border-gray-100" />
            ) : (
              <button
                key={idx}
                onClick={action.onClick}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-100 ${action.danger ? "text-red-600" : "text-gray-700"}`}
              >
                {action.icon}
                <span>{action.label}</span>
              </button>
            )
          )}
        </div>
      )}

      {/* Diff modal */}
      {showDiff && (
        <DiffModal
          filePath={file.path}
          diff={diff}
          loading={loadingDiff}
          onClose={() => setShowDiff(false)}
        />
      )}

      {/* Discard confirmation */}
      {confirmDiscard && (
        <Dialog open onOpenChange={(o) => { if (!o) setConfirmDiscard(false) }}>
          <DialogContent className="sm:max-w-sm bg-white p-5 gap-4" showCloseButton={false}>
            <DialogHeader>
              <DialogTitle className="text-sm">Discard changes</DialogTitle>
            </DialogHeader>
            <p className="text-[13px] text-gray-600 break-all font-mono">{file.path}</p>
            <p className="text-[12px] text-gray-500">
              {file.status === "?"
                ? "This file is untracked and will be deleted."
                : "This will permanently discard all changes to this file. This action cannot be undone."}
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setConfirmDiscard(false)}
                className="px-3 py-1.5 text-xs rounded bg-gray-100 text-gray-700 hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                onClick={() => { setConfirmDiscard(false); onDiscard() }}
                className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-700"
              >
                Discard
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
