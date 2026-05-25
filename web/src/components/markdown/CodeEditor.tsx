/**
 * CodeMirror 6 wrapper. Picks language extension by file extension.
 * Theme: One Dark palette via CSS variables — auto-switches with .dark class.
 */
import { useEffect, useRef } from "react"
import { EditorView, basicSetup } from "codemirror"
import { EditorState, Compartment } from "@codemirror/state"
import { StreamLanguage, syntaxHighlighting, HighlightStyle } from "@codemirror/language"
import { tags } from "@lezer/highlight"
import { python } from "@codemirror/lang-python"
import { markdown } from "@codemirror/lang-markdown"
import { javascript } from "@codemirror/lang-javascript"
import { json, jsonParseLinter } from "@codemirror/lang-json"
import { linter } from "@codemirror/lint"

// Legacy StreamLanguage modes
import { toml } from "@codemirror/legacy-modes/mode/toml"
import { yaml } from "@codemirror/legacy-modes/mode/yaml"
import { shell } from "@codemirror/legacy-modes/mode/shell"
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile"
import { ruby } from "@codemirror/legacy-modes/mode/ruby"
import { go } from "@codemirror/legacy-modes/mode/go"
import { swift } from "@codemirror/legacy-modes/mode/swift"
import { sass } from "@codemirror/legacy-modes/mode/sass"
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf"
import { css } from "@codemirror/legacy-modes/mode/css"
import { xml } from "@codemirror/legacy-modes/mode/xml"
import { sql } from "@codemirror/legacy-modes/mode/sql"
import { rust } from "@codemirror/legacy-modes/mode/rust"
import { c } from "@codemirror/legacy-modes/mode/clike"

const L = StreamLanguage.define

const extMap: Record<string, () => any> = {
  py: python,
  pyi: python,
  md: markdown,
  mdc: markdown,
  toml: () => L(toml),
  json: () => [json(), linter(jsonParseLinter())],
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true }),
  js: () => javascript(),
  jsx: () => javascript(),
  mjs: () => javascript(),
  cjs: () => javascript(),
  css: () => L(css as any),
  scss: () => L(sass as any),
  sass: () => L(sass as any),
  less: () => L(sass as any),
  xml: () => L(xml as any),
  svg: () => L(xml as any),
  html: () => L(xml as any),
  htm: () => L(xml as any),
  sql: () => L(sql as any),
  rs: () => L(rust as any),
  yaml: () => L(yaml as any),
  yml: () => L(yaml as any),
  sh: () => L(shell as any),
  bash: () => L(shell as any),
  zsh: () => L(shell as any),
  fish: () => L(shell as any),
  rb: () => L(ruby as any),
  go: () => L(go as any),
  swift: () => L(swift as any),
  proto: () => L(protobuf as any),
  env: () => L(shell as any),
  gitignore: () => L(shell as any),
  editorconfig: () => L(toml as any),
  c: () => L(c as any),
  h: () => L(c as any),
  cpp: () => L(c as any),
  hpp: () => L(c as any),
  cc: () => L(c as any),
  cs: () => L(c as any),
  java: () => L(c as any),
  scala: () => L(c as any),
  kt: () => L(c as any),
  kts: () => L(c as any),
  nginx: () => L(shell as any),
  conf: () => L(shell as any),
}

const langExt = (path: string) => {
  const ext = path.includes(".") ? path.split(".").pop()?.toLowerCase() ?? "" : path.toLowerCase()
  if (ext === "dockerfile" || path.toLowerCase().endsWith("dockerfile")) return L(dockerFile)
  if (ext === "makefile" || path.toLowerCase().endsWith("makefile")) return L(shell)
  const fn = extMap[ext]
  return fn ? fn() : []
}

const syntaxHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.keyword, color: "var(--cm-keyword)" },
    { tag: tags.string, color: "var(--cm-string)" },
    { tag: tags.number, color: "var(--cm-number)" },
    { tag: tags.comment, color: "var(--cm-comment)", fontStyle: "italic" },
    { tag: tags.function(tags.variableName), color: "var(--cm-def)" },
    { tag: tags.definition(tags.variableName), color: "var(--cm-def)" },
    { tag: tags.typeName, color: "var(--cm-typeName)" },
    { tag: tags.propertyName, color: "var(--cm-propertyName)" },
    { tag: tags.operator, color: "var(--cm-operator)" },
    { tag: tags.atom, color: "var(--cm-constant)" },
    { tag: tags.bool, color: "var(--cm-constant)" },
    { tag: tags.null, color: "var(--cm-constant)" },
    { tag: tags.variableName, color: "var(--cm-variableName)" },
    { tag: tags.labelName, color: "var(--cm-labelName)" },
    { tag: tags.tagName, color: "var(--cm-tag)" },
    { tag: tags.attributeName, color: "var(--cm-attribute)" },
    { tag: tags.link, color: "var(--cm-link)", textDecoration: "underline" },
    { tag: tags.regexp, color: "var(--cm-regexp)" },
    { tag: tags.escape, color: "var(--cm-constant)" },
    { tag: tags.special(tags.string), color: "var(--cm-regexp)" },
    { tag: tags.bracket, color: "var(--cm-bracket)" },
    { tag: tags.heading, color: "var(--cm-def)", fontWeight: "bold" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strong, fontWeight: "bold" },
    { tag: tags.invalid, color: "var(--cm-variableName)" },
  ])
)

const baseTheme = EditorView.theme({
  "&": { fontSize: "13px", height: "100%", backgroundColor: "var(--cm-bg)" },
  ".cm-scroller": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    lineHeight: "1.55",
  },
  ".cm-content": { padding: "10px 0", color: "var(--cm-text)", caretColor: "var(--cm-cursor)" },
  ".cm-gutters": {
    backgroundColor: "var(--cm-bg)",
    borderRight: "1px solid var(--cm-border)",
    color: "var(--cm-gutter)",
  },
  ".cm-activeLine": { backgroundColor: "var(--cm-activeLine)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-cursor": { borderLeftColor: "var(--cm-cursor)" },
  ".cm-selectionBackground, ::selection": { backgroundColor: "var(--cm-selection)" },
  ".cm-focused": { outline: "none" },
  ".cm-matchingBracket": { backgroundColor: "var(--cm-matchBracket)" },
  ".cm-nonmatchingBracket": { color: "var(--cm-error)" },
}, {dark: false})

export function CodeEditor({
  path,
  value,
  onChange,
  wordWrap = true,
  onSelectionChange,
}: {
  path: string
  value: string
  onChange: (v: string) => void
  wordWrap?: boolean
  onSelectionChange?: (sel: { from: number; to: number } | null) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const langCompartment = useRef(new Compartment())
  const wrapCompartment = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSelectionRef = useRef(onSelectionChange)
  onSelectionRef.current = onSelectionChange

  useEffect(() => {
    if (!hostRef.current) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        syntaxHighlight,
        baseTheme,
        wrapCompartment.current.of(wordWrap ? EditorView.lineWrapping : []),
        langCompartment.current.of(langExt(path)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString())
          // Report selection changes
          if (u.selectionSet || u.docChanged) {
            const sel = u.state.selection.main
            const fromLine = u.state.doc.lineAt(sel.from).number
            const toLine = u.state.doc.lineAt(sel.to).number
            const hasSelection = sel.from !== sel.to
            if (u.selectionSet) console.log(`%c[CodeEditor] %csel: %cL${fromLine}-L${toLine} %chasSelection: ${hasSelection}`, "color:#98c379", "color:#666", "color:#e5c07b", "color:#666")
            onSelectionRef.current?.(hasSelection ? { from: fromLine, to: toLine } : null)
          }
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

  // Toggle word wrap without recreating editor
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: wrapCompartment.current.reconfigure(wordWrap ? EditorView.lineWrapping : []),
    })
  }, [wordWrap])

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

  return <div ref={hostRef} className="absolute inset-0 overflow-auto" />
}
