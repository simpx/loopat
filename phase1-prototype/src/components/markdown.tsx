/**
 * Markdown renderer with code-block syntax highlighting.
 *
 * Pipeline: text → marked (parses markdown) → marked-highlight (calls
 * hljs.highlight on every code block) → HTML string → injected via
 * innerHTML into a <div class="prose">.
 *
 * This is the renderer for ALL chat content: user messages, AI replies,
 * and structured tool calls (diffs / file reads / command output) that
 * upstream code converts to markdown code-fenced blocks.
 *
 * Languages registered: python / go / javascript / typescript / bash /
 * diff / yaml / json / markdown / xml. Unrecognized langs render
 * unhighlighted (still in a <pre><code>).
 */
import { marked } from "marked"
import { markedHighlight } from "marked-highlight"
import hljs from "highlight.js/lib/core"
import python from "highlight.js/lib/languages/python"
import go from "highlight.js/lib/languages/go"
import javascript from "highlight.js/lib/languages/javascript"
import typescript from "highlight.js/lib/languages/typescript"
import bash from "highlight.js/lib/languages/bash"
import diff from "highlight.js/lib/languages/diff"
import yaml from "highlight.js/lib/languages/yaml"
import json from "highlight.js/lib/languages/json"
import markdown from "highlight.js/lib/languages/markdown"
import xml from "highlight.js/lib/languages/xml"
import "highlight.js/styles/github.css"

hljs.registerLanguage("python", python)
hljs.registerLanguage("go", go)
hljs.registerLanguage("javascript", javascript)
hljs.registerLanguage("typescript", typescript)
hljs.registerLanguage("bash", bash)
hljs.registerLanguage("sh", bash)
hljs.registerLanguage("shell", bash)
hljs.registerLanguage("diff", diff)
hljs.registerLanguage("patch", diff)
hljs.registerLanguage("yaml", yaml)
hljs.registerLanguage("yml", yaml)
hljs.registerLanguage("json", json)
hljs.registerLanguage("markdown", markdown)
hljs.registerLanguage("md", markdown)
hljs.registerLanguage("xml", xml)
hljs.registerLanguage("html", xml)

marked.use(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      }
      return code
    },
  }),
)

marked.setOptions({ gfm: true, breaks: false })

export function Markdown(props: { text: string; class?: string }) {
  const html = () => marked.parse(props.text) as string
  return <div class={`prose ${props.class ?? ""}`} innerHTML={html()} />
}
