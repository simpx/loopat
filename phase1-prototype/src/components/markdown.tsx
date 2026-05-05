/**
 * Minimal markdown renderer using `marked`.
 * Output HTML is set via innerHTML. Styling lives in index.css under .prose.
 */
import { marked } from "marked"

marked.setOptions({ gfm: true, breaks: false })

export function Markdown(props: { text: string; class?: string }) {
  const html = () => marked.parse(props.text) as string
  return <div class={`prose ${props.class ?? ""}`} innerHTML={html()} />
}
