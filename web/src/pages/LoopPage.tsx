/**
 * Loop tab — AI chat with Claude Code-like experience.
 * Chat area uses assistant-ui runtime with custom claudecodeui-styled components.
 */
import { useEffect, useState } from "react"
import { useParams, useNavigate, Navigate } from "react-router-dom"
import { AssistantRuntimeProvider } from "@assistant-ui/react"
import { PanelLeftClose, PanelLeftOpen, Archive, ArchiveRestore, GitBranch, Globe, Lock, Copy, Check } from "lucide-react"
import { Panel, Group, Separator } from "react-resizable-panels"
import ChatInterface from "@/components/chat/ChatInterface"
import { useWorkspace } from "../ctx"
import { useLoopRuntime, LoopRuntimeProvider } from "../useLoopRuntime"
import { getContext, getLoopSandbox, refreshLoopSandbox, type ContextMount, type LoopSandboxInfo, type LoopMeta, markLoopViewed } from "../api"
import { SharePage } from "./SharePage"
import { useIsMobile } from "../lib/useIsMobile"
import { useLoopStatus } from "../useLoopStatus"
import { FileTree } from "../FileTree"
import { GitDiffSidebar } from "../components/GitDiffSidebar"
import { ShareArtifactDialog } from "../components/ShareArtifactDialog"
import { lazy, Suspense } from "react"
const Editor = lazy(() => import("../Editor").then(m => ({ default: m.Editor })))
const Terminal = lazy(() => import("../Terminal").then(m => ({ default: m.Terminal })))

type RightMode = "info" | "workdir" | "editor" | "terminal" | "git"

export function LoopPage() {
  const { id } = useParams<{ id: string }>()
  const ws = useWorkspace()

  if (!id) return <Navigate to={`/loop`} replace />

  // Anonymous on /loop/:id → read-only share view. Server gates by meta.public.
  // ws.loops is empty for anonymous visitors (the list endpoint requires auth),
  // so we don't even look in it; the share view fetches meta on its own.
  if (!ws.currentUser) {
    return <SharePage />
  }

  const meta = ws.loops.find((l) => l.id === id)
  if (!meta) {
    // Loop not in current filtered list. Most common cause: user just archived
    // it (and showArchived is off). Fall back to LoopRedirect, which jumps to
    // the first available loop or shows the empty state.
    return <Navigate to="/loop" replace />
  }

  return (
    <div className="h-full w-full flex min-h-0">
      <LoopsList currentId={id} />
      <LoopMain key={id} meta={meta} />
    </div>
  )
}

// ============================================================================
// Loops list (col 1) — ported from phase1 LoopsList
// ============================================================================

function LoopsList({ currentId }: { currentId: string }) {
  const ws = useWorkspace()
  const navigate = useNavigate()
  const [scope, setScope] = useState<"mine" | "all" | "rfd">("mine")
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("loopat:loopsList:collapsed") === "1")
  const isMobile = useIsMobile()
  const statusMap = useLoopStatus(ws.loops.map(l => l.id))

  const userId = ws.currentUser?.id
  const filtered = ws.loops.filter((loop) => {
    if (scope === "mine") return loop.createdBy === userId
    if (scope === "rfd") return false // RFD tab
    return true // "all"
  })

  const setCollapsedPersist = (v: boolean) => {
    setCollapsed(v)
    localStorage.setItem("loopat:loopsList:collapsed", v ? "1" : "0")
  }

  const sidebarContent = (
    <aside className="w-60 shrink-0 border-r border-gray-200 bg-white flex flex-col h-full">
      <div className="px-2 h-10 flex items-center gap-1 border-b border-gray-200">
        {(["mine", "all", "rfd"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setScope(s)}
            className={
              scope === s
                ? s === "rfd"
                  ? "px-2 h-6 rounded text-[11px] flex items-center gap-1 bg-amber-600 text-white"
                  : "px-2 h-6 rounded text-[11px] bg-gray-900 text-white"
                : s === "rfd"
                  ? "px-2 h-6 rounded text-[11px] flex items-center gap-1 text-amber-700 hover:bg-amber-50"
                  : "px-2 h-6 rounded text-[11px] text-gray-500 hover:bg-gray-100"
            }
          >
            {s === "mine" ? "mine" : s === "all" ? "all" : "RFD"}
          </button>
        ))}
        <span className="text-[11px] text-gray-400 ml-auto pr-1">{filtered.length}</span>
        <button
          type="button"
          onClick={() => ws.setShowArchived(!ws.showArchived)}
          className={
            ws.showArchived
              ? "w-6 h-6 flex items-center justify-center text-gray-700 bg-gray-100 rounded"
              : "w-6 h-6 flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded"
          }
          title={ws.showArchived ? "hide archived" : "show archived"}
        >
          <Archive size={13} />
        </button>
        <button
          type="button"
          onClick={() => setCollapsedPersist(true)}
          className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded"
          title="collapse sidebar"
        >
          <PanelLeftClose size={14} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto py-2">
        {filtered.map((loop) => {
          const sel = currentId === loop.id
          const archived = loop.archived === true
          // Server rejects PATCH from non-owners with 403 — surface that
          // upfront so users don't think the button is broken.
          const isOwner = ws.currentUser?.id === loop.createdBy
          const entry = statusMap[loop.id]
          const isDone = entry?.status === "Done"
          const isRunning = entry !== undefined && !isDone
          return (
            <div
              key={loop.id}
              className={
                "group/row relative flex items-stretch " +
                (sel ? "bg-gray-100" : "hover:bg-gray-50")
              }
            >
              <button
                type="button"
                onClick={() => {
                  markLoopViewed(loop.id)
                  navigate(`/loop/${loop.id}`)
                  if (isMobile) setCollapsedPersist(true)
                }}
                className={
                  "flex-1 min-w-0 px-3 py-2 flex items-center gap-2 text-left " +
                  (archived ? "opacity-60" : "")
                }
              >
                <span className={
                  "w-1.5 h-1.5 rounded-full shrink-0 " +
                  (archived ? "bg-gray-400" : isRunning ? "bg-blue-500 animate-pulse" : isDone && !entry?.viewed ? "bg-yellow-500" : isDone ? "bg-emerald-500" : "bg-gray-300")
                } />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-gray-900 truncate flex items-center gap-1">
                    {archived && <Archive size={10} className="text-gray-400 shrink-0" />}
                    <span className="truncate">{loop.title}</span>
                  </div>
                  {entry && (
                    <div className="text-[10px] text-gray-500 truncate mt-0.5">
                      {entry.status}
                    </div>
                  )}
                  <div className="text-[11px] text-gray-500 truncate flex items-center gap-1">
                    <span className="text-gray-400 font-mono text-[10px]">‹›</span>
                    <span>{loop.createdBy}</span>
                    <span>·</span>
                    <span className="font-mono">{loop.id.slice(0, 6)}</span>
                  </div>
                </div>
              </button>
              <button
                type="button"
                disabled={!isOwner}
                onClick={(e) => {
                  e.stopPropagation()
                  if (isOwner) ws.setLoopArchived(loop.id, !archived)
                }}
                className={
                  "opacity-0 group-hover/row:opacity-100 transition-opacity w-7 flex items-center justify-center " +
                  (isOwner
                    ? "text-gray-400 hover:text-gray-700"
                    : "text-gray-300 cursor-not-allowed")
                }
                title={
                  isOwner
                    ? (archived ? "unarchive" : "archive (hide + read-only)")
                    : `only ${loop.createdBy} can ${archived ? "unarchive" : "archive"} this loop`
                }
              >
                {archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
              </button>
            </div>
          )
        })}
        {filtered.length === 0 && (
          <div className="px-3 py-4 text-[12px] text-gray-400 italic">no loops · click "+ New Loop"</div>
        )}
      </div>
    </aside>
  )

  if (collapsed) {
    return (
      <aside className="w-9 shrink-0 border-r border-gray-200 bg-white flex flex-col items-center pt-2">
        <button
          type="button"
          onClick={() => setCollapsedPersist(false)}
          className="w-7 h-7 flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded"
          title="expand sidebar"
        >
          <PanelLeftOpen size={16} />
        </button>
      </aside>
    )
  }

  // On mobile, render expanded sidebar as a fixed overlay
  if (isMobile) {
    return (
      <>
        <aside className="w-9 shrink-0 border-r border-gray-200 bg-white flex flex-col items-center pt-2">
          <button
            type="button"
            onClick={() => setCollapsedPersist(true)}
            className="w-7 h-7 flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded"
            title="collapse sidebar"
          >
            <PanelLeftClose size={16} />
          </button>
        </aside>
        <div className="fixed inset-0 z-40" onClick={() => setCollapsedPersist(true)}>
          <div className="absolute inset-0 bg-black/30" />
          <div className="absolute left-0 top-0 bottom-0 w-64 max-w-[80vw] shadow-xl" onClick={(e) => e.stopPropagation()}>
            {sidebarContent}
          </div>
        </div>
      </>
    )
  }

  return sidebarContent
}

// ============================================================================
// Loop main (chat + header + right panel)
// ============================================================================

function LoopMain({ meta }: { meta: LoopMeta }) {
  const ws = useWorkspace()
  const isMobile = useIsMobile()
  const { runtime, connected, reconnecting, running, viewers, extra, queue, onClearQueue } = useLoopRuntime(meta.id, ws.currentUser?.id ?? "")
  const [openPanels, setOpenPanels] = useState<RightMode[]>([])
  const [pickedFile, setPickedFile] = useState<string | null>(null)
  const [mounts, setMounts] = useState<ContextMount[]>([])
  const [sandboxInfo, setSandboxInfo] = useState<LoopSandboxInfo | null>(null)
  const [refreshingSandbox, setRefreshingSandbox] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [chatSize, setChatSize] = useState(() => {
    const saved = localStorage.getItem("loopat:chatSize")
    return saved ? parseInt(saved, 10) : 60
  })
  const [sideSplit, setSideSplit] = useState(() => {
    const saved = localStorage.getItem("loopat:sideSplit")
    return saved ? parseInt(saved, 10) : 50
  })

  useEffect(() => {
    getContext(meta.id).then(setMounts)
    getLoopSandbox(meta.id).then(setSandboxInfo)
    markLoopViewed(meta.id)
  }, [meta.id])

  const onRefreshSandbox = async () => {
    if (refreshingSandbox) return
    setRefreshingSandbox(true)
    const r = await refreshLoopSandbox(meta.id)
    if (r.ok) {
      // Re-fetch so versions update; sandbox restart is handled server-side
      // (next attach respawns with the new lock).
      setSandboxInfo(await getLoopSandbox(meta.id))
    }
    setRefreshingSandbox(false)
  }

  const toggleMode = (m: RightMode) => {
    setOpenPanels((prev) => {
      if (prev.includes(m)) return prev.filter((p) => p !== m)
      return [...prev, m]
    })
  }

  const openFile = (path: string) => {
    setPickedFile(path)
    setOpenPanels((prev) => prev.includes("editor") ? prev : [...prev, "editor"])
  }

  const closePanel = (m: RightMode) => {
    setOpenPanels((prev) => prev.filter((p) => p !== m))
  }

  const onChatResize = (layout: Record<string, number>) => {
    const cSize = layout["chat"] ?? chatSize
    setChatSize(cSize)
    localStorage.setItem("loopat:chatSize", String(cSize))
  }

  const onSideSplitResize = (layout: Record<string, number>) => {
    const sSize = layout["editorCol"] ?? sideSplit
    setSideSplit(sSize)
    localStorage.setItem("loopat:sideSplit", String(sSize))
  }

  const hasPanels = openPanels.length > 0
  const editorPanels = openPanels.filter((m) => m === "editor" || m === "terminal")
  const otherPanels = openPanels.filter((m) => m !== "editor" && m !== "terminal")
  const hasEditorCol = editorPanels.length > 0
  const hasOtherCol = otherPanels.length > 0

  const renderPanel = (mode: RightMode) => {
    if (mode === "git") {
      return <GitDiffSidebar key={mode} loopId={meta.id} onClose={() => closePanel("git")} onPickFile={openFile} />
    }
    return (
      <RightPanel
        key={mode}
        loopId={meta.id}
        meta={meta}
        mode={mode}
        onClose={() => closePanel(mode)}
        pickedFile={pickedFile}
        onPickFile={openFile}
        currentUserId={ws.currentUser?.id ?? ""}
      />
    )
  }

  const renderVerticalGroup = (panels: RightMode[]) => {
    if (panels.length === 0) return null
    if (panels.length === 1) return <>{renderPanel(panels[0])}</>
    return (
      <Group orientation="vertical" className="flex-1 min-w-0 min-h-0">
        {panels.map((mode) => (
          <Panel key={mode} id={mode} minSize={10} className="flex flex-col min-h-0 min-w-0">
            {renderPanel(mode)}
          </Panel>
        ))}
        {panels.slice(0, -1).map((_, i) => (
          <Separator
            key={`sep-${panels[i]}`}
            className="relative h-1.5 cursor-row-resize group flex items-center justify-center after:absolute after:left-0 after:right-0 after:top-1/2 after:h-px after:-translate-y-1/2 after:bg-gray-200 after:transition-colors hover:after:bg-blue-400"
          >
            <div className="absolute left-1/2 -translate-x-1/2 w-8 h-1.5 rounded-full bg-gray-300 group-hover:bg-blue-400 transition-colors" />
          </Separator>
        ))}
      </Group>
    )
  }

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col">
      <LoopHeader
        meta={meta}
        mounts={mounts}
        sandboxInfo={sandboxInfo}
        onRefreshSandbox={onRefreshSandbox}
        refreshingSandbox={refreshingSandbox}
        connected={connected}
        reconnecting={reconnecting}
        running={running}
        viewers={viewers}
        queue={queue}
        onClearQueue={onClearQueue}
        openPanels={openPanels}
        toggleMode={toggleMode}
        onShareWork={() => setShareOpen(true)}
      />
      {isMobile ? (
        <div className="flex-1 min-h-0">
          <LoopRuntimeProvider extra={extra}>
            <AssistantRuntimeProvider runtime={runtime}>
              <ChatInterface
                archived={meta.archived === true}
                onUnarchive={() => ws.setLoopArchived(meta.id, false)}
              />
            </AssistantRuntimeProvider>
          </LoopRuntimeProvider>
        </div>
      ) : hasPanels ? (
        <Group
          orientation="horizontal"
          className="flex-1 min-w-0 min-h-0"
          onLayoutChange={onChatResize}
        >
          <Panel
            id="chat"
            minSize={20}
            defaultSize={chatSize}
            className="flex flex-col min-h-0 min-w-0"
          >
            <LoopRuntimeProvider extra={extra}>
              <AssistantRuntimeProvider runtime={runtime}>
                <ChatInterface
                  archived={meta.archived === true}
                  onUnarchive={() => ws.setLoopArchived(meta.id, false)}
                />
              </AssistantRuntimeProvider>
            </LoopRuntimeProvider>
          </Panel>
          <Separator className="relative w-1.5 cursor-col-resize group flex items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-gray-200 after:transition-colors hover:after:bg-blue-400">
            <div className="absolute top-1/2 -translate-y-1/2 h-8 w-1.5 rounded-full bg-gray-300 group-hover:bg-blue-400 transition-colors" />
          </Separator>
          <Panel
            id="side"
            minSize={15}
            defaultSize={100 - chatSize}
            className="flex flex-col min-h-0 min-w-0"
          >
            {hasEditorCol && hasOtherCol ? (
              <Group
                orientation="horizontal"
                className="flex-1 min-w-0 min-h-0"
                onLayoutChange={onSideSplitResize}
              >
                <Panel id="editorCol" minSize={15} defaultSize={sideSplit} className="flex flex-col min-h-0 min-w-0">
                  {renderVerticalGroup(editorPanels)}
                </Panel>
                <Separator className="relative w-1.5 cursor-col-resize group flex items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-gray-200 after:transition-colors hover:after:bg-blue-400">
                  <div className="absolute top-1/2 -translate-y-1/2 h-8 w-1.5 rounded-full bg-gray-300 group-hover:bg-blue-400 transition-colors" />
                </Separator>
                <Panel id="otherCol" minSize={15} defaultSize={100 - sideSplit} className="flex flex-col min-h-0 min-w-0">
                  {renderVerticalGroup(otherPanels)}
                </Panel>
              </Group>
            ) : (
              <>
                {hasEditorCol && renderVerticalGroup(editorPanels)}
                {hasOtherCol && renderVerticalGroup(otherPanels)}
              </>
            )}
          </Panel>
        </Group>
      ) : (
        <div className="flex-1 min-h-0">
          <LoopRuntimeProvider extra={extra}>
            <AssistantRuntimeProvider runtime={runtime}>
              <ChatInterface
                archived={meta.archived === true}
                onUnarchive={() => ws.setLoopArchived(meta.id, false)}
              />
            </AssistantRuntimeProvider>
          </LoopRuntimeProvider>
        </div>
      )}
      {hasPanels && isMobile && openPanels.map((mode) => (
        <div key={mode} className="fixed inset-0 z-40">
          {renderPanel(mode)}
        </div>
      ))}
      <ShareArtifactDialog loop={meta} open={shareOpen} onClose={() => setShareOpen(false)} onSaved={() => ws.refresh()} />
    </div>
  )
}

// ============================================================================
// Loop header (driver state + context chips + mode toggles) — phase1 LoopHeader
// ============================================================================

function LoopHeader({
  meta,
  mounts,
  sandboxInfo,
  onRefreshSandbox,
  refreshingSandbox,
  connected,
  reconnecting,
  running,
  viewers,
  queue,
  onClearQueue,
  openPanels,
  toggleMode,
  onShareWork,
}: {
  meta: LoopMeta
  mounts: ContextMount[]
  sandboxInfo: LoopSandboxInfo | null
  onRefreshSandbox: () => Promise<void>
  refreshingSandbox: boolean
  connected: boolean
  reconnecting: boolean
  running: boolean
  viewers: number
  queue: string[]
  onClearQueue: () => void
  openPanels: RightMode[]
  toggleMode: (m: RightMode) => void
  onShareWork: () => void
}) {
  const modeBtn = (label: string, m: RightMode) => (
    <button
      key={m}
      className={
        openPanels.includes(m)
          ? "px-2 py-0.5 rounded bg-gray-100 text-gray-900"
          : "px-2 py-0.5 rounded text-gray-500 hover:text-gray-900 hover:bg-gray-50"
      }
      onClick={() => toggleMode(m)}
    >
      {label}
    </button>
  )
  return (
    <header className="px-3 md:px-5 pt-3 pb-2 shrink-0 border-b border-gray-200">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[14px] md:text-[15px] font-medium text-gray-900">{meta.title}</span>
        <span className="text-xs text-gray-500">
          driver: <span className="text-gray-900">{meta.createdBy}</span>
        </span>
        {/* Only surface WS state when something's wrong — green-when-fine is noise. */}
        {!connected && (
          <span className={"text-[11px] " + (reconnecting ? "text-amber-600" : "text-red-600")}>
            {reconnecting ? "reconnecting…" : "disconnected"}
          </span>
        )}
        {running && <span className="text-[11px] text-blue-600">running</span>}
        {viewers > 1 && (
          <span
            title="people watching"
            className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200"
          >
            👥 {viewers}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={onShareWork}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] border ${meta.shareEnabled ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-100"}`}
          title="Share workspace artifact (static files or port forward)"
        >
          <Globe size={11} />
          Share Artifact
        </button>
        <ShareToggle meta={meta} />
      </div>

      {/* workdir + branch + mode toggles */}
      <div className="text-xs text-gray-500 mt-1.5 flex items-center gap-2 flex-wrap">
        <span className="font-mono">~/.loopat/loops/{meta.id.slice(0, 8)}/workdir</span>
        <span>·</span>
        <span>main</span>
        {viewers > 0 && (
          <>
            <span>·</span>
            <span>{viewers} viewing</span>
          </>
        )}
        <div className="flex-1" />
        <div className="flex items-center gap-1 text-[11px]">
          {modeBtn("ℹ info", "info")}
          {modeBtn("▤ workdir", "workdir")}
          {modeBtn("✎ editor", "editor")}
          {modeBtn("▷ terminal", "terminal")}
          <button
            className={
              openPanels.includes("git")
                ? "px-2 py-0.5 rounded bg-gray-100 text-gray-900"
                : "px-2 py-0.5 rounded text-gray-500 hover:text-gray-900 hover:bg-gray-50"
            }
            onClick={() => toggleMode("git")}
            title="git changes"
          >
            <GitBranch size={14} />
          </button>
        </div>
      </div>

      {/* context chips */}
      <div className="mt-2 flex items-center gap-1.5 flex-wrap text-[11px]">
        <span className="text-gray-400">context:</span>
        {mounts.map((m) => (
          <ContextChip key={m.path} label={m.name} value={m.name === "knowledge" ? "ro" : "rw"} />
        ))}
      </div>

      {/* sandbox row — name + version. When catalog is newer, a muted text link
          offers refresh (intentionally low-key: pinning is the default, users
          don't need to chase latest). */}
      {sandboxInfo && sandboxInfo.name && (
        <div className="mt-1 flex items-center gap-1.5 flex-wrap text-[11px]">
          <span className="text-gray-400">sandbox:</span>
          <ContextChip
            label={sandboxInfo.name}
            value={sandboxInfo.loopVersion ?? "unversioned"}
          />
          {sandboxInfo.catalogVersion && sandboxInfo.catalogVersion !== sandboxInfo.loopVersion && (
            <button
              type="button"
              onClick={onRefreshSandbox}
              disabled={refreshingSandbox}
              className="text-gray-400 hover:text-gray-700 disabled:opacity-50 underline decoration-dotted underline-offset-2"
              title={`catalog has ${sandboxInfo.catalogVersion}; click to update + respawn sandbox`}
            >
              {refreshingSandbox ? "refreshing…" : `→ ${sandboxInfo.catalogVersion}`}
            </button>
          )}
        </div>
      )}

      {/* vault row — which credential bundle was bound into this loop's sandbox.
          Always shows: "default" is the implicit value when meta omits it. */}
      <div className="mt-1 flex items-center gap-1.5 flex-wrap text-[11px]">
        <span className="text-gray-400">vault:</span>
        <ContextChip
          label={meta.config?.vault ?? "default"}
          value="loaded"
        />
      </div>
    </header>
  )
}

/**
 * Toggles meta.public on the loop. When on, shows the /share/<id> URL with a
 * copy button. Only the loop's `createdBy` is allowed to flip the flag —
 * server enforces this too; the button is hidden for non-owners since they
 * can't change it anyway.
 */
function ShareToggle({ meta }: { meta: LoopMeta }) {
  const ws = useWorkspace()
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const isOwner = ws.currentUser?.id === meta.createdBy
  const isPublic = meta.public === true
  if (!ws.currentUser) return null

  const shareUrl = `${location.origin}/loop/${meta.id}`

  const onToggle = async () => {
    if (!isOwner || busy) return
    setBusy(true)
    try {
      await ws.setLoopPublic(meta.id, !isPublic)
    } finally {
      setBusy(false)
    }
  }

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }

  if (!isOwner) {
    // Non-owner: just show a static badge so collaborators can see the state.
    return (
      <span
        title={isPublic ? "this loop is shared publicly" : "this loop is private"}
        className={
          "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] " +
          (isPublic
            ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
            : "bg-gray-100 text-gray-600")
        }
      >
        {isPublic ? <Globe size={11} /> : <Lock size={11} />}
        {isPublic ? "public" : "private"}
      </span>
    )
  }

  return (
    <div className="inline-flex items-center gap-1">
      {isPublic && (
        <button
          type="button"
          onClick={onCopy}
          title={shareUrl}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-gray-600 hover:bg-gray-100"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          <span className="hidden md:inline">{copied ? "copied" : "copy link"}</span>
        </button>
      )}
      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        title={isPublic ? "stop sharing" : "share publicly (anyone with the link can view)"}
        className={
          "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] border disabled:opacity-50 " +
          (isPublic
            ? "bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100"
            : "bg-white text-gray-700 border-gray-300 hover:bg-gray-100")
        }
      >
        {isPublic ? <Globe size={11} /> : <Lock size={11} />}
        {isPublic ? "shared" : "share"}
      </button>
    </div>
  )
}

function ContextChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-100 text-[11px]">
      <span className="text-gray-500">{label}:</span>
      <span className="text-gray-900 font-medium">{value}</span>
    </span>
  )
}

// ============================================================================
// Right panel (info / workdir / editor / terminal) — phase1 RightPanel
// ============================================================================

function RightPanel({
  loopId,
  meta,
  mode,
  onClose,
  pickedFile,
  onPickFile,
  currentUserId,
}: {
  loopId: string
  meta: LoopMeta
  mode: RightMode
  onClose: () => void
  pickedFile: string | null
  onPickFile: (path: string) => void
  currentUserId: string
}) {
  const isMobile = useIsMobile()

  const panel = (
    <aside className="flex-1 min-w-0 bg-white flex flex-col">
      <header className="px-3 h-8 shrink-0 border-b border-gray-200 flex items-center gap-1 text-[11px] text-gray-500">
        <span className="capitalize">{mode}</span>
        {mode === "editor" && (
          <span className="ml-2 truncate text-gray-700">{pickedFile || "(no file)"}</span>
        )}
        <div className="flex-1" />
        <button
          className="text-gray-500 hover:text-gray-900 px-1 rounded hover:bg-gray-100"
          onClick={onClose}
          title="close panel"
        >
          ✕
        </button>
      </header>

      {mode === "info" && <InfoPanel meta={meta} />}

      {mode === "workdir" && (
        <>
          <FileTree loopId={loopId} onPick={onPickFile} picked={pickedFile} />
          <div className="border-t border-gray-200 px-3 py-2 text-[11px] text-gray-500">
            ⑂ <span className="text-gray-900">main</span>
          </div>
        </>
      )}

      <Suspense fallback={<div className="flex-1 flex items-center justify-center text-gray-400 text-sm">Loading...</div>}>
        {mode === "editor" && <Editor loopId={loopId} path={pickedFile} />}
        {mode === "terminal" && (
          <div className="flex-1 min-h-0 bg-[#1a1c20]">
            <Terminal loopId={loopId} currentUserId={currentUserId} />
          </div>
        )}
      </Suspense>
    </aside>
  )

  if (isMobile) {
    return (
      <div className="fixed inset-0 z-40">
        {panel}
      </div>
    )
  }

  return panel
}

function InfoPanel({ meta }: { meta: LoopMeta }) {
  const ws = useWorkspace()
  const isMine = ws.currentUser?.id === meta.createdBy
  return (
    <div className="flex-1 min-h-0 overflow-auto px-5 py-4 text-[13px] text-gray-900">
      <Section label="basics">
        <Row label="title" value={meta.title} />
        <Row label="created" value={new Date(meta.createdAt).toLocaleString()} />
        <Row label="status" value="active" />
        <Row label="driver" value={isMine ? `${meta.createdBy} (you)` : meta.createdBy} />
        <Row label="sharing" value={meta.public ? `public — /loop/${meta.id.slice(0, 8)}…` : "private"} />
      </Section>
      <Section label="workdir">
        <Row label="id" value={meta.id} mono />
        <Row label="path" value={`~/.loopat/loops/${meta.id.slice(0, 8)}/workdir`} mono />
        <Row label="branch" value="main" mono />
      </Section>
      <Section label="context">
        <Row label="knowledge" value="all (ro)" />
        <Row label="notes" value="all (rw)" />
        <Row label="personal" value={`${meta.createdBy} (rw)`} />
      </Section>
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="text-[11px] uppercase tracking-wide text-gray-400 mb-2">{label}</h3>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  )
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[11px] text-gray-500 w-24 shrink-0">{label}</span>
      <span className={mono ? "font-mono text-[12px] text-gray-800 truncate" : "text-[13px] text-gray-900 truncate"}>
        {value}
      </span>
    </div>
  )
}
