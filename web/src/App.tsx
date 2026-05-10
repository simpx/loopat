/**
 * Top-level shell. Ports phase1-prototype/src/App.tsx layout literally —
 * top bar (brand + tab nav + new-loop + user widget) + <Outlet /> for the
 * current tab's page. Routing via react-router v7.
 */
import { useEffect, useRef, useState } from "react"
import { BrowserRouter, Routes, Route, Navigate, NavLink, Outlet, useNavigate } from "react-router-dom"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useWorkspaceState, type WorkspaceState } from "./state"
import { WorkspaceCtx } from "./ctx"
import { NewLoopDialog } from "./components/dialog/NewLoopDialog"
import { LoopPage } from "./pages/LoopPage"
import { FocusPage } from "./pages/FocusPage"
import { ContextPage } from "./pages/ContextPage"

const WORKSPACE_NAME = "loopat"
const ME = "simpx"

const TABS = [
  { id: "loop", label: "Loop", icon: "⑂" },
  { id: "focus", label: "Focus", icon: "◉" },
  { id: "context", label: "Context", icon: "⌘" },
] as const

function Layout() {
  const ws = useWorkspaceState()
  return (
    <WorkspaceCtx.Provider value={ws}>
      <Shell ws={ws} />
    </WorkspaceCtx.Provider>
  )
}

function Shell({ ws }: { ws: WorkspaceState }) {
  const navigate = useNavigate()
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const workspaceRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (workspaceRef.current && !workspaceRef.current.contains(e.target as Node)) {
        setWorkspaceMenuOpen(false)
      }
    }
    document.addEventListener("click", onDocClick)
    return () => document.removeEventListener("click", onDocClick)
  }, [])

  const handleCreate = async (opts: { title: string; repo?: string }) => {
    const m = await ws.createLoop(opts)
    ws.setNewLoopDialogOpen(false)
    navigate(`/loop/${m.id}`)
    return m.id
  }

  return (
    <div className="h-full w-full flex flex-col bg-gray-50 text-gray-900">
      <header className="h-12 shrink-0 border-b border-gray-200 bg-white flex items-center px-4 gap-4">
        <div className="relative shrink-0" ref={workspaceRef}>
          <button
            type="button"
            onClick={() => setWorkspaceMenuOpen(!workspaceMenuOpen)}
            className={
              workspaceMenuOpen
                ? "flex items-center gap-2 px-2 h-8 rounded bg-gray-100"
                : "flex items-center gap-2 px-2 h-8 rounded hover:bg-gray-100"
            }
            title="workspace"
          >
            <span className="text-lg leading-none">🧶</span>
            <span className="text-sm text-gray-900 font-medium">{WORKSPACE_NAME}</span>
            <span className="text-gray-400 text-xs">{workspaceMenuOpen ? "▴" : "▾"}</span>
          </button>
          {workspaceMenuOpen && (
            <div className="absolute left-0 top-full mt-1 w-72 bg-white border border-gray-200 rounded-md shadow-lg z-50 text-[13px]">
              <div className="px-3 py-2.5 border-b border-gray-100">
                <div className="flex items-center gap-2">
                  <span className="text-base">🧶</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-gray-900 font-medium">{WORKSPACE_NAME}</div>
                    <div className="text-[11px] text-gray-500">single-user</div>
                  </div>
                </div>
              </div>
              <button
                type="button"
                disabled
                className="w-full px-3 py-2 text-left flex items-center gap-2 text-gray-400 cursor-default"
                title="future: multi-workspace via subdomain"
              >
                <span>↪</span>
                <span>switch workspace</span>
              </button>
            </div>
          )}
        </div>
        <nav className="flex items-center gap-1">
          {TABS.map((t) => (
            <NavLink
              key={t.id}
              to={`/${t.id}`}
              className={({ isActive }) =>
                isActive
                  ? "px-3 h-8 rounded text-sm bg-gray-900 text-white flex items-center gap-1.5"
                  : "px-3 h-8 rounded text-sm text-gray-600 hover:bg-gray-100 flex items-center gap-1.5"
              }
            >
              <span className="opacity-70">{t.icon}</span>
              <span>{t.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => ws.setNewLoopDialogOpen(true)}
          className="flex items-center gap-1.5 px-3 h-8 rounded text-sm bg-gray-900 text-white hover:bg-gray-700"
          title="create new loop"
        >
          <span className="text-base leading-none">+</span>
          <span>New Loop</span>
        </button>
        <button
          type="button"
          className="flex items-center gap-2 px-2 h-8 rounded hover:bg-gray-100"
          title="account"
        >
          <span className="w-6 h-6 rounded-full bg-gray-900 text-white text-xs flex items-center justify-center">
            {ME[0].toUpperCase()}
          </span>
          <span className="text-sm text-gray-700">{ME}</span>
          <span className="text-gray-400 text-xs">▾</span>
        </button>
      </header>
      <main className="flex-1 min-h-0 min-w-0 overflow-hidden">
        <Outlet />
      </main>
      {ws.newLoopDialogOpen && (
        <NewLoopDialog onClose={() => ws.setNewLoopDialogOpen(false)} onCreate={handleCreate} />
      )}
    </div>
  )
}

function LoopRedirect() {
  const ws = useWorkspaceState()
  if (ws.loops.length === 0) return <LoopEmpty onNew={() => ws.setNewLoopDialogOpen(true)} />
  return <Navigate to={`/loop/${ws.loops[0].id}`} replace />
}

function LoopEmpty({ onNew }: { onNew: () => void }) {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center text-gray-500 gap-3">
      <div>no loops yet</div>
      <button
        onClick={onNew}
        className="px-3 h-8 rounded text-sm bg-gray-900 text-white hover:bg-gray-700"
      >
        + New Loop
      </button>
    </div>
  )
}

export function App() {
  return (
    <TooltipProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Navigate to="/loop" replace />} />
            <Route path="/loop" element={<LoopRedirect />} />
            <Route path="/loop/:id" element={<LoopPage />} />
            <Route path="/focus" element={<FocusPage />} />
            <Route path="/context" element={<Navigate to="/context/knowledge" replace />} />
            <Route path="/context/:sub" element={<ContextPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  )
}
