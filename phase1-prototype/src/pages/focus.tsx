/**
 * Focus tab — sidebar + main, 3 sections (Pinned / focus 8d-expire / active loops).
 * Ported from opencode prototype loop-tab-focus.tsx.
 */
import { createSignal, For, Show } from "solid-js"
import { Icon } from "../components/icon"

type LinkedLoop = { name: string; driver: string; ago: string }

type FocusItem = {
  id: string
  title: string
  pinned: boolean
  loops: LinkedLoop[]
  lastTouched: string
  expiresInDays?: number
}

const PINNED: FocusItem[] = [
  {
    id: "gateway",
    title: "上线 gateway",
    pinned: true,
    lastTouched: "14m",
    loops: [
      { name: "gateway-launch", driver: "阿尔萨斯", ago: "14m" },
      { name: "rdma-fix", driver: "simpx", ago: "2h" },
      { name: "gateway-pd-adapt", driver: "伊利丹", ago: "1d" },
    ],
  },
  {
    id: "inference-coord",
    title: "推理优化战役协调",
    pinned: true,
    lastTouched: "2h",
    loops: [],
  },
  {
    id: "1001",
    title: "1001 系统设计",
    pinned: true,
    lastTouched: "26m",
    loops: [
      { name: "1001-design", driver: "simpx", ago: "26m" },
      { name: "loop-tui", driver: "simpx", ago: "5h" },
    ],
  },
]

const FOCUS_ITEMS: FocusItem[] = [
  {
    id: "llama",
    title: "调研 llama-3",
    pinned: false,
    lastTouched: "1d",
    expiresInDays: 7,
    loops: [
      { name: "llama-research", driver: "simpx", ago: "1d" },
      { name: "shadow-llama-3", driver: "simpx", ago: "2d" },
    ],
  },
  {
    id: "hire",
    title: "招聘 funnel — 7 待评估",
    pinned: false,
    lastTouched: "5d",
    expiresInDays: 3,
    loops: [],
  },
  {
    id: "doc-context",
    title: "Doc → Context 重构",
    pinned: false,
    lastTouched: "6d",
    expiresInDays: 2,
    loops: [{ name: "1001", driver: "simpx", ago: "6d" }],
  },
]

const ACTIVE_NOT_IN_FOCUS: LinkedLoop[] = [{ name: "loopctl", driver: "simpx", ago: "3h" }]

export function FocusPage() {
  const [view, setView] = createSignal<"current" | "archived">("current")

  return (
    <div class="flex h-full w-full">
      <aside class="w-60 shrink-0 border-r border-gray-200 bg-white flex flex-col">
        <div class="px-3 h-10 flex items-center border-b border-gray-200">
          <span class="text-xs text-gray-500">Focus</span>
        </div>
        <div class="py-2 flex flex-col gap-0.5">
          <button
            type="button"
            onClick={() => setView("current")}
            class={
              view() === "current"
                ? "mx-2 px-2 py-1.5 rounded text-[13px] flex items-center gap-2 bg-gray-100 text-gray-900"
                : "mx-2 px-2 py-1.5 rounded text-[13px] flex items-center gap-2 text-gray-500 hover:bg-gray-50 hover:text-gray-900"
            }
          >
            <span>◉</span>
            <span>当下</span>
          </button>
          <button
            type="button"
            onClick={() => setView("archived")}
            class={
              view() === "archived"
                ? "mx-2 px-2 py-1.5 rounded text-[13px] flex items-center gap-2 bg-gray-100 text-gray-900"
                : "mx-2 px-2 py-1.5 rounded text-[13px] flex items-center gap-2 text-gray-500 hover:bg-gray-50 hover:text-gray-900"
            }
          >
            <Icon name="archive" />
            <span>归档</span>
          </button>
        </div>
        <div class="flex-1" />
        <div class="px-3 py-3 border-t border-gray-200 text-[11px] text-gray-500 leading-relaxed">
          Focus 是<b class="text-gray-900"> 当下</b>团队的注意力。
          <br />
          📌 Pinned 永不归档。
          <br />
          其他 8 天无活动自动归档。
        </div>
      </aside>

      <main class="flex-1 min-w-0 flex flex-col bg-white overflow-auto">
        <Show when={view() === "current"}>
          <div class="px-8 py-6 max-w-[760px] flex flex-col gap-7">
            <Section label="📌 Pinned">
              <For each={PINNED}>{(item) => <FocusRow item={item} />}</For>
            </Section>

            <Section label="focus" sub="auto-archive in 8d no activity">
              <For each={FOCUS_ITEMS}>{(item) => <FocusRow item={item} />}</For>
              <button class="self-start text-xs text-gray-500 hover:text-gray-900 px-2 py-1 rounded hover:bg-gray-50 mt-1 flex items-center gap-1">
                <Icon name="enter" />
                <span>add focus</span>
              </button>
            </Section>

            <Section label="active loops not in any focus">
              <For each={ACTIVE_NOT_IN_FOCUS}>
                {(loop) => (
                  <div class="flex items-center gap-2 px-3 py-1.5 rounded hover:bg-gray-50">
                    <span class="text-gray-400">⑂</span>
                    <span class="text-[13px] text-gray-900">{loop.name}</span>
                    <span class="text-xs text-gray-500 ml-auto">
                      {loop.driver} · {loop.ago}
                    </span>
                  </div>
                )}
              </For>
            </Section>
          </div>
        </Show>

        <Show when={view() === "archived"}>
          <div class="px-8 py-6 max-w-[760px]">
            <p class="text-[13px] text-gray-500">
              过去 30 天自动归档的 focus（mock）。pin 一项可以"复活"。
            </p>
          </div>
        </Show>
      </main>
    </div>
  )
}

function Section(props: { label: string; sub?: string; children: any }) {
  return (
    <section class="flex flex-col gap-2">
      <header class="flex items-baseline gap-2">
        <h3 class="text-[13px] font-medium text-gray-900">{props.label}</h3>
        <Show when={props.sub}>
          <span class="text-[11px] text-gray-500">({props.sub})</span>
        </Show>
      </header>
      <div class="flex flex-col gap-2">{props.children}</div>
    </section>
  )
}

function FocusRow(props: { item: FocusItem }) {
  const item = props.item
  const expiresWarn = () => item.expiresInDays !== undefined && item.expiresInDays <= 3
  return (
    <div class="px-3 py-2 rounded hover:bg-gray-50 cursor-pointer">
      <div class="flex items-baseline gap-2">
        <span class="text-sm font-medium text-gray-900">{item.title}</span>
        <span class="text-[11px] text-gray-500 ml-auto">· {item.lastTouched}</span>
      </div>

      <Show when={item.loops.length > 0}>
        <ul class="ml-2 mt-1 flex flex-col gap-0.5">
          <For each={item.loops}>
            {(loop) => (
              <li class="flex items-center gap-2 text-xs text-gray-500">
                <span>⑂</span>
                <span class="text-gray-900">{loop.name}</span>
                <span>·</span>
                <span>{loop.driver}</span>
                <span>·</span>
                <span>{loop.ago}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={item.loops.length === 0}>
        <div class="ml-2 mt-1 text-[11px] text-gray-500">(meta · 无关联 loop)</div>
      </Show>

      <Show when={item.expiresInDays !== undefined}>
        <div
          class={
            expiresWarn()
              ? "ml-2 mt-1 text-[11px] text-orange-600"
              : "ml-2 mt-1 text-[11px] text-gray-500"
          }
        >
          expires in {item.expiresInDays}d {expiresWarn() ? "⚠" : ""}
        </div>
      </Show>
    </div>
  )
}
