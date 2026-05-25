/**
 * Loop tab — AI chat with Claude Code-like experience.
 * Chat area uses assistant-ui runtime with custom claudecodeui-styled components.
 */
import { useEffect, useState, useMemo, Fragment } from "react"
import { createPortal } from "react-dom"
import { useParams, useNavigate, Navigate, useLocation } from "react-router-dom"
import { AssistantRuntimeProvider } from "@assistant-ui/react"
import { PanelLeftClose, PanelLeftOpen, Archive, ArchiveRestore, GitBranch, Globe, Lock, Copy, Check, ChevronDown, Hand, FlaskConical } from "lucide-react"
import { Panel, Group, Separator } from "react-resizable-panels"
import ChatInterface from "@/components/chat/ChatInterface"
import { useWorkspace } from "../ctx"
import { useLoopRuntime, LoopRuntimeProvider } from "../useLoopRuntime"
import { getContext, distillLoop, listProfiles, type ContextMount, type LoopMeta, markLoopViewed } from "../api"
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
  // Wait for loops to finish loading before redirecting — prevents a race
  // where ws.loops is still the initial empty array, causing an incorrect
  // redirect to /loop → first loop.
  if (ws.loopsLoading) return null
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
  const [search, setSearch] = useState("")
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("loopat:loopsList:collapsed") === "1")
  const isMobile = useIsMobile()
  const loopIds = useMemo(() => ws.loops.map(l => l.id), [ws.loops])
  const statusMap = useLoopStatus(loopIds)

  // Auto-mark the current loop as viewed when its status transitions to Done
  // while the user is already on that page (prevents stale yellow dot).
  useEffect(() => {
    const entry = statusMap[currentId]
    if (entry?.status === "Done" && entry?.viewed === false) {
      markLoopViewed(currentId)
    }
  }, [statusMap, currentId])

  const userId = ws.currentUser?.id
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    return ws.loops.filter((loop) => {
      const effective = loop.driver ?? loop.createdBy
      if (scope === "mine" && loop.createdBy !== userId && effective !== userId) return false
      if (scope === "rfd" && !loop.rfdRequestedAt) return false
      if (q && !loop.title.toLowerCase().includes(q) && !loop.id.toLowerCase().includes(q)) return false
      return true
    })
  }, [ws.loops, scope, userId, search])

  const setCollapsedPersist = (v: boolean) => {
    setCollapsed(v)
    localStorage.setItem("loopat:loopsList:collapsed", v ? "1" : "0")
  }

  const sidebarContent = (
    <aside className="w-60 shrink-0 border-r border-gray-200 bg-white flex flex-col h-full">
      <div className="px-2 pt-1.5 pb-1 space-y-1 border-b border-gray-200">
        <div className="flex items-center gap-1">
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
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search loops…"
          className="w-full h-6 rounded px-1.5 text-[11px] bg-gray-100 border border-transparent focus:border-gray-300 focus:bg-white focus:outline-none text-gray-600 placeholder-gray-400"
        />
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
                    {loop.rfdRequestedAt && (
                      <span className="shrink-0 text-[9px] px-1 rounded bg-amber-100 text-amber-800 font-medium tracking-wide">RFD</span>
                    )}
                    <span className="truncate">{loop.title}</span>
                  </div>
                  {entry && (
                    <div className="text-[10px] text-gray-500 truncate mt-0.5">
                      {entry.status}
                    </div>
                  )}
                  <div className="text-[11px] text-gray-500 truncate flex items-center gap-1">
                    <span className="text-gray-400 font-mono text-[10px]">‹›</span>
                    <span>{loop.driver ?? loop.createdBy}</span>
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
                  (isMobile ? "opacity-100" : "opacity-0 group-hover/row:opacity-100") + " transition-opacity w-7 flex items-center justify-center " +
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
  const [fullscreenPanel, setFullscreenPanel] = useState<RightMode | null>(null)
  const [pickedFile, setPickedFile] = useState<string | null>(null)
  const [mounts, setMounts] = useState<ContextMount[]>([])
  // sandboxInfo + refresh-sandbox UI removed — profile model re-composes every spawn,
  // so there's nothing to "refresh" mid-loop.
  const [shareOpen, setShareOpen] = useState(false)
  useEffect(() => {
    getContext(meta.id).then(setMounts)
    markLoopViewed(meta.id)
  }, [meta.id])

  // Kickoff message: when navigated here with router state { kickoff: "..." },
  // auto-send once the WS is connected. Used by the Welcome card to fire the
  // onboarding flow (sends "/loopat:onboarding"). Clear state to prevent re-
  // sending on refresh/back-nav.
  const location = useLocation()
  const navigate = useNavigate()
  const kickoff = (location.state as { kickoff?: string } | null)?.kickoff
  useEffect(() => {
    if (!kickoff || !connected) return
    extra.enqueueMessage(kickoff)
    navigate(location.pathname, { replace: true, state: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kickoff, connected])

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
    setFullscreenPanel((prev) => prev === m ? null : prev)
  }

  const hasPanels = openPanels.length > 0
  const editorPanels = openPanels.filter((m) => m === "editor" || m === "terminal")
  const otherPanels = openPanels.filter((m) => m !== "editor" && m !== "terminal")
  const hasEditorCol = editorPanels.length > 0
  const hasOtherCol = otherPanels.length > 0

  // defaultSize values — used by the library for proportional distribution
  // when panels first mount. Persisted from onLayoutChange after user drags.
  const [chatSize, setChatSize] = useState(() => {
    const n = parseInt(localStorage.getItem("loopat:chatPct") || "", 10)
    return (!isNaN(n) && n >= 10 && n <= 90) ? n : 55
  })
  const [otherSize, setOtherSize] = useState(() => {
    const n = parseInt(localStorage.getItem("loopat:otherPct") || "", 10)
    return (!isNaN(n) && n >= 5 && n <= 50) ? n : 18
  })
  // Read persisted sizes back when panel closes so state stays in sync.
  useEffect(() => {
    if (!hasOtherCol) {
      const n = parseInt(localStorage.getItem("loopat:otherPct") || "", 10)
      if (!isNaN(n) && n >= 5 && n <= 50) setOtherSize(n)
    }
    if (!hasEditorCol && !hasOtherCol) {
      const n = parseInt(localStorage.getItem("loopat:chatPct") || "", 10)
      if (!isNaN(n) && n >= 10 && n <= 90) setChatSize(n)
    }
  }, [hasEditorCol, hasOtherCol])

  const persistLayout = (layout: Record<string, number>) => {
    // Write to localStorage only — no setState during drag to avoid re-render
    // breaking the gesture. State is synced back via useEffect on panel close.
    if (!isNaN(layout.chat) && layout.chat > 0) {
      localStorage.setItem("loopat:chatPct", String(Math.round(layout.chat)))
    }
    if (!isNaN(layout.otherCol) && layout.otherCol > 0) {
      localStorage.setItem("loopat:otherPct", String(Math.round(layout.otherCol)))
    }
  }
  console.log("[layout] render", { hasEditorCol, hasOtherCol, chatSize, otherSize })

  const renderPanel = (mode: RightMode) => {
    if (mode === "git") {
      return <GitDiffSidebar key={mode} loopId={meta.id} onClose={() => closePanel("git")} onPickFile={openFile} />
    }
    const isFullscreen = fullscreenPanel === mode
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
        isFullscreen={isFullscreen}
        onToggleFullscreen={() => setFullscreenPanel(isFullscreen ? null : mode)}
      />
    )
  }

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col">
      <LoopHeader
        meta={meta}
        mounts={mounts}
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
                repo={meta.repo}
                branch={meta.branch}
                title={meta.title}
                driver={meta.driver ?? meta.createdBy}
                driverHistory={meta.driverHistory}
                rfdRequestedAt={meta.rfdRequestedAt}
                rfdRequestedBy={meta.rfdRequestedBy}
                onTakeDrive={() => ws.takeDrive(meta.id)}
              />
            </AssistantRuntimeProvider>
          </LoopRuntimeProvider>
        </div>
      ) : hasPanels ? (
        <Group orientation="horizontal" className="flex-1 min-w-0 min-h-0"
          onLayoutChange={persistLayout}
        >
          <Panel id="chat" minSize={20} defaultSize={chatSize}
            className="flex flex-col min-h-0 min-w-0"
          >
            <LoopRuntimeProvider extra={extra}>
              <AssistantRuntimeProvider runtime={runtime}>
                <ChatInterface
                  archived={meta.archived === true}
                  onUnarchive={() => ws.setLoopArchived(meta.id, false)}
                  repo={meta.repo}
                  branch={meta.branch}
                  title={meta.title}
                  driver={meta.driver ?? meta.createdBy}
                  driverHistory={meta.driverHistory}
                  rfdRequestedAt={meta.rfdRequestedAt}
                  rfdRequestedBy={meta.rfdRequestedBy}
                  onTakeDrive={() => ws.takeDrive(meta.id)}
                />
              </AssistantRuntimeProvider>
            </LoopRuntimeProvider>
          </Panel>

          {(hasEditorCol || hasOtherCol) && <Separator className="relative w-4 -mx-1.5 cursor-col-resize group flex items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-gray-200 after:transition-colors hover:after:bg-blue-400">
            <div className="absolute top-1/2 -translate-y-1/2 h-8 w-1.5 rounded-full bg-gray-300 group-hover:bg-blue-400 transition-colors" />
          </Separator>}

          {hasEditorCol && (
            <Panel id="editorCol" minSize={15} defaultSize={30} className="flex flex-col min-h-0 min-w-0">
              {editorPanels.length > 1 ? (
                <Group orientation="vertical" className="flex-1 min-h-0">
                  {editorPanels.map((mode, i) => (
                    <Fragment key={mode}>
                      {i > 0 && <Separator className="relative h-4 -my-1.5 cursor-row-resize group flex items-center justify-center after:absolute after:left-0 after:right-0 after:top-1/2 after:h-px after:-translate-y-1/2 after:bg-gray-200 after:transition-colors hover:after:bg-blue-400">
                        <div className="absolute left-1/2 -translate-x-1/2 w-8 h-1.5 rounded-full bg-gray-300 group-hover:bg-blue-400 transition-colors" />
                      </Separator>}
                      <Panel id={mode} minSize={10} defaultSize={100 / editorPanels.length} className="flex flex-col min-h-0 min-w-0">
                        {renderPanel(mode)}
                      </Panel>
                    </Fragment>
                  ))}
                </Group>
              ) : (
                renderPanel(editorPanels[0])
              )}
            </Panel>
          )}

          {(hasEditorCol && hasOtherCol) && <Separator className="relative w-4 -mx-1.5 cursor-col-resize group flex items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-gray-200 after:transition-colors hover:after:bg-blue-400">
            <div className="absolute top-1/2 -translate-y-1/2 h-8 w-1.5 rounded-full bg-gray-300 group-hover:bg-blue-400 transition-colors" />
          </Separator>}

          {hasOtherCol && (
            <Panel id="otherCol" minSize={15} defaultSize={otherSize}
              className="flex flex-col min-h-0 min-w-0"
            >
              {otherPanels.length > 1 ? (
                <Group orientation="vertical" className="flex-1 min-h-0">
                  {otherPanels.map((mode, i) => (
                    <Fragment key={mode}>
                      {i > 0 && <Separator className="relative h-4 -my-1.5 cursor-row-resize group flex items-center justify-center after:absolute after:left-0 after:right-0 after:top-1/2 after:h-px after:-translate-y-1/2 after:bg-gray-200 after:transition-colors hover:after:bg-blue-400">
                        <div className="absolute left-1/2 -translate-x-1/2 w-8 h-1.5 rounded-full bg-gray-300 group-hover:bg-blue-400 transition-colors" />
                      </Separator>}
                      <Panel id={mode} minSize={10} defaultSize={100 / otherPanels.length} className="flex flex-col min-h-0 min-w-0">
                        {renderPanel(mode)}
                      </Panel>
                    </Fragment>
                  ))}
                </Group>
              ) : (
                renderPanel(otherPanels[0])
              )}
            </Panel>
          )}
        </Group>
      ) : (
        <div className="flex-1 min-h-0">
          <LoopRuntimeProvider extra={extra}>
            <AssistantRuntimeProvider runtime={runtime}>
              <ChatInterface
                archived={meta.archived === true}
                onUnarchive={() => ws.setLoopArchived(meta.id, false)}
                repo={meta.repo}
                branch={meta.branch}
                title={meta.title}
                driver={meta.driver ?? meta.createdBy}
                driverHistory={meta.driverHistory}
                rfdRequestedAt={meta.rfdRequestedAt}
                rfdRequestedBy={meta.rfdRequestedBy}
                onTakeDrive={() => ws.takeDrive(meta.id)}
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
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const ws = useWorkspace()
  const [collapsed, setCollapsed] = useState(isMobile)
  const [distilling, setDistilling] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(meta.title)
  const canEditTitle = ws.currentUser?.id === meta.createdBy
  const onDistill = async () => {
    if (distilling) return
    setDistilling(true)
    try {
      const child = await distillLoop(meta.id)
      if (child) navigate(`/loop/${child.id}`)
    } finally {
      setDistilling(false)
    }
  }
  const saveTitle = async () => {
    const next = titleDraft.trim()
    if (!next || next === meta.title) { setEditingTitle(false); setTitleDraft(meta.title); return }
    setEditingTitle(false)
    const updated = await ws.setLoopTitle(meta.id, next)
    if (!updated) setTitleDraft(meta.title)
  }
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
    <header className={"group/header px-3 md:px-5 shrink-0 border-b border-gray-200 " + (collapsed ? "py-1.5" : "pt-3 pb-2")}>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="text-gray-400 hover:text-gray-700 -ml-1 p-0.5 rounded hover:bg-gray-100"
          title={collapsed ? "expand header" : "collapse header"}
        >
          <ChevronDown size={14} className={"transition-transform " + (collapsed ? "-rotate-90" : "")} />
        </button>
        {editingTitle ? (
          <input
            type="text"
            value={titleDraft}
            autoFocus
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); saveTitle() }
              else if (e.key === "Escape") { e.preventDefault(); setEditingTitle(false); setTitleDraft(meta.title) }
            }}
            onBlur={saveTitle}
            maxLength={200}
            className="text-[14px] md:text-[15px] font-medium text-gray-900 bg-white border border-blue-400 rounded px-1 py-0 outline-none min-w-[120px]"
          />
        ) : (
          <span
            className={"text-[14px] md:text-[15px] font-medium text-gray-900 " + (canEditTitle ? "cursor-pointer hover:bg-gray-100 rounded px-1 -mx-1" : "")}
            onClick={() => { if (canEditTitle) { setTitleDraft(meta.title); setEditingTitle(true) } }}
            title={canEditTitle ? "click to rename" : undefined}
          >
            {meta.title}
          </span>
        )}
        <span className="text-xs text-gray-500">
          driver: <span className="text-gray-900">{meta.driver ?? meta.createdBy}</span>
        </span>
        {meta.rfdRequestedAt && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200 font-medium tracking-wide"
            title={`released for drive by ${meta.rfdRequestedBy ?? "?"} at ${meta.rfdRequestedAt}`}
          >
            RFD
          </span>
        )}
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
          type="button"
          onClick={onDistill}
          disabled={distilling}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] border bg-white text-violet-700 border-violet-300 hover:bg-violet-50 disabled:opacity-50"
          title="Spawn a child loop seeded with this loop's conversation, for sedimenting reusable insights into knowledge/"
        >
          <FlaskConical size={11} />
          {distilling ? "Distilling…" : "Distill"}
        </button>
        <button
          onClick={onShareWork}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] border ${meta.shareEnabled ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-100"}`}
          title="Share workspace artifact (static files or port forward)"
        >
          <Globe size={11} />
          Share Artifact
        </button>
        <DriveToggle meta={meta} />
        <ShareToggle meta={meta} />
      </div>

      {!collapsed && (
      <>
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

      {/* profile row — which profiles are active. Profile model re-composes
          on every spawn, so no "update available" prompt is needed. Each
          chip shows the profile's description (from CLAUDE.md frontmatter
          or first heading) as a hover tooltip. */}
      {meta.config?.profiles && meta.config.profiles.length > 0 && (
        <ProfileChipsRow profiles={meta.config.profiles as string[]} />
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
      </>
      )}
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

// "Request For Drive" / "Drive" — driver handoff. Driver releases the loop
// for grabs (sandbox is torn down server-side, history kept); any authed
// user can then claim it. The new driver's personal config (apiKey, vault)
// takes over on the next user message.
function DriveToggle({ meta }: { meta: LoopMeta }) {
  const ws = useWorkspace()
  const [busy, setBusy] = useState(false)
  if (!ws.currentUser) return null
  const effectiveDriver = meta.driver ?? meta.createdBy
  const isDriver = ws.currentUser.id === effectiveDriver
  const isRfd = !!meta.rfdRequestedAt

  if (isRfd) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try { await ws.takeDrive(meta.id) } finally { setBusy(false) }
        }}
        title={`released for drive by ${meta.rfdRequestedBy ?? "?"} — click to take over`}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] border bg-amber-500 text-white border-amber-600 hover:bg-amber-600 disabled:opacity-50"
      >
        <Hand size={11} />
        Drive
      </button>
    )
  }

  if (!isDriver) return null

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        if (!window.confirm("Request For Drive: this will tear down the sandbox and release the loop so anyone else can take over. Continue?")) return
        setBusy(true)
        try { await ws.requestDrive(meta.id) } finally { setBusy(false) }
      }}
      title="Release this loop so someone else can drive it"
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] border bg-white text-amber-700 border-amber-300 hover:bg-amber-50 disabled:opacity-50"
    >
      <Hand size={11} />
      Request For Drive
    </button>
  )
}

function ContextChip({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-100 text-[11px]"
      title={title}
    >
      <span className="text-gray-500">{label}:</span>
      <span className="text-gray-900 font-medium">{value}</span>
    </span>
  )
}

/** Profile chips row — fetches descriptions once and surfaces them via
 *  native hover tooltips on each chip. */
function ProfileChipsRow({ profiles }: { profiles: string[] }) {
  const [desc, setDesc] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    listProfiles().then((all) => {
      if (cancelled) return
      const map: Record<string, string> = {}
      for (const p of all) {
        if (p.description) map[p.name] = p.description
      }
      setDesc(map)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  return (
    <div className="mt-1 flex items-center gap-1.5 flex-wrap text-[11px]">
      <span className="text-gray-400">profiles:</span>
      {profiles.map((p) => (
        <ContextChip key={p} label={p} value="active" title={desc[p]} />
      ))}
    </div>
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
  isFullscreen,
  onToggleFullscreen,
}: {
  loopId: string
  meta: LoopMeta
  mode: RightMode
  onClose: () => void
  pickedFile: string | null
  onPickFile: (path: string) => void
  currentUserId: string
  isFullscreen?: boolean
  onToggleFullscreen?: () => void
}) {
  const isMobile = useIsMobile()

  const header = (
    <header className="px-3 h-8 shrink-0 border-b border-gray-200 flex items-center gap-1 text-[11px] text-gray-500">
      <span className="capitalize">{mode}</span>
      {mode === "editor" && (
        <span className="ml-2 truncate text-gray-700">{pickedFile || "(no file)"}</span>
      )}
      <div className="flex-1" />
      {(mode === "editor" || mode === "terminal") && (
        <button
          className="text-gray-400 hover:text-gray-700 px-1 rounded hover:bg-gray-100"
          onClick={onToggleFullscreen}
          title={isFullscreen ? "restore" : "maximize"}
        >
          {isFullscreen ? "⤓" : "⤢"}
        </button>
      )}
      <button
        className="text-gray-500 hover:text-gray-900 px-1 rounded hover:bg-gray-100"
        onClick={onClose}
        title="close panel"
      >
        ✕
      </button>
    </header>
  )

  const panel = (
    <aside className="flex-1 min-w-0 bg-white flex flex-col">
      {header}

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
          <div className="flex-1 min-h-0 bg-[#1a1c20] overflow-auto">
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

  if (isFullscreen) {
    return createPortal(
      <div className="fixed inset-0 z-50 flex flex-col">
        {panel}
      </div>,
      document.body,
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
