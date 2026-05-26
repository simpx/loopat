import {
  MessagePrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { BrainIcon, ChevronDownIcon, RotateCcwIcon } from "lucide-react";
import { MarkdownBlock } from "./MarkdownBlock";
import ToolRenderer from "./ToolRenderer";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useLoopRuntimeExtra, type TurnStats } from "@/useLoopRuntime";
import { cn } from "@/lib/utils";
import ErrorBoundary from "./ErrorBoundary";

function extractTime(messageId: string | undefined): string {
  if (!messageId) return "";
  const match = messageId.match(/(\d{13})/);
  if (match) {
    return new Date(parseInt(match[1], 10)).toLocaleTimeString();
  }
  return "";
}

/** Compact one-line per-turn stats footer, e.g.
 *  `Tokens: 12,345 ↑10,000 ↓2,345  ·  TTFT 1.2s  ·  8.7s`. */
function formatTurnStats(s: TurnStats): string {
  const segs = [
    `Tokens: ${(s.input + s.output).toLocaleString()} ↑${s.input.toLocaleString()} ↓${s.output.toLocaleString()}`,
  ];
  if (s.ttftMs != null) segs.push(`TTFT ${(s.ttftMs / 1000).toFixed(1)}s`);
  segs.push(`${(s.totalMs / 1000).toFixed(1)}s`);
  return segs.join("  ·  ");
}

/* ─── JSON detection helper ─── */

function JsonBlock({ content }: { content: string }) {
  const trimmed = content.trim();
  if (
    !(trimmed.startsWith("{") || trimmed.startsWith("[")) ||
    !(trimmed.endsWith("}") || trimmed.endsWith("]"))
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    const formatted = JSON.stringify(parsed, null, 2);
    return (
      <div className="my-2">
        <div className="mb-2 flex items-center gap-2 text-sm text-gray-500">
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
            />
          </svg>
          <span className="font-medium">JSON</span>
        </div>
        <div className="overflow-hidden rounded-lg border border-gray-600/30 bg-gray-900">
          <pre className="overflow-x-auto p-4">
            <code className="block whitespace-pre font-mono text-sm text-gray-200">
              {formatted}
            </code>
          </pre>
        </div>
      </div>
    );
  } catch {
    return null;
  }
}

/* ─── Dot type for message-level indicator ─── */

type DotType = "gray" | "green" | "blink-green";

function getDotType(parts: any[]): DotType {
  let hasRunning = false;
  let hasTool = false;
  for (const p of parts) {
    if (p?.type === "tool-call") {
      hasTool = true;
      if (p?.status?.type === "running") hasRunning = true;
    }
  }
  if (hasRunning) return "blink-green";
  if (hasTool) return "green";
  return "gray";
}

/* ─── Assistant message ─── */

export default function AssistantMessage() {
  // IMPORTANT: call ALL hooks before any conditional early return so React's
  // hook-order invariant holds across renders (content shape changes during
  // streaming / clear-boundary insertion).
  const messageId = useAuiState((s) => s.message.id);
  const { toolProgressMap, taskMap, thinkingOpen, setThinkingOpen, retryLastUser, turnStatsByMessageId } = useLoopRuntimeExtra();
  const messageParts = useAuiState((s) => s.message.content);
  const textContent = useAuiState((s) => {
    const parts = s.message.content;
    if (!Array.isArray(parts)) return "";
    return parts
      .filter((p: { type: string }) => p.type === "text")
      .map((p: { text?: string }) => p.text ?? "")
      .join("");
  });
  // Retry icon only on the LAST completed (non-running) assistant message.
  const isRunning = useAuiState((s) => s.message.status?.type === "running");
  const isLast = useAuiState((s) => s.message.isLast);
  const showRetry = !isRunning && isLast && !textContent.startsWith("```bash");

  const time = extractTime(messageId);
  // Per-turn stats render once per turn, on the LAST assistant message of the
  // turn — which, after mergeAssistantStreaks, is this single merged bubble.
  // Present only for live-session turns that produced a model result.
  const turnStats = turnStatsByMessageId.get(messageId);

  const hasContent = Array.isArray(messageParts) && messageParts.some(
    (p: any) =>
      (p?.type === "text" && (p.text ?? "").length > 0) ||
      p?.type === "tool-call" ||
      p?.type === "reasoning" ||
      p?.type === "image" ||
      p?.type === "file",
  );
  if (!hasContent) return null;

  const dotType = Array.isArray(messageParts) ? getDotType(messageParts) : "gray";

  // Position dot at first-line-of-text height for text, or centered on tool bar for tool-call
  const firstVisiblePart = Array.isArray(messageParts)
    ? messageParts.find((p: any) => p?.type === "text" || p?.type === "tool-call")
    : null;
  const dotTopClass = firstVisiblePart?.type === "text" ? "top-[6px]" : "top-[17px]";

  const partsCount = Array.isArray(messageParts) ? messageParts.length : 0;
  const children = (
    <ErrorBoundary name="GroupedParts" resetKey={partsCount + ":" + isRunning} silent>
    <MessagePrimitive.GroupedParts
      groupBy={(part) => {
        try {
          if (part.type === "reasoning")
            return ["group-pillRow", "group-chainOfThought", "group-reasoning"];
          if (part.type === "tool-call")
            return ["group-pillRow", "group-toolCalls"];
        } catch { /* stale reactive proxy during streaming */ }
        return null;
      }}
    >
      {({ part, children }) => {
        try {
        switch (part.type) {
          case "group-pillRow":
            return (
              <div className="my-0.5 flex flex-wrap items-center gap-1">
                {children}
              </div>
            );
          case "group-chainOfThought":
            return <div data-slot="chain-of-thought" className="contents">{children}</div>;
          case "group-toolCalls":
            return <div className="w-full space-y-1">{children}</div>;
          case "group-reasoning": {
            const running = part.status.type === "running";
            const charCount = (part as any).indices?.reduce((sum: number, i: number) => {
              if (i >= messageParts.length) return sum;
              return sum + ((messageParts[i] as any)?.text?.length ?? 0);
            }, 0) ?? 0;
            const label = charCount > 0
              ? `Thinking · ${charCount.toLocaleString()} chars`
              : "Thinking";
            return (
              <Collapsible
                open={running ? true : thinkingOpen}
                onOpenChange={setThinkingOpen}
                className="group/think my-1 w-full overflow-hidden rounded-md border border-gray-100 bg-gray-50/50"
              >
                <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs transition-colors hover:bg-gray-100/50">
                  <BrainIcon className="h-3 w-3 shrink-0 text-gray-400" />
                  <span className="text-gray-400">{label}</span>
                  {running && (
                    <span className="shrink-0 rounded px-1 py-px text-[10px] font-medium text-gray-400">
                      thinking
                    </span>
                  )}
                  <ChevronDownIcon
                    className={cn(
                      "ml-auto h-3 w-3 shrink-0 text-gray-300 transition-transform",
                      (running || thinkingOpen) && "rotate-180",
                    )}
                  />
                </CollapsibleTrigger>
                <CollapsibleContent
                  className={cn(
                    "overflow-hidden",
                    "data-[state=open]:animate-collapsible-down",
                    "data-[state=closed]:animate-collapsible-up",
                  )}
                >
                  <div className="border-t border-gray-100 px-3 py-2">
                    <div className="max-h-64 overflow-y-auto text-[12px] text-gray-500 leading-relaxed">
                      {children}
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          }
          case "text": {
            const content = textContent;
            const jsonBlock = JsonBlock({ content });
            if (jsonBlock) {
              return <div>{jsonBlock}</div>;
            }
            return <MarkdownBlock />;
          }
          case "reasoning":
            return <MarkdownBlock />;
          case "tool-call": {
            const args = (part as any).args ?? {};
            const result = (part as any).result;
            const status = (part as any).status?.type ?? "complete";
            const toolCallId = (part as any).toolCallId as string | undefined;
            const toolName = (part as any).toolName ?? "Unknown";
            const toolProgress = toolCallId ? toolProgressMap.get(toolCallId) : undefined;
            const taskFromToolUseId = toolCallId
              ? Array.from(taskMap.values()).find((t) => t.tool_use_id === toolCallId)
              : undefined;
            return (
              <ErrorBoundary name={"ToolRenderer:" + toolName}>
                <ToolRenderer
                  toolName={toolName}
                  args={args}
                  result={result}
                  status={status}
                  elapsedSeconds={toolProgress?.elapsed_time_seconds}
                  taskState={taskFromToolUseId}
                  toolCallId={toolCallId}
                />
              </ErrorBoundary>
            );
          }
          default:
            return null;
        }
        } catch {
          return null;
        }
      }}
    </MessagePrimitive.GroupedParts>
    </ErrorBoundary>
  );

  return (
    <MessagePrimitive.Root
      data-role="assistant"
      data-message-id={messageId}
      className="group relative pl-6 md:pl-8"
    >
      {/* Vertical line gutter — dot sits on the line. Extends past bounds to bridge gap between messages */}
      <div className="absolute left-[5px] -top-2 -bottom-2 w-[2px] bg-gray-200" />

      {/* Dot indicator — positioned per first-content-type */}
      <div
        className={cn(
          "absolute left-[3px] z-10 h-[6px] w-[6px] rounded-full",
          dotTopClass,
          dotType === "gray" && "bg-gray-300",
          dotType === "green" && "bg-green-500",
          dotType === "blink-green" && "animate-[blink-green_2s_ease-in-out_infinite]",
        )}
      />

      {/* Content */}
      <div className="w-full text-[13px] md:text-sm text-gray-700">
        {children}
      </div>

      {/* Footer: time + retry + per-turn stats (stats only on the last
          assistant message of a live turn; retry only when completed) */}
      {(time || showRetry || turnStats) && (
        <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-400">
          {time && <span>{time}</span>}
          {showRetry && (
            <button
              type="button"
              onClick={retryLastUser}
              data-copy-ignore=""
              aria-label="Retry"
              className="inline-flex h-5 w-5 items-center justify-center rounded text-gray-400 transition-all hover:bg-gray-100 hover:text-gray-600 select-none opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            >
              <RotateCcwIcon className="h-3 w-3" />
            </button>
          )}
          {turnStats && (
            <span className="ml-auto tabular-nums select-none">
              {formatTurnStats(turnStats)}
            </span>
          )}
        </div>
      )}
    </MessagePrimitive.Root>
  );
}
