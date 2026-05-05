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
      <header class="h-12 shrink-0 border-b border-gray-200 bg-white flex items-center px-4 gap-3">
        <span class="font-mono text-sm text-gray-500">1001</span>
        <span class="text-sm text-gray-300">·</span>
        <span class="text-sm text-gray-500">loopey</span>
        <span class="text-xs text-gray-400 ml-1">workspace</span>
        <div class="flex-1" />
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
