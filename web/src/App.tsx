/**
 * Top-level shell. Single workspace per loopat instance — no workspace
 * prefix in URL, no workspace switcher. The header just shows the
 * workspace name fetched once from /api/health (which is basename of
 * LOOPAT_HOME, server-side).
 */
import { useEffect, useState } from "react"
import { MessageCircle } from "lucide-react"
import { BrowserRouter, Routes, Route, Navigate, NavLink, Outlet, useNavigate, useMatch, useLocation } from "react-router-dom"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useWorkspaceState, type WorkspaceState } from "./state"
import { WorkspaceCtx } from "./ctx"
import { NewLoopDialog } from "./components/dialog/NewLoopDialog"
import { AboutDialog } from "./components/dialog/AboutDialog"
import { AdminDialog } from "./components/dialog/AdminDialog"
import { LoopPage } from "./pages/LoopPage"

import { TopicView } from "./pages/TopicView"
import { ContextPage } from "./pages/ContextPage"
import { KanbanPage } from "./pages/KanbanPage"
import { ChatPage } from "./pages/ChatPage"
import { SettingsPage } from "./pages/SettingsPage"
import { AuthPage } from "./pages/AuthPage"
import { FloatingDm } from "./components/FloatingDm"
import { getServerWorkspace, getVersion, getBuildInfo, linkKanbanLoop } from "./api"
import { useChatUnreadTitle } from "./useChatUnreadTitle"

const TABS = [
  { id: "loop", label: "Loop", icon: "⑂" },

  { id: "kanban", label: "Kanban", icon: "☰" },
  { id: "context", label: "Context", icon: "⌘" },
  { id: "chat", label: "Chat", icon: <MessageCircle size={14} /> },
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
  const location = useLocation()
  const [workspaceName, setWorkspaceName] = useState("loopat")
  const [menuOpen, setMenuOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [adminOpen, setAdminOpen] = useState(false)
  const me = ws.currentUser?.id ?? ""
  const isAdmin = ws.currentUser?.role === "admin"
  const loggedIn = !!ws.currentUser
  const onLoopRoute = !!useMatch("/loop/:id")
  const onChatRoute = location.pathname.startsWith("/chat")
  // Anonymous viewers on a loop URL get the "shared" experience: no header,
  // no tabs, no login affordance, no dialogs. The page itself enforces
  // meta.public via server gating; if it's not public the page renders its
  // own "unavailable" state.
  const shareMode = !loggedIn && onLoopRoute

  useEffect(() => {
    if (shareMode) return
    getServerWorkspace().then((name) => {
      if (name) {
        setWorkspaceName(name)
        // Base title. When logged in, useChatUnreadTitle below re-fires on
        // workspaceName change and either re-sets the same string (no unread)
        // or prefixes "(N) ". The two effects don't fight — last write
        // wins per state change, and the hook always runs after.
        document.title = `${name} · loopat`
      }
    })
  }, [shareMode])

  useChatUnreadTitle(workspaceName, loggedIn && !shareMode)

  useEffect(() => {
    if (shareMode) return
    const build = getBuildInfo()
    getVersion().then((v) => {
      console.log(
        `%cloopat %cserver:%c ${v.branch}@${v.commit.slice(0, 7)} %cbuild:%c ${build.commit.slice(0, 7)} @ ${build.time}`,
        "font-weight:bold",
        "color:#666",
        "color:#61afef",
        "color:#666",
        "color:#98c379",
      )
    })
  }, [shareMode])

  if (shareMode) {
    return (
      <div className="h-full w-full bg-white text-gray-900">
        <Outlet />
      </div>
    )
  }

  // Anyone not on a (shared) loop URL must be logged in. Show the login page
  // as the entire screen — no header, no tabs, no nav. Successful login
  // re-renders the Shell with the normal chrome.
  if (!loggedIn) {
    return <AuthPage />
  }

  const handleCreate = async (opts: { title: string; repo?: string; sandbox?: string; vault?: string }) => {
    const m = await ws.createLoop(opts)
    if (ws.kanbanCreateCtx) {
      await linkKanbanLoop(ws.kanbanCreateCtx.filename, ws.kanbanCreateCtx.cid, m.id)
    }
    ws.setNewLoopDialogOpen(false)
    navigate(`/loop/${m.id}`)
    return m.id
  }

  return (
    <div className="h-full w-full flex flex-col bg-gray-50 text-gray-900">
      <header className="h-12 shrink-0 border-b border-gray-200 bg-white flex items-center px-2 md:px-4 gap-2 md:gap-4">
        <div className="flex items-center gap-2 px-1 md:px-2 h-8 shrink-0" title={`workspace: ${workspaceName}`}>
          <span className="text-lg leading-none">🧶</span>
          <span className="hidden md:inline text-sm text-gray-900 font-medium">{workspaceName}</span>
        </div>
        <nav className="flex items-center gap-0.5 md:gap-1">
          {TABS.map((t) => (
            <NavLink
              key={t.id}
              to={`/${t.id}`}
              className={({ isActive }) =>
                isActive
                  ? "px-2 md:px-3 h-8 rounded text-sm bg-gray-900 text-white flex items-center gap-1.5"
                  : "px-2 md:px-3 h-8 rounded text-sm text-gray-600 hover:bg-gray-100 flex items-center gap-1.5"
              }
            >
              <span className="opacity-70">{t.icon}</span>
              <span className="hidden md:inline">{t.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => ws.setNewLoopDialogOpen(true)}
          className="flex items-center gap-1 md:gap-1.5 px-2 md:px-3 h-8 rounded text-sm bg-gray-900 text-white hover:bg-gray-700"
          title="create new loop"
        >
          <span className="text-base leading-none">+</span>
          <span className="hidden md:inline">New Loop</span>
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-1 md:gap-2 px-1 md:px-2 h-8 rounded hover:bg-gray-100"
            title="account"
          >
            <span className="w-6 h-6 rounded-full bg-gray-900 text-white text-xs flex items-center justify-center">
              {me[0]?.toUpperCase() ?? "?"}
            </span>
            <span className="hidden md:inline text-sm text-gray-700">{me}</span>
            <span className="text-gray-400 text-xs">▾</span>
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-20 w-40 bg-white border border-gray-200 rounded shadow-md py-1">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    navigate("/settings")
                  }}
                  className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
                >
                  Settings
                </button>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false)
                      setAdminOpen(true)
                    }}
                    className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
                  >
                    Admin
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    setAboutOpen(true)
                  }}
                  className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
                >
                  About
                </button>
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
      </header>
      <main className="flex-1 min-h-0 min-w-0 overflow-hidden">
        <Outlet />
      </main>
      {ws.newLoopDialogOpen && (
        <NewLoopDialog onClose={() => ws.setNewLoopDialogOpen(false)} onCreate={handleCreate} initialTitle={ws.newLoopDialogTitle} />
      )}
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
      {isAdmin && (
        <AdminDialog
          open={adminOpen}
          onClose={() => setAdminOpen(false)}
          currentUserId={me}
        />
      )}
      {/* Floating DM bubble — hidden on /chat where the full surface is already up. */}
      {!onChatRoute && <FloatingDm me={me} />}
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
            {/* Dual-mode: logged-in → full LoopPage with chrome; anonymous →
                read-only share view (server gates by meta.public). Shell
                drops the chrome when anonymous. */}
            <Route path="/loop/:id" element={<LoopPage />} />
            <Route path="/kanban" element={<KanbanPage />} />
            <Route path="/topic/:name" element={<TopicView />} />
            <Route path="/context" element={<Navigate to="/context/knowledge" replace />} />
            <Route path="/context/:sub" element={<ContextPage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/chat/:convId" element={<ChatPage />} />
            <Route path="/settings" element={<Navigate to="/settings/personal-repo" replace />} />
            <Route path="/settings/:tab" element={<SettingsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  )
}
