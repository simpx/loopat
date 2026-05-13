/**
 * TopicChip — small clickable pill rendering #xxx.
 *
 * Topic is the cross-entity association concept: anything that mentions
 * `#xxx` in its content (focus markdown body, loop title, future channel)
 * is associated. Clicking a chip jumps to the topic view aggregating all
 * entities that share this topic.
 */

import { type MouseEvent } from "react"

export function TopicChip({
  name,
  onClick,
  onEdit,
  size = "sm",
}: {
  name: string
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void
  onEdit?: () => void
  size?: "sm" | "md"
}) {
  const cls =
    size === "md"
      ? "px-2 py-0.5 text-[12px]"
      : "px-1.5 py-0.5 text-[10px]"
  return (
    <span className="relative inline-flex items-center group/chip">
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
      {onEdit && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onEdit() }}
          className="absolute -top-1 -right-1 z-10 w-4 h-4 rounded-full bg-white border border-gray-300 hover:border-red-400 hover:text-red-500 text-[9px] text-gray-400 opacity-0 group-hover/chip:opacity-100 transition-opacity flex items-center justify-center shadow-sm"
          title="Remove tag"
        >
          ×
        </button>
      )}
    </span>
  )
}
