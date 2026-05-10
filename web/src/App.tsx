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
import { AuthPage } from "./pages/AuthPage"
import { getServerWorkspace } from "./api"

const TABS = [
  { id: "loop", label: "Loop", icon: "⑂" },
  { id: "focus", label: "Focus", icon: "◉" },
  { id: "context", label: "Context", icon: "⌘" },
] as const

function Layout() {
  const ws = useWorkspaceState()
  return (
    <WorkspaceCtx.Provider value={ws}>
      {ws.authLoading ? null : <Shell ws={ws} />}
    </WorkspaceCtx.Provider>
  )
}

function Shell({ ws }: { ws: WorkspaceState }) {
  const navigate = useNavigate()
  const [workspaceName, setWorkspaceName] = useState("loopat")
  const [menuOpen, setMenuOpen] = useState(false)
  const [authOpen, setAuthOpen] = useState(false)
  const me = ws.currentUser?.id ?? ""
  const loggedIn = !!ws.currentUser

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
        {loggedIn && (
          <button
            type="button"
            onClick={() => ws.setNewLoopDialogOpen(true)}
            className="flex items-center gap-1.5 px-3 h-8 rounded text-sm bg-gray-900 text-white hover:bg-gray-700"
            title="create new loop"
          >
            <span className="text-base leading-none">+</span>
            <span>New Loop</span>
          </button>
        )}
        {loggedIn ? (
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="flex items-center gap-2 px-2 h-8 rounded hover:bg-gray-100"
              title="account"
            >
              <span className="w-6 h-6 rounded-full bg-gray-900 text-white text-xs flex items-center justify-center">
                {me[0]?.toUpperCase() ?? "?"}
              </span>
              <span className="text-sm text-gray-700">{me}</span>
              <span className="text-gray-400 text-xs">▾</span>
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-20 w-32 bg-white border border-gray-200 rounded shadow-md py-1">
                  <button
                    type="button"
                    onClick={async () => {
                      setMenuOpen(false)
                      await ws.logout()
                      navigate("/loop")
                    }}
                    className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
                  >
                    Logout
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAuthOpen(true)}
            className="px-3 h-8 rounded text-sm border border-gray-300 text-gray-700 hover:bg-gray-100"
            title="login or register"
          >
            Login
          </button>
        )}
      </header>
      <main className="flex-1 min-h-0 min-w-0 overflow-hidden">
        <Outlet />
      </main>
      {ws.newLoopDialogOpen && loggedIn && (
        <NewLoopDialog onClose={() => ws.setNewLoopDialogOpen(false)} onCreate={handleCreate} />
      )}
      {authOpen && <AuthPage onClose={() => setAuthOpen(false)} />}
    </div>
  )
}

function LoopRedirect() {
  const ws = useWorkspaceState()
  if (ws.loops.length === 0) {
    return <LoopEmpty loggedIn={!!ws.currentUser} onNew={() => ws.setNewLoopDialogOpen(true)} />
  }
  return <Navigate to={`/loop/${ws.loops[0].id}`} replace />
}

function LoopEmpty({ loggedIn, onNew }: { loggedIn: boolean; onNew: () => void }) {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center text-gray-500 gap-3">
      <div>no loops yet</div>
      {loggedIn ? (
        <button
          onClick={onNew}
          className="px-3 h-8 rounded text-sm bg-gray-900 text-white hover:bg-gray-700"
        >
          + New Loop
        </button>
      ) : (
        <div className="text-xs text-gray-400">log in to create one</div>
      )}
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
