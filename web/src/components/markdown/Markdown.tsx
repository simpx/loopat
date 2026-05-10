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
}: {
  text: string
  onWikilink?: (target: string) => void
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
