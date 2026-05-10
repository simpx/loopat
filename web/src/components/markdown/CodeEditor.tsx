/**
 * CodeMirror 6 wrapper. Ported from phase1-prototype/src/components/code-editor.tsx
 * (SolidJS → React). Picks language extension by file ext.
 */
import { useEffect, useRef } from "react"
import { EditorView, basicSetup } from "codemirror"
import { EditorState, Compartment } from "@codemirror/state"
import { python } from "@codemirror/lang-python"
import { markdown } from "@codemirror/lang-markdown"
import { javascript } from "@codemirror/lang-javascript"

const langExt = (path: string) => {
  if (path.endsWith(".py")) return python()
  if (path.endsWith(".md")) return markdown()
  if (path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".js") || path.endsWith(".jsx"))
    return javascript({ typescript: path.endsWith(".ts") || path.endsWith(".tsx") })
  return []
}

const baseTheme = EditorView.theme({
  "&": { fontSize: "13px", height: "100%", backgroundColor: "transparent" },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    lineHeight: "1.55",
  },
  ".cm-content": { padding: "10px 0" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    borderRight: "1px solid #f3f4f6",
    color: "#9ca3af",
  },
  ".cm-activeLine": { backgroundColor: "#f9fafb" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-cursor": { borderLeftColor: "#111827" },
  ".cm-selectionBackground, ::selection": { backgroundColor: "#e0e7ff !important" },
  ".cm-focused": { outline: "none" },
})

export function CodeEditor({
  path,
  value,
  onChange,
}: {
  path: string
  value: string
  onChange: (v: string) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const langCompartment = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!hostRef.current) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        baseTheme,
        langCompartment.current.of(langExt(path)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString())
        }),
      ],
    })
    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // re-create editor only when path changes (language switches)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // sync external `value` changes into editor (without losing cursor when same)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const cur = view.state.doc.toString()
    if (cur !== value) {
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: value },
      })
    }
  }, [value])

  return <div ref={hostRef} className="h-full w-full overflow-auto" />
}
