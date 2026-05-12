/**
 * TopicChip — small clickable pill rendering #xxx.
 *
 * Topic is the cross-entity association concept: anything that mentions
 * `#xxx` in its content (focus markdown body, loop title, future channel)
 * is associated. Clicking a chip jumps to the topic view aggregating all
 * entities that share this topic.
 */

import type { MouseEvent } from "react"

export function TopicChip({
  name,
  onClick,
  size = "sm",
}: {
  name: string
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void
  size?: "sm" | "md"
}) {
  const cls =
    size === "md"
      ? "px-2 py-0.5 text-[12px]"
      : "px-1.5 py-0.5 text-[10px]"
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "inline-flex items-center rounded-full bg-sky-50 text-sky-700 border border-sky-200 hover:bg-sky-100 transition-colors font-mono " +
        cls
      }
      title={`#${name}`}
    >
      #{name}
    </button>
  )
}
