/**
 * FocusDetail — view + edit a single focus markdown file.
 *
 * View mode: render markdown (GFM checkboxes, headings, wikilinks).
 *            `#xxx` topic tokens are rewritten to clickable chips.
 * Edit mode: plain textarea on the raw markdown body.
 *
 * Inline checkbox toggling will come later — for now editing the raw md
 * is the way to flip [ ] ↔ [x]. Saving writes back via PUT /api/focus/:name.
 */
import { useEffect, useState, useMemo, lazy, Suspense } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { readFocus, writeFocus } from "../api"
import { TopicChip } from "../components/TopicChip"

const Markdown = lazy(() =>
  import("../components/markdown/Markdown").then((m) => ({ default: m.Markdown }))
)

const TOPIC_RE = /(?<![\w])#([A-Za-z0-9][\w-]*)/g

/**
 * Rewrite `#xxx` topic tokens in the markdown source into anchor links
 * (topic:<name>) so the renderer can hand them to our `a` override.
 * Skip inside code spans (between ` `).
 */
function injectTopicLinks(md: string): string {
  // Split on backtick code spans to avoid rewriting inside them
  const parts = md.split(/(`[^`]*`)/g)
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) continue // code span
    parts[i] = parts[i].replace(TOPIC_RE, (_, name) => {
      return `[#${name}](topic:${name})`
    })
  }
  return parts.join("")
}

export function FocusDetail() {
  const { name } = useParams<{ name: string }>()
  const decoded = decodeURIComponent(name ?? "")
  const navigate = useNavigate()
  const [body, setBody] = useState<string>("")
  const [draft, setDraft] = useState<string>("")
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [topics, setTopics] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    readFocus(decoded).then((r) => {
      if (cancelled) return
      if (!r) {
        setLoading(false)
        return
      }
      setBody(r.body)
      setDraft(r.body)
      setLoading(false)
      // extract topics for header
      const set = new Set<string>()
      let m: RegExpExecArray | null
      TOPIC_RE.lastIndex = 0
      while ((m = TOPIC_RE.exec(r.body)) !== null) set.add(m[1].toLowerCase())
      setTopics([...set])
    })
    return () => { cancelled = true }
  }, [decoded])

  const enhanced = useMemo(() => injectTopicLinks(body), [body])

  const save = async () => {
    setSaving(true)
    const ok = await writeFocus(decoded, draft)
    if (ok) {
      setBody(draft)
      setEditing(false)
    }
    setSaving(false)
  }

  return (
    <div className="flex flex-col h-full w-full bg-white">
      <header className="h-10 shrink-0 flex items-center gap-3 px-6 border-b border-gray-200">
        <button
          type="button"
          onClick={() => navigate("/focus")}
          className="text-[11px] text-gray-500 hover:text-gray-900"
        >
          ← focus
        </button>
        <span className="text-[13px] text-gray-700 font-mono">{decoded}.md</span>
        <div className="flex items-center gap-1">
          {topics.map((t) => (
            <TopicChip key={t} name={t} onClick={() => navigate(`/topic/${encodeURIComponent(t)}`)} />
          ))}
        </div>
        <div className="flex-1" />
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-[11px] text-gray-500 hover:text-gray-900 px-2 py-1 rounded hover:bg-gray-100"
          >
            edit
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => {
                setDraft(body)
                setEditing(false)
              }}
              className="text-[11px] text-gray-500 hover:text-gray-900 px-2 py-1 rounded hover:bg-gray-100"
              disabled={saving}
            >
              cancel
            </button>
            <button
              type="button"
              onClick={save}
              className="text-[11px] text-white bg-gray-900 hover:bg-gray-700 px-2 py-1 rounded disabled:opacity-50"
              disabled={saving}
            >
              {saving ? "saving…" : "save"}
            </button>
          </>
        )}
      </header>

      <main className="flex-1 min-w-0 flex flex-col overflow-auto">
        <div className="px-4 md:px-8 py-4 md:py-8 mx-auto w-full max-w-[860px]">
          {loading ? (
            <div className="text-[12px] text-gray-400 italic">loading…</div>
          ) : editing ? (
            <textarea
              className="w-full min-h-[60vh] font-mono text-[13px] p-3 border border-gray-300 rounded outline-none focus:ring-2 focus:ring-gray-400/50"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
            />
          ) : (
            <Suspense fallback={<div className="text-[12px] text-gray-400">…</div>}>
              <CustomMarkdown
                text={enhanced}
                onTopicClick={(name) => navigate(`/topic/${encodeURIComponent(name)}`)}
              />
            </Suspense>
          )}
        </div>
      </main>
    </div>
  )
}

function CustomMarkdown({
  text,
  onTopicClick,
}: {
  text: string
  onTopicClick: (name: string) => void
}) {
  return <Markdown text={text} onTopicClick={onTopicClick} />
}
