import { CheckIcon, LoaderIcon, CircleIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export interface TodoItem {
  content: string
  status: string
  activeForm: string
}

function TodoStatusIcon({ status }: { status: string }) {
  switch (status) {
    case "in_progress":
      return <LoaderIcon className="h-3.5 w-3.5 animate-spin text-sky-500 shrink-0" />
    case "completed":
      return <CheckIcon className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
    default:
      return <CircleIcon className="h-3.5 w-3.5 text-gray-300 shrink-0" />
  }
}

export default function TodoRenderer({ todos }: { todos: TodoItem[] }) {
  if (!Array.isArray(todos) || todos.length === 0) return null

  const doneCount = todos.filter((t) => t?.status === "completed").length

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px] text-gray-400 mb-1">
        <span>
          {doneCount}/{todos.length} done
        </span>
      </div>
      <ul className="space-y-0.5">
        {todos.filter((t) => t && typeof t === "object" && typeof t.status === "string").map((todo, i) => {
          const isCompleted = todo.status === "completed"
          const isRunning = todo.status === "in_progress"
          return (
            <li
              key={i}
              className={cn(
                "flex items-start gap-2 py-0.5 rounded transition-colors",
                isRunning && "bg-sky-50/50 -mx-1 px-1",
              )}
            >
              <TodoStatusIcon status={todo.status} />
              <span
                className={cn(
                  "text-[12px] transition-all",
                  isCompleted && "line-through text-gray-400",
                  isRunning && "text-sky-700 font-medium",
                  !isCompleted && !isRunning && "text-gray-600",
                )}
              >
                {todo.content}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
