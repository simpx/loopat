import { LoaderIcon, CheckIcon, XCircleIcon, BotIcon } from "lucide-react"
import type { TaskState } from "@/useLoopRuntime"

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}m ${rem}s`
}

interface AgentRendererProps {
  args: {
    description?: string
    prompt?: string
    subagent_type?: string
  }
  result?: string
  status: string
  taskState?: TaskState
  elapsedSeconds?: number
}

export default function AgentRenderer({
  args,
  result,
  status,
  taskState,
  elapsedSeconds,
}: AgentRendererProps) {
  const isRunning = status === "running"
  const subagentType = args.subagent_type ?? taskState?.task_type ?? "general-purpose"
  const description = args.description ?? taskState?.description ?? ""

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2">
        <BotIcon className="h-4 w-4 text-purple-500 shrink-0" />
        <span className="text-[11px] font-medium text-purple-700 uppercase tracking-wide">
          {subagentType}
        </span>
        <span
          className={
            isRunning
              ? "rounded px-1.5 py-px text-[10px] font-medium bg-sky-100 text-sky-700"
              : status === "incomplete"
                ? "rounded px-1.5 py-px text-[10px] font-medium bg-red-100 text-red-700"
                : "rounded px-1.5 py-px text-[10px] font-medium bg-emerald-100 text-emerald-700"
          }
        >
          {isRunning ? "running" : status === "incomplete" ? "failed" : "done"}
        </span>
        {isRunning && elapsedSeconds !== undefined && elapsedSeconds > 0 && (
          <span className="text-[10px] text-gray-400 tabular-nums">
            {formatDuration(elapsedSeconds * 1000)}
          </span>
        )}
      </div>

      {/* Description */}
      {description && (
        <p className="text-[12px] text-gray-600 leading-relaxed">{description}</p>
      )}

      {/* Running indicator */}
      {isRunning && (
        <div className="flex items-center gap-2 py-1">
          <LoaderIcon className="h-3 w-3 animate-spin text-sky-500" />
          <span className="text-[11px] text-gray-400">
            {taskState?.last_tool_name
              ? `Running ${taskState.last_tool_name}...`
              : "Working..."}
          </span>
        </div>
      )}

      {/* Task completion stats */}
      {taskState?.usage && status === "complete" && (
        <div className="flex items-center gap-3 text-[10px] text-gray-400">
          <span>{taskState.usage.tool_uses} tools</span>
          <span>{(taskState.usage.total_tokens / 1000).toFixed(1)}k tokens</span>
          <span>{formatDuration(taskState.usage.duration_ms)}</span>
        </div>
      )}

      {/* Result / Summary */}
      {status === "complete" && result && (
        <pre className="overflow-x-auto rounded border border-gray-200 bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-700 whitespace-pre-wrap font-mono max-h-32 overflow-auto">
          {result}
        </pre>
      )}
      {status === "complete" && !result && taskState?.summary && (
        <p className="text-[11px] text-gray-500 italic">{taskState.summary}</p>
      )}

      {/* Error state */}
      {status === "incomplete" && (
        <div className="flex items-center gap-2 text-[11px] text-red-500">
          <XCircleIcon className="h-3.5 w-3.5" />
          {taskState?.error ?? "Agent call failed"}
        </div>
      )}
    </div>
  )
}
