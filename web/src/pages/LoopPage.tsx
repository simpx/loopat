/**
 * Loop tab. Layout & visuals ported from phase1-prototype/src/pages/loop.tsx
 * (LoopsList + LoopHeader + RightPanel). Chat area uses assistant-ui's
 * prebuilt Thread (kept to avoid re-building chat + markdown rendering).
 */
import { useEffect, useState } from "react"
import { useParams, useNavigate, Navigate } from "react-router-dom"
import { AssistantRuntimeProvider } from "@assistant-ui/react"
import { Thread } from "@/components/assistant-ui/thread"
import { useWorkspace } from "../ctx"
import { useLoopRuntime } from "../useLoopRuntime"
import { getContext, type ContextMount, type LoopMeta } from "../api"
import { FileTree } from "../FileTree"
import { Editor } from "../Editor"
import { Terminal } from "../Terminal"

type RightMode = "info" | "workdir" | "editor" | "terminal"
const ME = "simpx"

export function LoopPage() {
  const { id } = useParams<{ id: string }>()
  const ws = useWorkspace()

  if (!id) return <Navigate to={`/loop`} replace />
  const meta = ws.loops.find((l) => l.id === id)
  if (!meta) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500">
        loop {id.slice(0, 8)} not found
      </div>
    )
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

  // single-user MVP — "我的" / "全部" filter both show everything; RFD always 0
  const filtered = ws.loops

  return (
    <aside className="w-60 shrink-0 border-r border-gray-200 bg-white flex flex-col">
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
            {s === "mine" ? "我的" : s === "all" ? "全部" : "RFD"}
          </button>
        ))}
        <span className="text-[11px] text-gray-400 ml-auto pr-1">{filtered.length}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto py-2">
        {filtered.map((loop) => {
          const sel = currentId === loop.id
          return (
            <button
              key={loop.id}
              type="button"
              onClick={() => navigate(`/loop/${loop.id}`)}
              className={
                sel
                  ? "w-full px-3 py-2 flex items-center gap-2 text-left bg-gray-100"
                  : "w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-gray-50"
              }
            >
              <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-emerald-500" />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-gray-900 truncate">{loop.title}</div>
                <div className="text-[11px] text-gray-500 truncate flex items-center gap-1">
                  <span className="text-gray-400 font-mono text-[10px]">‹›</span>
                  <span>{ME}</span>
                  <span>·</span>
                  <span className="font-mono">{loop.id.slice(0, 6)}</span>
                </div>
              </div>
            </button>
          )
        })}
        {filtered.length === 0 && (
          <div className="px-3 py-4 text-[12px] text-gray-400 italic">no loops · click "+ New Loop"</div>
        )}
      </div>
    </aside>
  )
}

// ============================================================================
// Loop main (chat + header + right panel)
// ============================================================================

function LoopMain({ meta }: { meta: LoopMeta }) {
  const { runtime, connected, reconnecting, running, viewers } = useLoopRuntime(meta.id)
  const [rightOpen, setRightOpen] = useState(false)
  const [rightMode, setRightMode] = useState<RightMode>("workdir")
  const [pickedFile, setPickedFile] = useState<string | null>(null)
  const [mounts, setMounts] = useState<ContextMount[]>([])

  useEffect(() => {
    getContext(meta.id).then(setMounts)
  }, [meta.id])

  const toggleMode = (m: RightMode) => {
    if (rightOpen && rightMode === m) setRightOpen(false)
    else {
      setRightOpen(true)
      setRightMode(m)
    }
  }

  const openFile = (path: string) => {
    setPickedFile(path)
    setRightOpen(true)
    setRightMode("editor")
  }

  return (
    <div className="flex-1 min-w-0 min-h-0 flex">
      <main className="flex-1 min-w-0 flex flex-col bg-white min-h-0">
        <LoopHeader
          meta={meta}
          mounts={mounts}
          connected={connected}
          reconnecting={reconnecting}
          running={running}
          viewers={viewers}
          rightOpen={rightOpen}
          rightMode={rightMode}
          toggleMode={toggleMode}
        />
        <div className="flex-1 min-h-0">
          <AssistantRuntimeProvider runtime={runtime}>
            <Thread />
          </AssistantRuntimeProvider>
        </div>
      </main>
      {rightOpen && (
        <RightPanel
          loopId={meta.id}
          meta={meta}
          mode={rightMode}
          onClose={() => setRightOpen(false)}
          pickedFile={pickedFile}
          onPickFile={openFile}
        />
      )}
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
  rightOpen,
  rightMode,
  toggleMode,
}: {
  meta: LoopMeta
  mounts: ContextMount[]
  connected: boolean
  reconnecting: boolean
  running: boolean
  viewers: number
  rightOpen: boolean
  rightMode: RightMode
  toggleMode: (m: RightMode) => void
}) {
  const modeBtn = (label: string, m: RightMode) => (
    <button
      key={m}
      className={
        rightOpen && rightMode === m
          ? "px-2 py-0.5 rounded bg-gray-100 text-gray-900"
          : "px-2 py-0.5 rounded text-gray-500 hover:text-gray-900 hover:bg-gray-50"
      }
      onClick={() => toggleMode(m)}
    >
      {label}
    </button>
  )
  return (
    <header className="px-5 pt-3 pb-2 shrink-0 border-b border-gray-200">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[15px] font-medium text-gray-900">{meta.title}</span>
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        <span className="text-xs text-gray-500">
          driver: <span className="text-gray-900">{ME}</span>
        </span>
        <span
          className={
            "text-[11px] " +
            (connected
              ? "text-emerald-600"
              : reconnecting
                ? "text-amber-500"
                : "text-red-500")
          }
          title={
            connected
              ? "ws connected"
              : reconnecting
                ? "reconnecting…"
                : "disconnected"
          }
        >
          ●
        </span>
        {!connected && reconnecting && (
          <span className="text-[11px] text-amber-600">reconnecting…</span>
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
        </div>
      </div>

      {/* context chips */}
      <div className="mt-2 flex items-center gap-1.5 flex-wrap text-[11px]">
        <span className="text-gray-400">context:</span>
        {mounts.map((m) => (
          <ContextChip key={m.path} label={m.name} value={m.name === "knowledge" ? "ro" : "rw"} />
        ))}
      </div>
    </header>
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
}: {
  loopId: string
  meta: LoopMeta
  mode: RightMode
  onClose: () => void
  pickedFile: string | null
  onPickFile: (path: string) => void
}) {
  return (
    <aside className="flex-1 min-w-0 border-l border-gray-200 bg-white flex flex-col">
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

      {mode === "editor" && <Editor loopId={loopId} path={pickedFile} />}

      {mode === "terminal" && (
        <div className="flex-1 min-h-0 bg-[#1a1c20]">
          <Terminal loopId={loopId} />
        </div>
      )}
    </aside>
  )
}

function InfoPanel({ meta }: { meta: LoopMeta }) {
  return (
    <div className="flex-1 min-h-0 overflow-auto px-5 py-4 text-[13px] text-gray-900">
      <Section label="basics">
        <Row label="title" value={meta.title} />
        <Row label="created" value={new Date(meta.createdAt).toLocaleString()} />
        <Row label="status" value="active" />
        <Row label="driver" value={`${ME} (you)`} />
      </Section>
      <Section label="workdir">
        <Row label="id" value={meta.id} mono />
        <Row label="path" value={`~/.loopat/loops/${meta.id.slice(0, 8)}/workdir`} mono />
        <Row label="branch" value="main" mono />
      </Section>
      <Section label="context">
        <Row label="knowledge" value="all (ro)" />
        <Row label="notes" value="all (rw)" />
        <Row label="personal" value="simpx (rw)" />
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
