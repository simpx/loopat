import { useRef } from "react"
import { Editor, rootCtx, defaultValueCtx } from "@milkdown/core"
import { MilkdownProvider, Milkdown, useEditor } from "@milkdown/react"
import { commonmark } from "@milkdown/preset-commonmark"
import { gfm } from "@milkdown/preset-gfm"
import { listener, listenerCtx } from "@milkdown/plugin-listener"

const proseMirrorStyles = `
.milkdown-editor .ProseMirror {
  min-height: 100%;
  outline: none;
  padding: 16px 24px;
  font-size: 14px;
  line-height: 1.7;
  color: #374151;
}
.milkdown-editor .ProseMirror p {
  margin: 0.5em 0;
}
.milkdown-editor .ProseMirror h1 {
  font-size: 1.75em;
  font-weight: 700;
  margin: 0.6em 0 0.3em;
  line-height: 1.3;
}
.milkdown-editor .ProseMirror h2 {
  font-size: 1.4em;
  font-weight: 600;
  margin: 0.6em 0 0.3em;
  line-height: 1.35;
}
.milkdown-editor .ProseMirror h3 {
  font-size: 1.15em;
  font-weight: 600;
  margin: 0.5em 0 0.25em;
}
.milkdown-editor .ProseMirror ul, .milkdown-editor .ProseMirror ol {
  padding-left: 1.5em;
  margin: 0.4em 0;
}
.milkdown-editor .ProseMirror li {
  margin: 0.2em 0;
}
.milkdown-editor .ProseMirror code {
  background: #f3f4f6;
  border-radius: 3px;
  padding: 1px 4px;
  font-family: ui-monospace, monospace;
  font-size: 0.9em;
}
.milkdown-editor .ProseMirror pre {
  background: #1f2937;
  color: #e5e7eb;
  border-radius: 6px;
  padding: 12px 16px;
  overflow-x: auto;
  margin: 0.6em 0;
}
.milkdown-editor .ProseMirror pre code {
  background: none;
  padding: 0;
  font-size: 13px;
}
.milkdown-editor .ProseMirror blockquote {
  border-left: 3px solid #d1d5db;
  margin: 0.5em 0;
  padding: 0.2em 0 0.2em 1em;
  color: #6b7280;
}
.milkdown-editor .ProseMirror hr {
  border: none;
  border-top: 1px solid #e5e7eb;
  margin: 1.5em 0;
}
.milkdown-editor .ProseMirror a {
  color: #2563eb;
  text-decoration: underline;
}
.milkdown-editor .ProseMirror img {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
}
.milkdown-editor .ProseMirror table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.5em 0;
}
.milkdown-editor .ProseMirror th, .milkdown-editor .ProseMirror td {
  border: 1px solid #d1d5db;
  padding: 6px 10px;
  text-align: left;
}
.milkdown-editor .ProseMirror th {
  background: #f9fafb;
  font-weight: 600;
}
`

function MilkdownEditorInner({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEditor((container) => {
    return Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, container)
        ctx.set(defaultValueCtx, value)
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, _prev) => {
          onChangeRef.current(markdown)
        })
      })
      .use(commonmark)
      .use(gfm)
      .use(listener)
  }, [])

  return <Milkdown />
}

export function MilkdownEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <MilkdownProvider>
      <style>{proseMirrorStyles}</style>
      <div className="milkdown-editor h-full w-full overflow-auto [&_[data-milkdown-root]>div]:h-full">
        <MilkdownEditorInner value={value} onChange={onChange} />
      </div>
    </MilkdownProvider>
  )
}
