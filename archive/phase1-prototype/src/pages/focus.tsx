/**
 * Focus tab — pure derived view from loops() + focusFile().
 *
 * Focus is not a real entity. The list is computed:
 *   - Focus name = unique value across all loop.focuses[]
 *   - Plus pinned/listed names from notes/focus.md (via focusFile signal)
 *   - Activity = max(loop.lastActivityAgo) across associated loops
 *
 * The only real state is focusFile (pinned + listed empty meta focuses).
 *
 * Three derived sections:
 *   1. 📌 Pinned       — pinned focuses (永不归档)
 *   2. focus           — non-pinned focuses with at least 1 loop
 *   3. 🚨 未认领         — rfd loops without any focus (incident queue)
 *   4. ⑂ active 但未归类   — non-rfd loops without any focus
 *
 * Plus a deeplink to notes/inbox.md for team scratch prose.
 */
import { createMemo, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { ME, loops, focusFile, inboxItems, type Loop } from "../state"

const INBOX_PREVIEW_LIMIT = 5

type LinkedLoop = {
  id: string
  name: string
  driver: string
  ago: string
  rfd: boolean
}

type DerivedFocus = {
  name: string
  pinned: boolean
  loops: LinkedLoop[]
  lastTouched: string  // display string, "—" if no loops
  expiresInDays?: number  // 8d - daysSinceActivity, only for non-pinned
  meta: boolean  // true if no associated loops (empty meta focus)
  meDriving: boolean  // any loop in this focus is driven by ME
}

// Mock: parse "8h" / "1d" / "30m" / "yesterday 16:20" / etc. into rough hours.
// Used only for sort + 8d-expire countdown. Lossy by design.
function agoToHours(ago: string): number {
  if (!ago || ago === "just now") return 0
  if (ago.endsWith("m")) return parseInt(ago) / 60
  if (ago.endsWith("h")) return parseInt(ago)
  if (ago.endsWith("d")) return parseInt(ago) * 24
  if (ago.endsWith("w")) return parseInt(ago) * 24 * 7
  return 1
}

function pickFresher(a: string, b: string): string {
  return agoToHours(a) <= agoToHours(b) ? a : b
}

function deriveFocuses(allLoops: Loop[], pinned: string[], listed: string[]): DerivedFocus[] {
  const pinnedSet = new Set(pinned)
  const byName = new Map<string, LinkedLoop[]>()

  for (const l of allLoops) {
    if (l.status === "archived") continue
    for (const f of l.focuses ?? []) {
      const list = byName.get(f) ?? []
      list.push({
        id: l.id,
        name: l.name,
        driver: l.driver,
        ago: l.lastActivityAgo,
        rfd: !!l.rfd,
      })
      byName.set(f, list)
    }
  }

  // Ensure pinned + listed names are present even with 0 loops
  for (const name of [...pinned, ...listed]) {
    if (!byName.has(name)) byName.set(name, [])
  }

  const result: DerivedFocus[] = []
  for (const [name, ls] of byName) {
    const lastTouched = ls.length === 0 ? "—" : ls.map((x) => x.ago).reduce(pickFresher)
    const hours = ls.length === 0 ? Infinity : agoToHours(lastTouched)
    const expiresInDays = pinnedSet.has(name)
      ? undefined
      : Math.max(0, Math.ceil(8 - hours / 24))
    result.push({
      name,
      pinned: pinnedSet.has(name),
      loops: ls,
      lastTouched,
      expiresInDays,
      meta: ls.length === 0,
      meDriving: ls.some((x) => x.driver === ME),
    })
  }
  // Sort: ME-driving first, then by activity
  result.sort((a, b) => {
    if (a.meDriving !== b.meDriving) return a.meDriving ? -1 : 1
    return agoToHours(a.lastTouched) - agoToHours(b.lastTouched)
  })
  return result
}

export function FocusPage() {
  const navigate = useNavigate()

  const derived = createMemo(() =>
    deriveFocuses(loops(), focusFile().pinned, focusFile().listed),
  )
  const pinned = () => derived().filter((f) => f.pinned)
  const active = () => derived().filter((f) => !f.pinned)

  // Loops that have a driver but no focus tag — a focus-hygiene hint.
  // RFD/unclaimed loops do NOT belong here: those are "automatic incoming",
  // orthogonal to focus curation. They're discoverable via Loop tab's RFD badge.
  const orphan = createMemo(() =>
    loops().filter(
      (l) => l.status !== "archived" && !l.rfd && (l.focuses ?? []).length === 0,
    ),
  )

  return (
    <div class="flex flex-col h-full w-full bg-white">
      <header class="h-10 shrink-0 flex items-center gap-3 px-6 border-b border-gray-200">
        <span class="text-[13px] text-gray-700 tracking-tight">what matters now</span>
        <div class="flex-1" />
        <button
          type="button"
          onClick={() => navigate("/context/notes/focus.md")}
          class="text-[11px] text-gray-500 hover:text-gray-900 flex items-center gap-1"
          title="Focus 唯一的真存：pinned 名单 + 空 meta focus"
        >
          <span>edit</span>
          <code class="text-gray-700">notes/focus.md</code>
          <span>↗</span>
        </button>
      </header>

      <main class="flex-1 min-w-0 flex flex-col overflow-auto">
        <div class="px-8 py-8 mx-auto w-full max-w-[760px] flex flex-col gap-7">
            <Show when={pinned().length > 0}>
              <Section label="📌 Pinned" sub="永不归档" tone="pin">
                <For each={pinned()}>{(item) => <FocusRow item={item} navigate={navigate} />}</For>
              </Section>
            </Show>

            <Show when={active().length > 0}>
              <Section label="focus" sub="任意 loop 带 tag 自动出现 · 8d 无活动归档" tone="focus">
                <For each={active()}>{(item) => <FocusRow item={item} navigate={navigate} />}</For>
              </Section>
            </Show>

            <Show when={orphan().length > 0}>
              <Section label="⑂ active 但未归类" sub="有 driver 但没挂任何 focus" tone="orphan">
                <For each={orphan()}>
                  {(loop) => (
                    <button
                      type="button"
                      onClick={() => navigate(`/loop/${loop.id}`)}
                      class="w-full text-left flex items-center gap-2 px-3 py-1.5 rounded hover:bg-gray-50"
                    >
                      <span class="text-gray-400">⑂</span>
                      <span class="text-[13px] text-gray-900">{loop.name}</span>
                      <span class="text-xs text-gray-500 ml-auto">
                        {loop.driver} · {loop.lastActivityAgo}
                      </span>
                    </button>
                  )}
                </For>
              </Section>
            </Show>

            <Section
              label="📝 inbox"
              sub="团队稀碎 prose · 脚注，不在 Focus 主体里"
              tone="muted"
              right={
                <button
                  type="button"
                  onClick={() => navigate("/context/notes/inbox.md")}
                  class="text-[11px] text-gray-500 hover:text-gray-900 flex items-center gap-1"
                  title="编辑入口在 Context tab"
                >
                  <span>edit in notes</span>
                  <span>↗</span>
                </button>
              }
            >
              <ul class="flex flex-col gap-0.5">
                <For each={inboxItems().slice(0, INBOX_PREVIEW_LIMIT)}>
                  {(line) => (
                    <li class="flex items-baseline gap-2 text-[12px] text-gray-700 leading-relaxed">
                      <span class="text-gray-400 shrink-0">·</span>
                      <span class="truncate">{line}</span>
                    </li>
                  )}
                </For>
                <Show when={inboxItems().length > INBOX_PREVIEW_LIMIT}>
                  <li class="pt-1">
                    <button
                      type="button"
                      onClick={() => navigate("/context/notes/inbox.md")}
                      class="text-[11px] text-gray-500 hover:text-gray-900"
                    >
                      … 还有 {inboxItems().length - INBOX_PREVIEW_LIMIT} 条 →
                    </button>
                  </li>
                </Show>
              </ul>
            </Section>
        </div>
      </main>
    </div>
  )
}

type SectionTone = "pin" | "focus" | "alert" | "orphan" | "muted"

const TONE_BOX: Record<SectionTone, string> = {
  pin: "bg-amber-50/40 border-amber-200/60",
  focus: "bg-white border-gray-200",
  alert: "bg-red-50/30 border-red-200/60",
  orphan: "bg-white border-gray-200 border-dashed",
  muted: "bg-gray-50/60 border-gray-100",
}

const TONE_DOT: Record<SectionTone, string> = {
  pin: "bg-amber-400",
  focus: "bg-gray-400",
  alert: "bg-red-500",
  orphan: "bg-gray-300 border border-gray-400 border-dashed",
  muted: "bg-gray-300",
}

function Section(props: {
  label: string
  sub?: string
  tone?: SectionTone
  right?: any
  children: any
}) {
  const tone = (): SectionTone => props.tone ?? "focus"
  return (
    <section class={`rounded-lg border px-4 py-3 ${TONE_BOX[tone()]}`}>
      <header class="flex items-baseline gap-2 mb-2">
        <span class={`w-1.5 h-1.5 rounded-full self-center ${TONE_DOT[tone()]}`} />
        <h3 class="text-[14px] font-medium text-gray-900">{props.label}</h3>
        <Show when={props.sub}>
          <span class="text-[11px] text-gray-500">{props.sub}</span>
        </Show>
        <Show when={props.right}>
          <div class="ml-auto">{props.right}</div>
        </Show>
      </header>
      <div class="flex flex-col gap-1.5">{props.children}</div>
    </section>
  )
}

function FocusRow(props: { item: DerivedFocus; navigate: (path: string) => void }) {
  const item = props.item
  const expiresWarn = () => item.expiresInDays !== undefined && item.expiresInDays <= 3
  return (
    <div class="px-3 py-2 rounded hover:bg-gray-50">
      <div class="flex items-baseline gap-2">
        <span class="text-sm font-medium text-gray-900">{item.name}</span>
        <Show when={item.meDriving}>
          <span class="text-[10px] px-1.5 py-px rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
            me
          </span>
        </Show>
        <span class="text-[11px] text-gray-500 ml-auto">· {item.lastTouched}</span>
      </div>

      <Show when={item.loops.length > 0}>
        <ul class="ml-2 mt-1 flex flex-col gap-0.5">
          <For each={item.loops}>
            {(loop) => (
              <li>
                <button
                  type="button"
                  onClick={() => props.navigate(`/loop/${loop.id}`)}
                  class="flex items-center gap-2 text-xs text-gray-500 hover:text-gray-900"
                >
                  <span>⑂</span>
                  <span class="text-gray-900">{loop.name}</span>
                  <Show when={loop.rfd}>
                    <span class="text-amber-600 text-[10px]">RFD</span>
                  </Show>
                  <span>·</span>
                  <span>{loop.driver}</span>
                  <span>·</span>
                  <span>{loop.ago}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={item.meta}>
        <div class="ml-2 mt-1 text-[11px] text-gray-500">(meta · 当前无关联 loop)</div>
      </Show>

      <Show when={item.expiresInDays !== undefined && !item.meta}>
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
