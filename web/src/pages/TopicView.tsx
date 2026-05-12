/**
 * TopicView — aggregate page for a single topic.
 *
 * Lists all entities sharing this topic: focuses (from notes/focus/*.md)
 * and loops (from loop title). Future: channels.
 */
import { useEffect, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { listTopics, type TopicAggregate } from "../api"
import { TopicChip } from "../components/TopicChip"

export function TopicView() {
  const { name } = useParams<{ name: string }>()
  const decoded = decodeURIComponent(name ?? "")
  const navigate = useNavigate()
  const [topic, setTopic] = useState<TopicAggregate | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    listTopics().then((all) => {
      if (cancelled) return
      const found = all.find((t) => t.name === decoded.toLowerCase()) ?? null
      setTopic(found)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [decoded])

  return (
    <div className="flex flex-col h-full w-full bg-white">
      <header className="h-10 shrink-0 flex items-center gap-3 px-6 border-b border-gray-200">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="text-[11px] text-gray-500 hover:text-gray-900"
        >
          ← back
        </button>
        <TopicChip name={decoded} size="md" />
        <div className="flex-1" />
      </header>

      <main className="flex-1 min-w-0 flex flex-col overflow-auto">
        <div className="px-4 md:px-8 py-4 md:py-8 mx-auto w-full max-w-[760px] flex flex-col gap-5">
          {loading ? (
            <div className="text-[12px] text-gray-400 italic">loading…</div>
          ) : !topic ? (
            <div className="text-[12px] text-gray-400 italic">
              no entities tagged with <code>#{decoded}</code>
            </div>
          ) : (
            <>
              {topic.focuses.length > 0 && (
                <section>
                  <div className="text-[12px] uppercase tracking-wider text-gray-500 mb-2 px-1">
                    Focuses ({topic.focuses.length})
                  </div>
                  <div className="flex flex-col gap-1">
                    {topic.focuses.map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => navigate(`/focus/${encodeURIComponent(f)}`)}
                        className="w-full text-left px-3 py-2 rounded border border-gray-200 hover:border-gray-400 hover:bg-gray-50 text-[13px] text-gray-900"
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {topic.loops.length > 0 && (
                <section>
                  <div className="text-[12px] uppercase tracking-wider text-gray-500 mb-2 px-1">
                    Loops ({topic.loops.length})
                  </div>
                  <div className="flex flex-col gap-1">
                    {topic.loops.map((l) => (
                      <button
                        key={l.id}
                        type="button"
                        onClick={() => navigate(`/loop/${l.id}`)}
                        className="w-full text-left px-3 py-2 rounded border border-gray-200 hover:border-gray-400 hover:bg-gray-50 text-[13px] text-gray-900"
                      >
                        {l.title}
                        <span className="ml-2 text-[10px] font-mono text-gray-400">
                          {l.id.slice(0, 6)}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  )
}
