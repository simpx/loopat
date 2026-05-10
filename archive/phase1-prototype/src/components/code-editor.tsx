/**
 * SolidJS wrapper around CodeMirror 6.
 *
 * Lifts the editor view, syncs `value` prop to doc on external change,
 * forwards changes via `onChange`. Picks language extension by file ext.
 */
import { onMount, onCleanup, createEffect } from "solid-js"
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

export function CodeEditor(props: {
  path: string
  value: string
  onChange: (next: string) => void
}) {
  let parent: HTMLDivElement | undefined
  let view: EditorView | undefined
  const langCompartment = new Compartment()

  onMount(() => {
    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        props.onChange(u.state.doc.toString())
      }
    })
    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          basicSetup,
          langCompartment.of(langExt(props.path)),
          EditorView.lineWrapping,
          baseTheme,
          updateListener,
        ],
      }),
    })
  })

  onCleanup(() => view?.destroy())

  // Path changed → swap doc + language.
  createEffect(() => {
    const path = props.path
    const value = props.value
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    }
    view.dispatch({ effects: langCompartment.reconfigure(langExt(path)) })
  })

  return <div ref={parent} class="h-full w-full overflow-auto" />
}
