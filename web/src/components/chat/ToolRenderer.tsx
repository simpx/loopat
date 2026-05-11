import { useState, useEffect } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  LoaderIcon,
  XCircleIcon,
  AlertCircleIcon,
  PencilIcon,
  TerminalIcon,
  SearchIcon,
  FileTextIcon,
  GlobeIcon,
  WrenchIcon,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import TodoRenderer from "./TodoRenderer";
import AgentRenderer from "./AgentRenderer";
import type { TaskState } from "@/useLoopRuntime";

type ToolStatus = "running" | "complete" | "incomplete" | "requires-action";

interface ToolRendererProps {
  toolName: string;
  args: Record<string, unknown>;
  result?: string;
  status?: ToolStatus;
  elapsedSeconds?: number;
  taskState?: TaskState;
}

/* ─── Elapsed timer helpers ─── */

function formatElapsed(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return mins < 1 ? `${secs}s` : `${mins}m ${secs}s`;
}

function useElapsedTimer(isRunning: boolean, sdkSeconds?: number) {
  const [local, setLocal] = useState(0);

  useEffect(() => {
    if (!isRunning) {
      setLocal(0);
      return;
    }
    const start = Date.now();
    const timer = setInterval(() => {
      setLocal(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [isRunning]);

  if (sdkSeconds !== undefined && sdkSeconds > 0) return sdkSeconds;
  return local;
}

/* ─── Status badge config ─── */

const STATUS_CONFIG: Record<ToolStatus, { label: string; className: string }> = {
  running: { label: "Running", className: "bg-sky-100 text-sky-700" },
  complete: { label: "Done", className: "bg-emerald-100 text-emerald-700" },
  incomplete: { label: "Error", className: "bg-red-100 text-red-700" },
  "requires-action": { label: "Action needed", className: "bg-amber-100 text-amber-700" },
};

/* ─── Tool icon & category ─── */

interface ToolMeta {
  category: string;
  icon: React.ElementType;
  borderClass: string;
}

function getToolMeta(toolName: string): ToolMeta {
  const name = toolName || "";
  if (["Edit", "Write", "ApplyPatch"].includes(name)) {
    return { category: "edit", icon: PencilIcon, borderClass: "border-l-amber-400" };
  }
  if (name === "Bash") {
    return { category: "bash", icon: TerminalIcon, borderClass: "border-l-gray-400" };
  }
  if (["Grep", "Glob"].includes(name)) {
    return { category: "search", icon: SearchIcon, borderClass: "border-l-blue-400" };
  }
  if (name === "Read") {
    return { category: "read", icon: FileTextIcon, borderClass: "border-l-emerald-400" };
  }
  if (["WebSearch", "WebFetch"].includes(name)) {
    return { category: "web", icon: GlobeIcon, borderClass: "border-l-purple-400" };
  }
  if (name === "TodoWrite") {
    return { category: "todo", icon: CheckIcon, borderClass: "border-l-violet-400" };
  }
  if (["Agent", "Task"].includes(name)) {
    return { category: "agent", icon: PencilIcon, borderClass: "border-l-purple-400" };
  }
  return { category: "default", icon: WrenchIcon, borderClass: "border-l-gray-300" };
}

/* ─── Extract summary from args ─── */

function getSummary(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
      return (args.command as string) || (args.description as string) || "";
    case "Edit":
    case "Write":
    case "ApplyPatch":
      return (args.file_path as string) || (args.filePath as string) || "";
    case "Grep":
    case "Glob":
      return (args.pattern as string) || "";
    case "Read":
      return (args.file_path as string) || (args.filePath as string) || "";
    case "WebSearch":
    case "WebFetch":
      return (args.query as string) || (args.url as string) || "";
    case "TodoWrite":
      return (args.description as string) || "";
    case "Agent":
    case "Task":
      return (args.description as string) || (args.subagent_type as string) || "";
    default:
      return "";
  }
}

/* ─── Status icon ─── */

function StatusIcon({ status }: { status: ToolStatus }) {
  switch (status) {
    case "running":
      return <LoaderIcon className="h-3.5 w-3.5 animate-spin text-sky-500" />;
    case "complete":
      return <CheckIcon className="h-3.5 w-3.5 text-emerald-500" />;
    case "incomplete":
      return <XCircleIcon className="h-3.5 w-3.5 text-red-500" />;
    case "requires-action":
      return <AlertCircleIcon className="h-3.5 w-3.5 text-amber-500" />;
  }
}

/* ─── Diff renderer ─── */

interface DiffLine {
  type: "add" | "del" | "hdr" | "ctx";
  text: string;
}

function parseDiff(text: string): DiffLine[] | null {
  const lines = text.split("\n");
  let hasDiffMarkers = false;
  const parsed: DiffLine[] = [];

  for (const line of lines) {
    if (/^@@\s/.test(line)) {
      hasDiffMarkers = true;
      parsed.push({ type: "hdr", text: line });
    } else if (/^\+/.test(line)) {
      hasDiffMarkers = true;
      parsed.push({ type: "add", text: line });
    } else if (/^-/.test(line)) {
      hasDiffMarkers = true;
      parsed.push({ type: "del", text: line });
    } else if (/^(---|\+\+\+)/.test(line)) {
      hasDiffMarkers = true;
      parsed.push({ type: "hdr", text: line });
    } else {
      parsed.push({ type: "ctx", text: line });
    }
  }

  return hasDiffMarkers ? parsed : null;
}

function DiffView({ text }: { text: string }) {
  const diff = parseDiff(text);
  if (!diff) return null;

  return (
    <div className="overflow-hidden rounded-md border border-gray-200 bg-gray-50 font-mono text-xs leading-relaxed">
      {diff.map((line, i) => (
        <div
          key={i}
          className={cn(
            "px-3 py-px whitespace-pre-wrap break-all",
            line.type === "add" && "bg-emerald-50 text-emerald-800",
            line.type === "del" && "bg-red-50 text-red-800",
            line.type === "hdr" && "bg-blue-50 text-blue-700 font-medium",
            line.type === "ctx" && "text-gray-500",
          )}
        >
          {line.text}
        </div>
      ))}
    </div>
  );
}

/* ─── Code block ─── */

function CodeBlock({ text }: { text: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-gray-200 bg-gray-50 p-3 text-xs leading-relaxed text-gray-700 whitespace-pre-wrap break-all font-mono">
      {text}
    </pre>
  );
}

/* ─── Terminal block ─── */

function TerminalBlock({ command, output }: { command: string; output?: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-gray-700 bg-gray-900 text-xs">
      {command && (
        <div className="flex items-center gap-2 border-b border-gray-700 px-3 py-2 text-green-400 font-mono">
          <span className="select-none text-gray-500">$</span>
          <span className="whitespace-pre-wrap break-all">{command}</span>
        </div>
      )}
      {output !== undefined && (
        <pre className="max-h-64 overflow-auto px-3 py-2 text-gray-300 whitespace-pre-wrap font-mono leading-relaxed">
          {output}
        </pre>
      )}
    </div>
  );
}

/* ─── Main renderer ─── */

export default function ToolRenderer({
  toolName,
  args,
  result,
  status = "complete",
  elapsedSeconds,
  taskState,
}: ToolRendererProps) {
  const meta = getToolMeta(toolName);
  const Icon = meta.icon;
  const summary = getSummary(toolName, args);
  const [open, setOpen] = useState(status === "running");
  const isDone = status === "complete";
  const isRunning = status === "running";
  const statusCfg = STATUS_CONFIG[status];

  // Per-tool elapsed timer (SDK or local fallback)
  const elapsed = useElapsedTimer(isRunning, elapsedSeconds);

  const hasDiff = isDone && result ? parseDiff(result) !== null : false;
  const isBash = toolName === "Bash";
  const isTodo = toolName === "TodoWrite";
  const isAgent = toolName === "Agent" || toolName === "Task";

  // Parse todos from args
  const todos = isTodo
    ? (Array.isArray(args.todos)
        ? (args.todos as any[])
        : [])
    : null;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "group/tool my-1.5 overflow-hidden rounded-lg border border-gray-200 bg-white border-l-[3px]",
        meta.borderClass,
        isRunning && "animate-pulse",
      )}
    >
      <CollapsibleTrigger
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-gray-50"
      >
        <StatusIcon status={status} />
        <Icon className="h-3.5 w-3.5 shrink-0 text-gray-400" />
        <span className="font-medium text-gray-700 text-xs">{toolName}</span>

        {summary && (
          <>
            <span className="text-gray-300">·</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-gray-500">
              {summary}
            </span>
          </>
        )}

        {/* Elapsed time badge when running */}
        {isRunning && (
          <span className="ml-auto shrink-0 rounded px-1.5 py-px text-[10px] font-medium tabular-nums bg-sky-100 text-sky-700">
            {formatElapsed(elapsed)}
          </span>
        )}

        {!isRunning && (
          <span
            className={cn(
              "ml-auto shrink-0 rounded px-1.5 py-px text-[10px] font-medium",
              statusCfg.className,
            )}
          >
            {statusCfg.label}
          </span>
        )}

        <ChevronDownIcon
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-gray-300 transition-transform",
            open && "rotate-180",
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
          {/* Edit / Write / Patch — show diff if available */}
          {(toolName === "Edit" || toolName === "Write" || toolName === "ApplyPatch") && isDone && hasDiff && result ? (
            <DiffView text={result} />
          ) : null}

          {/* Bash — show terminal-style output */}
          {isBash && (
            <TerminalBlock
              command={summary}
              output={result}
            />
          )}

          {/* TodoWrite — checklist */}
          {isTodo && todos && (
            <TodoRenderer todos={todos} />
          )}

          {/* Agent / Task — sub-agent display */}
          {isAgent && (
            <AgentRenderer
              args={args}
              result={result}
              status={status}
              taskState={taskState}
              elapsedSeconds={elapsed}
            />
          )}

          {/* Fallback: show result as code, suppress JSON args */}
          {!isBash && !isTodo && !isAgent && !(hasDiff && (toolName === "Edit" || toolName === "Write" || toolName === "ApplyPatch")) && result !== undefined && (
            <CodeBlock text={typeof result === "string" ? result : JSON.stringify(result, null, 2)} />
          )}

          {/* Running state — show a subtle loading hint (non-special tools) */}
          {isRunning && !result && !isTodo && !isAgent && (
            <div className="flex items-center gap-2 py-1 text-xs text-gray-400">
              <LoaderIcon className="h-3 w-3 animate-spin" />
              Working...
            </div>
          )}

          {/* Error state */}
          {status === "incomplete" && (
            <div className="flex items-center gap-2 text-xs text-red-500">
              <XCircleIcon className="h-3.5 w-3.5" />
              Tool call failed
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
