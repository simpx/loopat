/**
 * Top-level shell. Single workspace per loopat instance — no workspace
 * prefix in URL, no workspace switcher. The header just shows the
 * workspace name fetched once from /api/health (which is basename of
 * LOOPAT_HOME, server-side).
 */
import { useEffect, useState } from "react"
import { BrowserRouter, Routes, Route, Navigate, NavLink, Outlet, useNavigate } from "react-router-dom"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useWorkspaceState, type WorkspaceState } from "./state"
import { WorkspaceCtx } from "./ctx"
import { NewLoopDialog } from "./components/dialog/NewLoopDialog"
import { LoopPage } from "./pages/LoopPage"
import { FocusPage } from "./pages/FocusPage"
import { ContextPage } from "./pages/ContextPage"
import { getServerWorkspace } from "./api"

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
  const [workspaceName, setWorkspaceName] = useState("loopat")

  useEffect(() => {
    getServerWorkspace().then((name) => {
      if (name) {
        setWorkspaceName(name)
        document.title = `${name} · loopat`
      }
    })
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
        <div className="flex items-center gap-2 px-2 h-8 shrink-0" title={`workspace: ${workspaceName}`}>
          <span className="text-lg leading-none">🧶</span>
          <span className="text-sm text-gray-900 font-medium">{workspaceName}</span>
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
