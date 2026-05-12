/**
 * Plain markdown renderer using react-markdown + remark-gfm + rehype-highlight.
 * Adds wikilink support: [[Target]] and [[Target|Display]] become clickable
 * links that call `onWikilink(target)` instead of navigating.
 */
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeHighlight from "rehype-highlight"
import "highlight.js/styles/github.css"
import { remarkWikilink } from "./wikilink"

export function Markdown({
  text,
  onWikilink,
  onTopicClick,
}: {
  text: string
  onWikilink?: (target: string) => void
  onTopicClick?: (name: string) => void
}) {
  return (
    <div className="prose-loopat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkWikilink]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: ({ href, children, ...rest }) => {
            if (typeof href === "string" && href.startsWith("wikilink:") && onWikilink) {
              const target = href.slice("wikilink:".length)
              return (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault()
                    onWikilink(target)
                  }}
                  className="text-blue-700 underline-offset-2 hover:underline"
                  {...rest}
                >
                  {children}
                </a>
              )
            }
            if (typeof href === "string" && href.startsWith("topic:") && onTopicClick) {
              const name = href.slice("topic:".length)
              return (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault()
                    onTopicClick(name)
                  }}
                  className="inline-flex items-center rounded-full bg-sky-50 text-sky-700 border border-sky-200 hover:bg-sky-100 transition-colors font-mono px-1.5 py-0.5 text-[10px] mx-0.5 align-baseline"
                >
                  {children}
                </button>
              )
            }
            return (
              <a href={href} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline" {...rest}>
                {children}
              </a>
            )
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
