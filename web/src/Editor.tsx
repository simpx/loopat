/**
 * Right-panel editor mode.
 *   <body: CodeMirror>
 *   <footer: path · unsaved · word-wrap · utf-8·LF>
 */
import { useEffect, useState } from "react"
import { readFile, writeFile } from "./api"
import { CodeEditor } from "./components/markdown/CodeEditor"
import { WrapText } from "lucide-react"

function getStoredWordWrap(): boolean {
  try {
    const v = localStorage.getItem("loopat:editor:wordWrap")
    if (v === "0") return false
  } catch {}
  return true
}

export function Editor({ loopId, path, onSelectionChange }: { loopId: string; path: string | null; onSelectionChange?: (sel: { from: number; to: number } | null) => void }) {
  const [original, setOriginal] = useState("")
  const [draft, setDraft] = useState("")
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [wordWrap, setWordWrap] = useState(getStoredWordWrap)

  useEffect(() => {
    if (!path) {
      setOriginal("")
      setDraft("")
      return
    }
    setLoading(true)
    readFile(loopId, path)
      .then((r) => {
        const c = r?.content ?? ""
        setOriginal(c)
        setDraft(c)
      })
      .finally(() => setLoading(false))
  }, [loopId, path])

  const dirty = path && draft !== original
  const save = async () => {
    if (!path || saving) return
    setSaving(true)
    try {
      const ok = await writeFile(loopId, path, draft)
      if (ok) setOriginal(draft)
    } finally {
      setSaving(false)
    }
  }

  if (!path) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-[13px] text-gray-500 px-8 text-center">
        没打开文件 · 在 ▤ workdir 里点一个
      </div>
    )
  }

  return (
    <>
      <div
        className="flex-1 min-h-0 relative"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "s") {
            e.preventDefault()
            save()
          }
        }}
      >
        {loading ? (
          <div className="h-full w-full flex items-center justify-center text-[12px] text-gray-400">
            loading…
          </div>
        ) : (
          <CodeEditor path={path} value={draft} onChange={setDraft} wordWrap={wordWrap} onSelectionChange={onSelectionChange} />
        )}
      </div>
      <div className="border-t border-gray-200 px-3 py-1.5 text-[11px] text-gray-500 flex items-center gap-3">
        <span className="truncate">{path}</span>
        {dirty && (
          <button onClick={save} className="text-orange-600 hover:underline" title="ctrl/⌘+S">
            {saving ? "saving…" : "unsaved · save"}
          </button>
        )}
        <span className="flex-1" />
        <button
          onClick={() => {
            const next = !wordWrap
            setWordWrap(next)
            try { localStorage.setItem("loopat:editor:wordWrap", next ? "1" : "0") } catch {}
          }}
          className={`flex items-center gap-1 hover:text-gray-700 transition-colors ${wordWrap ? "text-gray-500" : "text-gray-300"}`}
          title={wordWrap ? "word wrap: on" : "word wrap: off"}
        >
          <WrapText size={13} />
        </button>
        <span>utf-8 · LF</span>
      </div>
    </>
  )
}
