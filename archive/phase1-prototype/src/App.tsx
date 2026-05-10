import { Show, createSignal, onCleanup, onMount } from "solid-js"
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

// Workspace member count is hardcoded for prototype; in real impl this would
// derive from the workspace member roster (which #all channel renders).
// 5 = simpx + panlilu + 3 agents (coo / ops-bot / growth-bot)
const WORKSPACE_MEMBER_COUNT = 5
const INVITE_LINK = "https://loopat.ai/invite/1001-x9k2-tmp"

type Tab = "loop" | "focus" | "context" | "chat"

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "loop", label: "Loop", icon: "⑂" },
  { id: "focus", label: "Focus", icon: "◉" },
  { id: "chat", label: "Chat", icon: "✦" },
  { id: "context", label: "Context", icon: "⌘" },
]

function Layout(props: { children?: any }) {
  const loc = useLocation()
  const navigate = useNavigate()
  const activeTab = () => (loc.pathname.split("/")[1] || "loop") as Tab
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = createSignal(false)
  const [inviteCopied, setInviteCopied] = createSignal(false)
  let workspaceRef: HTMLDivElement | undefined
  const handleDocClick = (e: MouseEvent) => {
    if (workspaceRef && !workspaceRef.contains(e.target as Node)) {
      setWorkspaceMenuOpen(false)
    }
  }
  onMount(() => document.addEventListener("click", handleDocClick))
  onCleanup(() => document.removeEventListener("click", handleDocClick))

  const copyInvite = async () => {
    let ok = false
    try {
      await navigator.clipboard.writeText(INVITE_LINK)
      ok = true
    } catch {
      // fallback for non-secure contexts (HTTP / older browsers)
      const ta = document.createElement("textarea")
      ta.value = INVITE_LINK
      ta.style.position = "fixed"
      ta.style.opacity = "0"
      document.body.appendChild(ta)
      ta.select()
      try {
        ok = document.execCommand("copy")
      } catch {
        ok = false
      }
      document.body.removeChild(ta)
    }
    if (!ok) {
      alert("自动复制失败 · 请从下方输入框手动选中 + Ctrl+C")
      return
    }
    setInviteCopied(true)
    setTimeout(() => setInviteCopied(false), 1800)
  }

  return (
    <div class="h-full w-full flex flex-col bg-gray-50 text-gray-900">
      <header class="h-12 shrink-0 border-b border-gray-200 bg-white flex items-center px-4 gap-4">
        <div class="relative shrink-0" ref={workspaceRef}>
          <button
            type="button"
            onClick={() => setWorkspaceMenuOpen(!workspaceMenuOpen())}
            class={
              workspaceMenuOpen()
                ? "flex items-center gap-2 px-2 h-8 rounded bg-gray-100"
                : "flex items-center gap-2 px-2 h-8 rounded hover:bg-gray-100"
            }
            title="workspace menu"
          >
            <span class="text-lg leading-none">🧶</span>
            <span class="text-sm text-gray-900 font-medium">loopat</span>
            <span class="text-gray-300">·</span>
            <span class="font-mono text-sm text-gray-600">1001</span>
            <span class="text-gray-400 text-xs">{workspaceMenuOpen() ? "▴" : "▾"}</span>
          </button>
          <Show when={workspaceMenuOpen()}>
            <div class="absolute left-0 top-full mt-1 w-72 bg-white border border-gray-200 rounded-md shadow-lg z-50 text-[13px]">
              <div class="px-3 py-2.5 border-b border-gray-100">
                <div class="flex items-center gap-2">
                  <span class="text-base">🧶</span>
                  <div class="flex-1 min-w-0">
                    <div class="text-gray-900 font-medium">loopat · 1001</div>
                    <div class="text-[11px] text-gray-500">{WORKSPACE_MEMBER_COUNT} members</div>
                  </div>
                </div>
              </div>
              <div class="px-3 py-2">
                <div class="text-[11px] text-gray-500 mb-1">invite link</div>
                <div class="flex items-center gap-1">
                  <input
                    readonly
                    value={INVITE_LINK}
                    onClick={(e) => e.currentTarget.select()}
                    class="flex-1 px-2 py-1 text-[11px] font-mono bg-gray-50 border border-gray-200 rounded text-gray-700 outline-none focus:border-gray-400"
                    title="点击全选 · 也可点右侧 📋 自动复制"
                  />
                  <button
                    type="button"
                    onClick={copyInvite}
                    class="px-2 py-1 text-[11px] rounded bg-gray-100 hover:bg-gray-200 text-gray-700"
                    title="复制到剪贴板"
                  >
                    {inviteCopied() ? "✓" : "📋"}
                  </button>
                </div>
                <div class="text-[10px] text-gray-400 mt-1">
                  受邀人通过 link 登录后自动落到 #all
                </div>
              </div>
              <div class="border-t border-gray-100" />
              <button
                type="button"
                onClick={() => {
                  setWorkspaceMenuOpen(false)
                  navigate("/chat/all")
                }}
                class="w-full px-3 py-2 text-left flex items-center gap-2 text-gray-700 hover:bg-gray-50"
              >
                <span class="text-gray-500">👥</span>
                <span>view members in #all</span>
              </button>
              <div class="border-t border-gray-100" />
              <button
                type="button"
                disabled
                class="w-full px-3 py-2 text-left flex items-center gap-2 text-gray-400 cursor-default"
                title="prototype: not implemented"
              >
                <span>⚙</span>
                <span>workspace settings</span>
              </button>
              <button
                type="button"
                disabled
                class="w-full px-3 py-2 text-left flex items-center gap-2 text-gray-400 cursor-default"
                title="prototype: not implemented"
              >
                <span>↪</span>
                <span>switch workspace</span>
              </button>
            </div>
          </Show>
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
      <Route path="/chat" component={() => <Navigate href="/chat/all" />} />
      <Route path="/chat/dm/:name" component={ChatPage} />
      <Route path="/chat/:id" component={ChatPage} />
    </Router>
  )
}

export default App
