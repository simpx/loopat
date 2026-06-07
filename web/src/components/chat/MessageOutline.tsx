import { useEffect, useRef, type FC } from "react"
import { XIcon } from "lucide-react"
import { cn } from "@/lib/utils"

type UserMessageEntry = {
  id: string
  index: number
  time: string
  preview: string
}

type Props = {
  messages: UserMessageEntry[]
  currentVisibleId: string | null
  onSelect: (id: string) => void
  onClose: () => void
}

const MessageOutline: FC<Props> = ({ messages, currentVisibleId, onSelect, onClose }) => {
  const listRef = useRef<HTMLDivElement>(null)

  // ESC to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  // When the highlighted entry changes, keep it in view inside the popover.
  useEffect(() => {
    if (!currentVisibleId) return
    const el = listRef.current?.querySelector(`[data-outline-id="${CSS.escape(currentVisibleId)}"]`) as HTMLElement | null
    if (el) el.scrollIntoView({ block: "nearest" })
  }, [currentVisibleId])

  return (
    <div
      className="absolute top-2 right-2 z-30 w-72 max-h-[60vh] flex flex-col rounded-lg border border-gray-200 bg-white shadow-lg"
      role="dialog"
      aria-label="Message outline"
    >
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-100">
        <span className="text-xs font-medium text-gray-700">
          Your messages
          <span className="ml-1.5 text-gray-400 font-normal">({messages.length})</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          className="p-0.5 -m-0.5 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-100"
          aria-label="Close outline"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      <div ref={listRef} className="flex-1 overflow-y-auto py-1">
        {messages.length === 0 ? (
          <div className="px-3 py-4 text-xs text-gray-400 text-center">No messages yet</div>
        ) : (
          messages.map((m) => {
            const active = m.id === currentVisibleId
            return (
              <button
                key={m.id}
                type="button"
                data-outline-id={m.id}
                onClick={() => onSelect(m.id)}
                className={cn(
                  "relative w-full text-left pl-3 pr-2 py-1.5 text-xs hover:bg-gray-50 transition-colors",
                  active && "bg-blue-50/60",
                )}
              >
                {active && <span className="absolute left-0 top-1 bottom-1 w-0.5 rounded-r bg-blue-500" />}
                <div className="flex items-baseline gap-1.5">
                  <span className="text-gray-400 font-mono shrink-0">#{m.index}</span>
                  {m.time && <span className="text-[10px] text-gray-400 shrink-0">{m.time}</span>}
                </div>
                <div className={cn("mt-0.5 truncate", active ? "text-gray-900" : "text-gray-600")}>
                  {m.preview || <span className="text-gray-300 italic">(empty)</span>}
                </div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

export default MessageOutline
