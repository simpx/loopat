/**
 * Focus tab — pure derived view from loops + notes/focus.md + notes/inbox.md.
 * Layout/visuals ported from phase1-prototype/src/pages/focus.tsx.
 *
 * Phase-1 derives focuses from loop.focuses[]. Our LoopMeta currently has
 * no focuses field, so derived list = pinned + listed names from focus.md.
 * Loop tagging UI comes later. orphan section = all active loops (none have focuses yet).
 */
import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useWorkspace } from "../ctx"
import { readFocusData, type FocusData, type LoopMeta } from "../api"

const ME = "simpx"
const INBOX_PREVIEW_LIMIT = 5

type LinkedLoop = {
  id: string
  title: string
  driver: string
  ago: string
}

type DerivedFocus = {
  name: string
  pinned: boolean
  loops: LinkedLoop[]
  lastTouched: string
  expiresInDays?: number
  meta: boolean
  meDriving: boolean
}

function agoFromISO(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const h = ms / 3600_000
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`
  if (h < 24) return `${Math.round(h)}h`
  return `${Math.round(h / 24)}d`
}

function agoToHours(ago: string): number {
  if (!ago) return 0
  if (ago.endsWith("m")) return parseInt(ago) / 60
  if (ago.endsWith("h")) return parseInt(ago)
  if (ago.endsWith("d")) return parseInt(ago) * 24
  return 1
}

function pickFresher(a: string, b: string): string {
  return agoToHours(a) <= agoToHours(b) ? a : b
}

function deriveFocuses(loops: LoopMeta[], pinned: string[], listed: string[]): DerivedFocus[] {
  const pinnedSet = new Set(pinned)
  // No loop.focuses yet — names come purely from focus.md
  const result: DerivedFocus[] = []
  for (const name of [...new Set([...pinned, ...listed])]) {
    result.push({
      name,
      pinned: pinnedSet.has(name),
      loops: [],
      lastTouched: "—",
      expiresInDays: pinnedSet.has(name) ? undefined : 8,
      meta: true,
      meDriving: false,
    })
  }
  // Sort: pinned first, then alphabetical
  result.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return result
  // (kept agoFromISO + pickFresher imports for when loop.focuses ships)
  void agoFromISO
  void pickFresher
}

export function FocusPage() {
  const navigate = useNavigate()
  const ws = useWorkspace()
  const [data, setData] = useState<FocusData>({ pinned: [], listed: [], inbox: [] })

  useEffect(() => {
    readFocusData().then(setData)
  }, [])

  const derived = useMemo(() => deriveFocuses(ws.loops, data.pinned, data.listed), [ws.loops, data])
  const pinned = derived.filter((f) => f.pinned)
  const active = derived.filter((f) => !f.pinned)

  // active loops with no focus (single-user MVP: all of them are orphans)
  const orphan = ws.loops.slice(0, 20)

  return (
    <div className="flex flex-col h-full w-full bg-white">
      <header className="h-10 shrink-0 flex items-center gap-3 px-6 border-b border-gray-200">
        <span className="text-[13px] text-gray-700 tracking-tight">what matters now</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => navigate("/context/notes")}
          className="text-[11px] text-gray-500 hover:text-gray-900 flex items-center gap-1"
          title="Focus 唯一的真存：pinned 名单 + 空 meta focus"
        >
          <span>edit</span>
          <code className="text-gray-700">notes/focus.md</code>
          <span>↗</span>
        </button>
      </header>

      <main className="flex-1 min-w-0 flex flex-col overflow-auto">
        <div className="px-8 py-8 mx-auto w-full max-w-[760px] flex flex-col gap-7">
          {pinned.length > 0 && (
            <Section label="📌 Pinned" sub="永不归档" tone="pin">
              {pinned.map((item) => (
                <FocusRow key={item.name} item={item} navigate={navigate} />
              ))}
            </Section>
          )}

          {active.length > 0 && (
            <Section label="focus" sub="任意 loop 带 tag 自动出现 · 8d 无活动归档" tone="focus">
              {active.map((item) => (
                <FocusRow key={item.name} item={item} navigate={navigate} />
              ))}
            </Section>
          )}

          {orphan.length > 0 && (
            <Section label="⑂ active 但未归类" sub="有 driver 但没挂任何 focus" tone="orphan">
              {orphan.map((loop) => (
                <button
                  key={loop.id}
                  type="button"
                  onClick={() => navigate(`/loop/${loop.id}`)}
                  className="w-full text-left flex items-center gap-2 px-3 py-1.5 rounded hover:bg-gray-50"
                >
                  <span className="text-gray-400">⑂</span>
                  <span className="text-[13px] text-gray-900 truncate">{loop.title}</span>
                  <span className="text-xs text-gray-500 ml-auto">
                    {ME} · {agoFromISO(loop.createdAt)}
                  </span>
                </button>
              ))}
            </Section>
          )}

          <Section
            label="📝 inbox"
            sub="团队稀碎 prose · 脚注，不在 Focus 主体里"
            tone="muted"
            right={
              <button
                type="button"
                onClick={() => navigate("/context/notes")}
                className="text-[11px] text-gray-500 hover:text-gray-900 flex items-center gap-1"
                title="编辑入口在 Context tab"
              >
                <span>edit in notes</span>
                <span>↗</span>
              </button>
            }
          >
            <ul className="flex flex-col gap-0.5">
              {data.inbox.slice(0, INBOX_PREVIEW_LIMIT).map((line, i) => (
                <li key={i} className="flex items-baseline gap-2 text-[12px] text-gray-700 leading-relaxed">
                  <span className="text-gray-400 shrink-0">·</span>
                  <span className="truncate">{line}</span>
                </li>
              ))}
              {data.inbox.length > INBOX_PREVIEW_LIMIT && (
                <li className="pt-1">
                  <button
                    onClick={() => navigate("/context/notes")}
                    className="text-[11px] text-gray-500 hover:text-gray-900"
                  >
                    … 还有 {data.inbox.length - INBOX_PREVIEW_LIMIT} 条 →
                  </button>
                </li>
              )}
              {data.inbox.length === 0 && (
                <li className="text-[12px] text-gray-400 italic">空 · 在 notes/inbox.md 里加一行 `- ...`</li>
              )}
            </ul>
          </Section>
        </div>
      </main>
    </div>
  )
}

type SectionTone = "pin" | "focus" | "orphan" | "muted"

const TONE_BOX: Record<SectionTone, string> = {
  pin: "bg-amber-50/40 border-amber-200/60",
  focus: "bg-white border-gray-200",
  orphan: "bg-white border-gray-200 border-dashed",
  muted: "bg-gray-50/60 border-gray-100",
}

const TONE_DOT: Record<SectionTone, string> = {
  pin: "bg-amber-400",
  focus: "bg-gray-400",
  orphan: "bg-gray-300 border border-gray-400 border-dashed",
  muted: "bg-gray-300",
}

function Section({
  label,
  sub,
  tone = "focus",
  right,
  children,
}: {
  label: string
  sub?: string
  tone?: SectionTone
  right?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className={`rounded-lg border px-4 py-3 ${TONE_BOX[tone]}`}>
      <header className="flex items-baseline gap-2 mb-2">
        <span className={`w-1.5 h-1.5 rounded-full self-center ${TONE_DOT[tone]}`} />
        <h3 className="text-[14px] font-medium text-gray-900">{label}</h3>
        {sub && <span className="text-[11px] text-gray-500">{sub}</span>}
        {right && <div className="ml-auto">{right}</div>}
      </header>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  )
}

function FocusRow({ item, navigate }: { item: DerivedFocus; navigate: (path: string) => void }) {
  return (
    <div className="px-3 py-2 rounded hover:bg-gray-50">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-gray-900">{item.name}</span>
        {item.meDriving && (
          <span className="text-[10px] px-1.5 py-px rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
            me
          </span>
        )}
        {item.meta && <span className="text-[11px] text-gray-400 italic">(meta · no loops)</span>}
        <span className="text-[11px] text-gray-500 ml-auto">· {item.lastTouched}</span>
      </div>
      {item.loops.length > 0 && (
        <ul className="ml-2 mt-1 flex flex-col gap-0.5">
          {item.loops.map((loop) => (
            <li key={loop.id}>
              <button
                onClick={() => navigate(`/loop/${loop.id}`)}
                className="flex items-center gap-2 text-xs text-gray-500 hover:text-gray-900"
              >
                <span>⑂</span>
                <span className="text-gray-900">{loop.title}</span>
                <span>·</span>
                <span>{loop.driver}</span>
                <span>·</span>
                <span>{loop.ago}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
