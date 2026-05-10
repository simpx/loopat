/**
 * Right-panel editor mode. Layout follows phase1-prototype:
 *   <body: CodeMirror>
 *   <footer: path · unsaved · utf-8·LF>
 */
import { useEffect, useState } from "react"
import { readFile, writeFile } from "./api"
import { CodeEditor } from "./components/markdown/CodeEditor"

export function Editor({ loopId, path }: { loopId: string; path: string | null }) {
  const [original, setOriginal] = useState("")
  const [draft, setDraft] = useState("")
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

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
        className="flex-1 min-h-0"
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
          <CodeEditor path={path} value={draft} onChange={setDraft} />
        )}
      </div>
      <div className="border-t border-gray-200 px-3 py-1.5 text-[11px] text-gray-500 flex items-center gap-3">
        <span className="truncate">{path}</span>
        {dirty && (
          <button onClick={save} className="text-orange-600 hover:underline" title="ctrl/⌘+S">
            {saving ? "saving…" : "unsaved · save"}
          </button>
        )}
        <span className="ml-auto">utf-8 · LF</span>
      </div>
    </>
  )
}
