import { For, Show } from "solid-js"
import { loops, currentLoopId, setCurrentLoopId, forkLoop } from "../state"

export function LoopPage() {
  const current = () => loops().find((l) => l.id === currentLoopId())
  return (
    <div class="h-full w-full flex">
      <aside class="w-72 shrink-0 border-r border-gray-200 bg-white flex flex-col">
        <div class="px-3 h-9 shrink-0 flex items-center justify-between border-b border-gray-200">
          <span class="text-xs text-gray-500">loops · {loops().length}</span>
        </div>
        <div class="flex-1 min-h-0 overflow-auto">
          <For each={loops()}>
            {(loop) => {
              const sel = () => currentLoopId() === loop.id
              return (
                <button
                  type="button"
                  onClick={() => setCurrentLoopId(loop.id)}
                  class={
                    sel()
                      ? "w-full px-3 py-2 text-left bg-gray-100 border-l-2 border-gray-900"
                      : "w-full px-3 py-2 text-left hover:bg-gray-50 border-l-2 border-transparent"
                  }
                >
                  <div class="text-sm text-gray-900 truncate">{loop.title}</div>
                  <div class="text-xs text-gray-500 mt-0.5 truncate">
                    <span>{loop.driver}</span>
                    <span class="text-gray-300"> · </span>
                    <span>{loop.ago}</span>
                    <Show when={loop.forkedFrom}>
                      <span class="text-gray-300"> · </span>
                      <span class="text-gray-400">forked from {loop.forkedFrom}</span>
                    </Show>
                  </div>
                </button>
              )
            }}
          </For>
        </div>
      </aside>

      <section class="flex-1 min-w-0 flex flex-col">
        <Show when={current()} keyed>
          {(loop) => (
            <>
              <header class="h-10 shrink-0 px-4 border-b border-gray-200 flex items-center gap-3 bg-white">
                <span class="text-sm font-medium text-gray-900">{loop.title}</span>
                <span class="text-xs text-gray-500">driver: {loop.driver}</span>
                <Show when={loop.branch}>
                  <span class="text-xs text-gray-400 font-mono">· {loop.branch}</span>
                </Show>
                <div class="flex-1" />
                <button
                  type="button"
                  onClick={() => forkLoop(loop.id)}
                  class="px-3 h-7 rounded text-xs bg-gray-900 text-white hover:bg-gray-700"
                >
                  fork
                </button>
              </header>

              <div class="flex-1 min-h-0 p-6 text-sm text-gray-500 space-y-2">
                <p class="text-gray-700 font-medium">Loop body — placeholder</p>
                <p>这里将放：左 file tree / 中 chat / 下 terminal drawer。</p>
                <p class="text-xs">
                  点右上角 <code class="bg-gray-100 px-1.5 py-0.5 rounded text-gray-700">fork</code>
                  → 新 loop 出现在左侧列表顶部并自动选中（试试看）。
                </p>
              </div>
            </>
          )}
        </Show>
      </section>
    </div>
  )
}
