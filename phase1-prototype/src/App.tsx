import { createSignal, Show } from "solid-js"
import "./index.css"
import { LoopPage } from "./pages/loop"
import { FocusPage } from "./pages/focus"
import { ContextPage } from "./pages/context"
import { ChatPage } from "./pages/chat"

type Tab = "loop" | "focus" | "context" | "chat"

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "loop", label: "Loop", icon: "⑂" },
  { id: "focus", label: "Focus", icon: "◉" },
  { id: "context", label: "Context", icon: "⌘" },
  { id: "chat", label: "Chat", icon: "✦" },
]

function App() {
  const [tab, setTab] = createSignal<Tab>("loop")
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
            <button
              type="button"
              onClick={() => setTab(t.id)}
              class={
                tab() === t.id
                  ? "px-3 h-8 rounded text-sm bg-gray-900 text-white flex items-center gap-1.5"
                  : "px-3 h-8 rounded text-sm text-gray-600 hover:bg-gray-100 flex items-center gap-1.5"
              }
            >
              <span class="opacity-70">{t.icon}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
        <div class="flex-1" />
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
      <main class="flex-1 min-h-0 min-w-0 overflow-hidden">
        <Show when={tab() === "loop"}>
          <LoopPage />
        </Show>
        <Show when={tab() === "focus"}>
          <FocusPage />
        </Show>
        <Show when={tab() === "context"}>
          <ContextPage />
        </Show>
        <Show when={tab() === "chat"}>
          <ChatPage />
        </Show>
      </main>
    </div>
  )
}

export default App
