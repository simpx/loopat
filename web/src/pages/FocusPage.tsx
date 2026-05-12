/**
 * Focus tab — list of focus files under notes/focus/, rendered as cards.
 *
 * Each focus is a markdown file in ccx-style format (see server walker).
 * Card shows: title, pinned/priority badges, progress (done/total),
 * topic chips, mtime. Click into a card → FocusDetail page.
 *
 * Topics (#xxx) are cross-entity association keys; clicking a chip jumps
 * to the topic view aggregating focuses + loops with that tag.
 */
import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { listFocuses, type FocusMeta } from "../api"
import { TopicChip } from "../components/TopicChip"

function agoFromMs(ms: number): string {
  const dt = Date.now() - ms
  const h = dt / 3600_000
  if (h < 1) return `${Math.max(1, Math.round(dt / 60_000))}m`
  if (h < 24) return `${Math.round(h)}h`
  return `${Math.round(h / 24)}d`
}

export function FocusPage() {
  const navigate = useNavigate()
  const [focuses, setFocuses] = useState<FocusMeta[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    listFocuses().then((f) => {
      if (cancelled) return
      setFocuses(f)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const pinned = focuses.filter((f) => f.pinned)
  const rest = focuses.filter((f) => !f.pinned)

  return (
    <div className="flex flex-col h-full w-full bg-white">
      <header className="h-10 shrink-0 flex items-center gap-3 px-6 border-b border-gray-200">
        <span className="text-[13px] text-gray-700 tracking-tight">what matters now</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => navigate(`/context/notes`)}
          className="text-[11px] text-gray-500 hover:text-gray-900 flex items-center gap-1"
          title="编辑 focus 文件"
        >
          <code className="text-gray-700">notes/focus/</code>
          <span>↗</span>
        </button>
      </header>

      <main className="flex-1 min-w-0 flex flex-col overflow-auto">
        <div className="px-4 md:px-8 py-4 md:py-8 mx-auto w-full max-w-[860px] flex flex-col gap-5 md:gap-7">
          {loading ? (
            <div className="text-[12px] text-gray-400 italic">loading…</div>
          ) : focuses.length === 0 ? (
            <div className="text-[12px] text-gray-400 italic">
              no focus yet · 在 <code>notes/focus/</code> 下创建一个 markdown 文件
            </div>
          ) : (
            <>
              {pinned.length > 0 && (
                <Section label="📌 Pinned">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {pinned.map((f) => (
                      <FocusCard key={f.name} item={f} onPick={(name) => navigate(`/focus/${encodeURIComponent(name)}`)} />
                    ))}
                  </div>
                </Section>
              )}
              {rest.length > 0 && (
                <Section label="Active">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {rest.map((f) => (
                      <FocusCard key={f.name} item={f} onPick={(name) => navigate(`/focus/${encodeURIComponent(name)}`)} />
                    ))}
                  </div>
                </Section>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  )

  void agoFromMs // kept for FocusCard use below
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="text-[12px] uppercase tracking-wider text-gray-500 mb-2 px-1">
        {label}
      </div>
      {children}
    </section>
  )
}

function FocusCard({ item, onPick }: { item: FocusMeta; onPick: (name: string) => void }) {
  const navigate = useNavigate()
  const pct = item.totalCount > 0 ? Math.round((item.doneCount / item.totalCount) * 100) : 0
  return (
    <button
      type="button"
      onClick={() => onPick(item.name)}
      className="text-left rounded-lg border border-gray-200 bg-white px-3 py-3 hover:border-gray-400 hover:shadow-sm transition-all"
    >
      <div className="flex items-baseline gap-2">
        <h4 className="text-[14px] font-medium text-gray-900 flex-1 min-w-0 truncate">
          {item.title}
        </h4>
        {item.priority && (
          <span
            className={
              "text-[10px] font-mono px-1.5 py-0.5 rounded " +
              (/^p?0$/i.test(item.priority)
                ? "bg-red-50 text-red-700 border border-red-200"
                : /^p?1$/i.test(item.priority)
                ? "bg-orange-50 text-orange-700 border border-orange-200"
                : "bg-gray-50 text-gray-600 border border-gray-200")
            }
          >
            {item.priority.toUpperCase()}
          </span>
        )}
      </div>

      {item.totalCount > 0 && (
        <div className="mt-2 flex items-center gap-2">
          <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-[11px] font-mono text-gray-500 shrink-0">
            {item.doneCount}/{item.totalCount}
          </span>
        </div>
      )}

      {item.topics.length > 0 && (
        <div className="mt-2 flex items-center gap-1 flex-wrap" onClick={(e) => e.stopPropagation()}>
          {item.topics.map((t) => (
            <TopicChip key={t} name={t} onClick={() => navigate(`/topic/${encodeURIComponent(t)}`)} />
          ))}
        </div>
      )}

      <div className="mt-2 text-[10px] text-gray-400">
        {agoFromMs(item.mtimeMs)} ago
      </div>
    </button>
  )
}
