import { useState } from "react"
import {
  LoaderIcon,
  XCircleIcon,
  BotIcon,
  UserIcon,
  WrenchIcon,
  TerminalIcon,
  FileTextIcon,
  SearchIcon,
  PencilIcon,
  ChevronDownIcon,
} from "lucide-react"
import type { TaskState } from "@/useLoopRuntime"
import { useLoopRuntimeExtra, convertMessage } from "@/useLoopRuntime"
import { cn } from "@/lib/utils"

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}m ${rem}s`
}

// Friendly phase labels mapped from the agent's last tool call. When the
// subagent has nothing in flight we fall back to the generic "Working…".
const PHASE_LABELS: Record<string, string> = {
  Read: "Reading files",
  Grep: "Searching code",
  Glob: "Finding files",
  Edit: "Editing code",
  Write: "Writing files",
  ApplyPatch: "Applying patch",
  Bash: "Running commands",
  Task: "Delegating",
  Agent: "Delegating",
  WebFetch: "Fetching web",
  WebSearch: "Searching web",
}

function phaseLabel(lastToolName?: string): string {
  if (!lastToolName) return "Working"
  return PHASE_LABELS[lastToolName] ?? lastToolName
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
  toolCallId?: string
}

function childToolIcon(name: string) {
  if (name === "Bash") return TerminalIcon
  if (["Edit", "Write", "ApplyPatch"].includes(name)) return PencilIcon
  if (["Grep", "Glob"].includes(name)) return SearchIcon
  if (name === "Read") return FileTextIcon
  return WrenchIcon
}

export default function AgentRenderer({
  args,
  result,
  status,
  taskState,
  elapsedSeconds,
  toolCallId,
}: AgentRendererProps) {
  const isRunning = status === "running"
  const subagentType = args.subagent_type ?? taskState?.task_type ?? "general-purpose"
  const description = args.description ?? taskState?.description ?? ""

  const { childMessagesByAgentId } = useLoopRuntimeExtra()
  const childRawMsgs = toolCallId ? childMessagesByAgentId.get(toolCallId) ?? [] : []

  // Convert child messages once
  const childMsgs = childRawMsgs.map((m) => {
    try { return convertMessage(m) } catch { return null }
  }).filter(Boolean)

  const hasChildren = childMsgs.length > 0

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

      {/* Running indicator: phase label (mapped from last_tool_name) +
          AI-generated progress summary when available (enabled by
          agentProgressSummaries on the server). */}
      {isRunning && (
        <div className="flex items-center gap-2 py-1">
          <LoaderIcon className="h-3 w-3 animate-spin text-sky-500" />
          <span className="text-[11px] text-gray-500">
            {phaseLabel(taskState?.last_tool_name)}…
          </span>
          {taskState?.summary && (
            <span className="text-[11px] text-gray-400 italic truncate max-w-[280px]">
              {taskState.summary}
            </span>
          )}
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
        <pre className="overflow-x-auto rounded border border-gray-100 bg-gray-100/50 p-2 text-[11px] leading-relaxed text-gray-700 whitespace-pre-wrap font-mono max-h-32 overflow-auto">
          {result}
        </pre>
      )}
      {status === "complete" && !result && taskState?.summary && (
        <p className="text-[11px] text-gray-500 italic">{taskState.summary}</p>
      )}

      {/* Child messages — agent-internal prompts & tool calls */}
      {hasChildren && (
        <div className="border-t border-purple-100 pt-2 mt-2 space-y-1.5">
          {childMsgs.map((msg: any) => {
            if (!msg || !Array.isArray(msg.content)) return null
            const isUser = msg.role === "user"

            return (
              <div key={msg.id} className="space-y-1">
                {msg.content.map((part: any, pi: number) => {
                  if (part.type === "text" && part.text) {
                    return isUser ? (
                      /* Agent-internal user prompt — distinct from end-user messages */
                      <div key={pi} className="flex items-start gap-1.5 pl-2 border-l-2 border-purple-200">
                        <UserIcon className="h-3 w-3 text-purple-400 shrink-0 mt-0.5" />
                        <p className="text-[11px] text-purple-800 leading-relaxed whitespace-pre-wrap break-words">
                          {part.text}
                        </p>
                      </div>
                    ) : (
                      <p key={pi} className="text-[11px] text-gray-500 leading-relaxed pl-2 whitespace-pre-wrap break-words">
                        {part.text}
                      </p>
                    )
                  }

                  if (part.type === "tool-call") {
                    return (
                      <ChildToolCard
                        key={pi}
                        toolName={part.toolName ?? "?"}
                        args={part.args ?? {}}
                        result={part.result}
                        status={part.status?.type ?? "complete"}
                      />
                    )
                  }

                  if (part.type === "reasoning" && part.text) {
                    return (
                      <p key={pi} className="text-[10px] text-gray-400 italic pl-2">
                        {part.text.length > 200 ? part.text.slice(0, 200) + "…" : part.text}
                      </p>
                    )
                  }

                  return null
                })}
              </div>
            )
          })}
        </div>
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

/* ─── Compact child tool card ─── */

function ChildToolCard({
  toolName,
  args,
  result,
  status,
}: {
  toolName: string
  args: Record<string, unknown>
  result?: string
  status: string
}) {
  const [open, setOpen] = useState(false)
  const Icon = childToolIcon(toolName)
  const isRunning = status === "running"
  const isDone = status === "complete"

  // one-line summary from args
  const summary =
    args.file_path as string ||
    args.command as string ||
    args.pattern as string ||
    args.query as string ||
    args.description as string ||
    ""

  const hasContent = (summary && summary.length > 0) || result

  return (
    <div className="pl-4">
      <div
        className={cn(
          "flex items-center gap-1.5 rounded border px-2 py-1 text-[10px] w-full",
          isRunning ? "border-sky-100 bg-sky-50/30" : "border-gray-100 bg-gray-50/50",
        )}
      >
        <Icon className="h-2.5 w-2.5 text-gray-400 shrink-0" />
        <span className="font-medium text-gray-600 shrink-0">{toolName}</span>
        {summary && (
          <span className="text-gray-400 truncate min-w-0">{String(summary)}</span>
        )}
        {isRunning && <LoaderIcon className="h-2.5 w-2.5 animate-spin text-sky-500 shrink-0" />}
        {isDone && result !== undefined && hasContent && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="text-gray-400 hover:text-gray-600 shrink-0 ml-auto"
          >
            <ChevronDownIcon className={cn("h-2.5 w-2.5 transition-transform", open && "rotate-180")} />
          </button>
        )}
      </div>
      {open && result && (
        <pre className="mt-0.5 overflow-x-auto rounded border border-gray-100 bg-gray-50 p-1.5 text-[10px] leading-relaxed text-gray-600 whitespace-pre-wrap font-mono max-h-24 overflow-auto">
          {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  )
}
