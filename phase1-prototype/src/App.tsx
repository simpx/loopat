import { Show } from "solid-js"
import { Router, Route, Navigate, useLocation, useNavigate, A } from "@solidjs/router"
import "./index.css"
import { LoopPage, NewLoopDialog } from "./pages/loop"
import { FocusPage } from "./pages/focus"
import { ContextPage } from "./pages/context"
import { ChatPage } from "./pages/chat"
import {
  loops,
  createLoop,
  newLoopDialogOpen,
  setNewLoopDialogOpen,
} from "./state"

type Tab = "loop" | "focus" | "context" | "chat"

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "loop", label: "Loop", icon: "⑂" },
  { id: "focus", label: "Focus", icon: "◉" },
  { id: "context", label: "Context", icon: "⌘" },
  { id: "chat", label: "Chat", icon: "✦" },
]

function Layout(props: { children?: any }) {
  const loc = useLocation()
  const navigate = useNavigate()
  const activeTab = () => (loc.pathname.split("/")[1] || "loop") as Tab
  return (
    <div class="h-full w-full flex flex-col bg-gray-50 text-gray-900">
      <header class="h-12 shrink-0 border-b border-gray-200 bg-white flex items-center px-4 gap-4">
        <div class="flex items-center gap-2 shrink-0">
          <span class="text-lg leading-none">🦄</span>
          <span class="font-mono text-sm text-gray-900 font-medium">1001</span>
          <span class="text-gray-300">|</span>
          <span class="text-sm text-gray-600">loopey</span>
        </div>
        <nav class="flex items-center gap-1">
          {TABS.map((t) => (
            <A
              href={`/${t.id}`}
              class={
                activeTab() === t.id
                  ? "px-3 h-8 rounded text-sm bg-gray-900 text-white flex items-center gap-1.5"
                  : "px-3 h-8 rounded text-sm text-gray-600 hover:bg-gray-100 flex items-center gap-1.5"
              }
            >
              <span class="opacity-70">{t.icon}</span>
              <span>{t.label}</span>
            </A>
          ))}
        </nav>
        <div class="flex-1" />
        <button
          type="button"
          onClick={() => setNewLoopDialogOpen(true)}
          class="flex items-center gap-1.5 px-3 h-8 rounded text-sm bg-gray-900 text-white hover:bg-gray-700"
          title="create new loop (⌘N)"
        >
          <span class="text-base leading-none">+</span>
          <span>New Loop</span>
        </button>
        <button
          type="button"
          class="flex items-center gap-2 px-2 h-8 rounded hover:bg-gray-100"
          title="account"
        >
          <span class="w-6 h-6 rounded-full bg-gray-900 text-white text-xs flex items-center justify-center">
            S
          </span>
          <span class="text-sm text-gray-700">simpx</span>
          <span class="text-gray-400 text-xs">▾</span>
        </button>
      </header>
      <main class="flex-1 min-h-0 min-w-0 overflow-hidden">{props.children}</main>

      <Show when={newLoopDialogOpen()}>
        <NewLoopDialog
          onClose={() => setNewLoopDialogOpen(false)}
          onCreate={(opts) => {
            const id = createLoop(opts)
            setNewLoopDialogOpen(false)
            navigate(`/loop/${id}`)
          }}
        />
      </Show>
    </div>
  )
}

function App() {
  return (
    <Router root={Layout}>
      <Route path="/" component={() => <Navigate href="/loop" />} />
      <Route path="/loop" component={() => <Navigate href={`/loop/${loops()[0].id}`} />} />
      <Route path="/loop/:id" component={LoopPage} />
      <Route path="/focus" component={FocusPage} />
      <Route path="/context" component={() => <Navigate href="/context/knowledge" />} />
      <Route path="/context/:sub" component={ContextPage} />
      <Route path="/context/:sub/*path" component={ContextPage} />
      <Route path="/chat" component={ChatPage} />
    </Router>
  )
}

export default App
