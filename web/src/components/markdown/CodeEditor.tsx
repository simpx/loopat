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
  css: () => L(css),
  scss: () => L(sass),
  sass: () => L(sass),
  less: () => L(sass),
  xml: () => L(xml),
  svg: () => L(xml),
  html: () => L(xml),
  htm: () => L(xml),
  sql: () => L(sql),
  rs: rust,
  yaml: () => L(yaml),
  yml: () => L(yaml),
  sh: () => L(shell),
  bash: () => L(shell),
  zsh: () => L(shell),
  fish: () => L(shell),
  rb: () => L(ruby),
  go: () => L(go),
  swift: () => L(swift),
  proto: () => L(protobuf),
  env: () => L(shell),
  gitignore: () => L(shell),
  editorconfig: () => L(toml),
  c: () => L(c),
  h: () => L(c),
  cpp: () => L(c),
  hpp: () => L(c),
  cc: () => L(c),
  cs: () => L(c),
  java: () => L(c),
  scala: () => L(c),
  kt: () => L(c),
  kts: () => L(c),
  nginx: () => L(shell),
  conf: () => L(shell),
}

const langExt = (path: string) => {
  const ext = path.includes(".") ? path.split(".").pop()?.toLowerCase() ?? "" : path.toLowerCase()
  if (ext === "dockerfile" || path.toLowerCase().endsWith("dockerfile")) return L(dockerFile)
  if (ext === "makefile" || path.toLowerCase().endsWith("makefile")) return L(shell)
  const fn = extMap[ext]
  return fn ? fn() : []
}

const oneDarkHighlight = syntaxHighlighting(
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
    backgroundColor: "transparent",
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
        oneDarkHighlight,
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

  return <div ref={hostRef} className="absolute inset-0 overflow-auto" />
}
