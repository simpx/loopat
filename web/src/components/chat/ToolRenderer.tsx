import { useState, useEffect } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  LoaderIcon,
  XCircleIcon,
  PencilIcon,
  TerminalIcon,
  SearchIcon,
  FileTextIcon,
  GlobeIcon,
  WrenchIcon,
  ExternalLink,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/lib/useIsMobile";
import TodoRenderer from "./TodoRenderer";
import AgentRenderer from "./AgentRenderer";
import PermissionPrompt from "./PermissionPrompt";
import { useLoopRuntimeExtra } from "@/useLoopRuntime";
import type { TaskState } from "@/useLoopRuntime";

type ToolStatus = "running" | "complete" | "incomplete" | "requires-action";

interface ToolRendererProps {
  toolName: string;
  args: Record<string, unknown>;
  result?: string;
  status?: ToolStatus;
  elapsedSeconds?: number;
  taskState?: TaskState;
  toolCallId?: string;
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

/* ─── Path shortening ─── */

function shortPath(p: string): string {
  // Strip absolute prefix down to the meaningful relative part
  const idx = p.indexOf("workdir/")
  if (idx !== -1) return p.slice(idx)
  const ctxIdx = p.indexOf("context/")
  if (ctxIdx !== -1) return p.slice(ctxIdx)
  // If it's an absolute /loopat/loops/<id>/... path, strip to last two segments
  const loopMatch = p.match(/\/loops\/[^/]+\/(.+)/)
  if (loopMatch) return loopMatch[1]
  return p
}

/* ─── Extract summary from args ─── */

function getSummary(toolName: string, args: Record<string, unknown>): string {
  const filePath = shortPath((args.file_path as string) || (args.filePath as string) || "");
  switch (toolName) {
    case "Bash":
      return (args.command as string) || (args.description as string) || "";
    case "Edit": {
      const base = filePath || "";
      const oldLines = ((args.old_string as string) ?? "").split("\n").length;
      const newLines = ((args.new_string as string) ?? "").split("\n").length;
      const delta = newLines - oldLines;
      const deltaStr = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : `±${oldLines}`;
      return base ? `${base} (${deltaStr} lines)` : "";
    }
    case "Write": {
      const content = (args.content as string) ?? "";
      return filePath ? `${filePath} (${content.length.toLocaleString()} chars)` : "";
    }
    case "ApplyPatch":
      return filePath || "";
    case "Grep":
    case "Glob":
      return (args.pattern as string) || "";
    case "Read":
      return filePath;
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

/* ─── Diff renderer with line numbers ─── */

interface DiffHunk {
  header: string
  lines: DiffLine[]
}

interface DiffLine {
  type: "add" | "del" | "ctx"
  oldNum: number | null
  newNum: number | null
  text: string
}

function parseDiff(raw: string): { filePath: string; hunks: DiffHunk[] } | null {
  const lines = raw.split("\n")
  let filePath = ""
  const hunks: DiffHunk[] = []
  let currentHunk: DiffHunk | null = null
  let oldNum = 0
  let newNum = 0
  let hasDiffMarkers = false

  for (const line of lines) {
    if (/^--- /.test(line)) {
      filePath = line.replace(/^--- /, "").replace(/\t.*$/, "")
      continue
    }
    if (/^\+\+\+ /.test(line)) {
      const to = line.replace(/^\+\+\+ /, "").replace(/\t.*$/, "")
      if (!filePath || filePath === "/dev/null") filePath = to
      if (to !== "/dev/null" && filePath !== to) filePath = `${filePath} → ${to}`
      continue
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/)
    if (hunkMatch) {
      hasDiffMarkers = true
      if (currentHunk) hunks.push(currentHunk)
      oldNum = parseInt(hunkMatch[1], 10)
      newNum = parseInt(hunkMatch[3], 10)
      currentHunk = { header: line, lines: [] }
      continue
    }

    if (!currentHunk) {
      if (/^[+-]/.test(line)) hasDiffMarkers = true
      continue
    }

    if (line.startsWith("+")) {
      currentHunk.lines.push({ type: "add", oldNum: null, newNum: newNum, text: line.slice(1) })
      newNum++
      hasDiffMarkers = true
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ type: "del", oldNum: oldNum, newNum: null, text: line.slice(1) })
      oldNum++
      hasDiffMarkers = true
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({ type: "ctx", oldNum: oldNum, newNum: newNum, text: line.slice(1) })
      oldNum++
      newNum++
    } else {
      currentHunk.lines.push({ type: "ctx", oldNum: oldNum, newNum: newNum, text: line })
      oldNum++
      newNum++
    }
  }
  if (currentHunk) hunks.push(currentHunk)

  return hasDiffMarkers ? { filePath, hunks } : null
}

function DiffView({ text, maxLines }: { text: string; maxLines?: number }) {
  const parsed = parseDiff(text)
  if (!parsed) return null

  let totalLines = 0
  let truncated = false
  const displayHunks = parsed.hunks.map((hunk) => {
    if (maxLines !== undefined && totalLines >= maxLines) {
      truncated = true
      return { ...hunk, lines: [] as DiffLine[] }
    }
    const remaining = maxLines !== undefined ? maxLines - totalLines : Infinity
    const lines = hunk.lines.slice(0, remaining)
    totalLines += lines.length
    if (maxLines !== undefined && lines.length < hunk.lines.length) truncated = true
    return { ...hunk, lines }
  })

  const total = parsed.hunks.reduce((s, h) => s + h.lines.length, 0)

  return (
    <div className="overflow-hidden rounded-md border border-gray-200 font-mono text-xs leading-5">
      {parsed.filePath && (
        <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-1.5 bg-gray-50">
          <FileTextIcon className="h-3 w-3 text-gray-400 shrink-0" />
          <span className="text-[10px] text-gray-500 truncate">{shortPath(parsed.filePath)}</span>
        </div>
      )}
      {displayHunks.map((hunk, hi) => (
        <div key={hi}>
          <div className="px-3 py-0.5 bg-blue-50/70 text-blue-700 font-medium border-b border-blue-100/50 text-[10px]">
            {hunk.header}
          </div>
          {hunk.lines.map((ln, li) => {
            const isAdd = ln.type === "add"
            const isDel = ln.type === "del"
            return (
              <div
                key={li}
                className={"flex " + (isAdd ? "bg-emerald-50/50" : isDel ? "bg-red-50/50" : "")}
              >
                <span className="w-12 shrink-0 text-right pr-2 py-px text-[9px] text-gray-300 select-none border-r border-gray-100 bg-gray-50/50">
                  {ln.oldNum ?? ""}
                </span>
                <span className={
                  "w-12 shrink-0 text-right pr-2 py-px text-[9px] select-none border-r border-gray-100 " +
                  (isAdd ? "bg-emerald-100/60 text-emerald-600" : isDel ? "bg-red-100/60 text-red-400" : "text-gray-300 bg-gray-50/50")
                }>
                  {ln.newNum ?? ""}
                </span>
                <span className={
                  "pl-2 py-px whitespace-pre-wrap break-all flex-1 " +
                  (isAdd ? "text-emerald-800" : isDel ? "text-red-700" : "text-gray-700")
                }>
                  <span className="select-none text-[9px] mr-1 opacity-50">
                    {isAdd ? "+" : isDel ? "−" : " "}
                  </span>
                  {ln.text}
                </span>
              </div>
            )
          })}
        </div>
      ))}
      {truncated && (
        <div className="px-3 py-1.5 text-[10px] text-gray-400 italic border-t border-gray-100 bg-gray-50/50">
          ... {total - (maxLines ?? total)} more lines
        </div>
      )}
    </div>
  )
}

/** Compact diff preview for collapsed state — line-number-free for space */
function DiffPreview({ text, maxLines = 8 }: { text: string; maxLines?: number }) {
  const parsed = parseDiff(text)
  if (!parsed) return null

  const flat: { type: "hdr" | "ctx" | "add" | "del"; text: string }[] = []
  for (const h of parsed.hunks) {
    flat.push({ type: "hdr", text: h.header })
    for (const l of h.lines) flat.push({ type: l.type, text: l.text })
  }

  const lines = flat.slice(0, maxLines)
  const truncated = flat.length > maxLines

  return (
    <div className="overflow-hidden rounded border border-gray-200 font-mono text-[10px] leading-relaxed opacity-70">
      {parsed.filePath && (
        <div className="px-2 py-0.5 bg-gray-50 border-b border-gray-100 text-gray-400 truncate">
          {shortPath(parsed.filePath)}
        </div>
      )}
      {lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            "px-2 py-px whitespace-pre-wrap break-all",
            line.type === "add" && "bg-emerald-50 text-emerald-800",
            line.type === "del" && "bg-red-50 text-red-800",
            line.type === "hdr" && "bg-blue-50 text-blue-700 font-medium",
            line.type === "ctx" && "text-gray-400",
          )}
        >
          {line.type === "hdr" ? line.text : line.type === "add" ? `+${line.text}` : line.type === "del" ? `-${line.text}` : ` ${line.text}`}
        </div>
      ))}
      {truncated && (
        <div className="px-2 py-0.5 text-gray-400 italic">...</div>
      )}
    </div>
  )
}

/* ─── Write content block with line numbers ─── */

function WriteContentBlock({ content, maxChars }: { content: string; maxChars?: number }) {
  const truncated = maxChars && content.length > maxChars
  const display = truncated ? content.slice(0, maxChars) : content
  const lines = display.split("\n")
  const lineCount = content.split("\n").length

  return (
    <div className="overflow-hidden rounded-md border border-gray-200 font-mono text-xs leading-5">
      <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-1.5 bg-gray-50">
        <FileTextIcon className="h-3 w-3 text-gray-400 shrink-0" />
        <span className="text-[10px] text-gray-500 truncate">
          {lineCount.toLocaleString()} lines · {content.length.toLocaleString()} chars
        </span>
      </div>
      <div className="overflow-auto max-h-80">
        {lines.map((line, i) => (
          <div key={i} className="flex">
            <span className="w-12 shrink-0 text-right pr-3 py-px text-[9px] text-gray-300 select-none border-r border-gray-100 bg-gray-50/50">
              {i + 1}
            </span>
            <span className="pl-2 py-px whitespace-pre-wrap break-all text-gray-700">{line}</span>
          </div>
        ))}
        {truncated && (
          <div className="pl-14 py-1 text-[10px] text-gray-400 italic">
            ... {content.length - (maxChars ?? 0)} more chars
          </div>
        )}
      </div>
    </div>
  )
}

function briefContent(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}

/* ─── Old→New string change block (for Edit without diff result) ─── */

function EditChangeBlock({ oldStr, newStr, maxLen }: { oldStr: string; newStr: string; maxLen?: number }) {
  const truncOld = maxLen && oldStr.length > maxLen
  const truncNew = maxLen && newStr.length > maxLen
  const displayOld = truncOld ? oldStr.slice(0, maxLen) : oldStr
  const displayNew = truncNew ? newStr.slice(0, maxLen) : newStr
  const oldLines = oldStr.split("\n")
  const newLines = newStr.split("\n")

  return (
    <div className="overflow-hidden rounded-md border border-gray-200 font-mono text-xs leading-5">
      <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-1 bg-red-50/50">
        <span className="text-[10px] text-red-500 font-medium">− {oldLines.length} line{oldLines.length !== 1 ? "s" : ""}</span>
      </div>
      {displayOld.split("\n").map((line, i) => (
        <div key={i} className="flex bg-red-50/30">
          <span className="w-10 shrink-0 text-right pr-2 py-px text-[9px] text-red-300 select-none border-r border-red-100">{i + 1}</span>
          <span className="pl-2 py-px whitespace-pre-wrap break-all text-red-800">{line}</span>
        </div>
      ))}
      {truncOld && <div className="px-3 py-0.5 text-[10px] text-red-400 italic bg-red-50/30">...</div>}
      <div className="flex items-center gap-2 border-y border-gray-200 px-3 py-1 bg-emerald-50/50">
        <span className="text-[10px] text-emerald-500 font-medium">+ {newLines.length} line{newLines.length !== 1 ? "s" : ""}</span>
      </div>
      {displayNew.split("\n").map((line, i) => (
        <div key={i} className="flex bg-emerald-50/30">
          <span className="w-10 shrink-0 text-right pr-2 py-px text-[9px] text-emerald-300 select-none border-r border-emerald-100">{i + 1}</span>
          <span className="pl-2 py-px whitespace-pre-wrap break-all text-emerald-800">{line}</span>
        </div>
      ))}
      {truncNew && <div className="px-3 py-0.5 text-[10px] text-emerald-400 italic bg-emerald-50/30">...</div>}
    </div>
  )
}

/* ─── Code block ─── */

function CodeBlock({ text }: { text: string }) {
  const lines = text.split("\n")
  return (
    <div className="overflow-hidden rounded-md border border-gray-200 font-mono text-xs leading-5">
      <div className="max-h-80 overflow-auto">
        {lines.map((line, i) => (
          <div key={i} className="flex">
            <span className="w-12 shrink-0 text-right pr-3 py-px text-[9px] text-gray-300 select-none border-r border-gray-100 bg-gray-50/50">
              {i + 1}
            </span>
            <span className="pl-2 py-px whitespace-pre-wrap break-all text-gray-700">{line}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ─── Terminal block ─── */

function TerminalBlock({ command, output }: { command: string; output?: string }) {
  return (
    <div className="overflow-hidden rounded-md bg-[#0d1117] border border-gray-700 text-xs">
      {command && (
        <div className="flex items-center gap-2 border-b border-gray-700/50 px-3 py-1.5 text-green-400 font-mono">
          <span className="select-none text-gray-500 text-[10px]">$</span>
          <span className="whitespace-pre-wrap break-all font-medium">{command}</span>
        </div>
      )}
      {output !== undefined && (
        <pre className="max-h-64 overflow-auto px-3 py-2 text-gray-300 whitespace-pre-wrap font-mono leading-relaxed">
          {output || <span className="text-gray-500 italic">(no output)</span>}
        </pre>
      )}
    </div>
  )
}

/* ─── Main renderer ─── */

export default function ToolRenderer({
  toolName,
  args,
  result,
  status = "complete",
  elapsedSeconds,
  taskState,
  toolCallId,
}: ToolRendererProps) {
  const meta = getToolMeta(toolName);
  const Icon = meta.icon;
  const summary = getSummary(toolName, args);
  const [open, setOpen] = useState(false);
  const isDone = status === "complete";
  const isRunning = status === "running";
  const isActionNeeded = status === "requires-action";
  const statusCfg = STATUS_CONFIG[status];
  const isMobile = useIsMobile();

  const { permissionPrompt, answerPermission, openFile } = useLoopRuntimeExtra();
  const needsPermission = isActionNeeded || (permissionPrompt?.toolUseId === toolCallId);

  // Auto-expand when waiting for permission
  const effectiveOpen = open || needsPermission;

  // Per-tool elapsed timer (SDK or local fallback)
  const elapsed = useElapsedTimer(isRunning, elapsedSeconds);

  const diff = isDone && result ? parseDiff(result) : null;
  const hasDiff = diff !== null;
  const isBash = toolName === "Bash";
  const isTodo = toolName === "TodoWrite";
  const isAgent = toolName === "Agent" || toolName === "Task";
  const isWrite = toolName === "Write";
  const isEdit = toolName === "Edit" || toolName === "ApplyPatch";
  const hasArgs = Object.keys(args).length > 0;

  const writeContent = (args.content as string) ?? "";
  const editOld = (args.old_string as string) ?? "";
  const editNew = (args.new_string as string) ?? "";
  const editHasChange = isEdit && editOld && editNew;

  const rawFilePath = (args.file_path as string) || (args.filePath as string) || ""
  const filePath = shortPath(rawFilePath)
  const canOpenInEditor = !!(openFile && filePath && isDone)

  // Parse todos from args
  const todos = isTodo
    ? (Array.isArray(args.todos)
        ? (args.todos as any[])
        : [])
    : null;

  // Collapsed preview content for Write/Edit (skip when permission prompt is forcing open)
  const collapsedPreview = !effectiveOpen
    ? isWrite && writeContent
      ? briefContent(writeContent, 200)
      : isEdit && (hasDiff || editHasChange)
        ? { type: "edit" as const, oldStr: editOld, newStr: editNew, diff }
        : null
    : null;

  return (
    <Collapsible
      open={effectiveOpen}
      onOpenChange={setOpen}
      className={cn(
        "group/tool my-1.5 overflow-hidden rounded-lg border border-gray-100 bg-gray-50/60 border-l-[3px]",
        meta.borderClass,
        isRunning && "animate-pulse",
      )}
    >
      <CollapsibleTrigger
        className="flex w-full flex-col text-left text-sm transition-colors hover:bg-gray-50"
      >
        {/* Title line */}
        <div className="flex w-full items-center gap-1.5 md:gap-2 px-2 md:px-3 py-1.5">
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

          {/* Status badge */}
          {needsPermission ? (
            <span className="ml-auto shrink-0 rounded px-1.5 py-px text-[10px] font-medium bg-amber-100 text-amber-700">
              Action needed
            </span>
          ) : isRunning ? (
            <span className="ml-auto shrink-0 rounded px-1.5 py-px text-[10px] font-medium tabular-nums bg-sky-100 text-sky-700">
              {formatElapsed(elapsed)}
            </span>
          ) : (
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
        </div>

        {/* Collapsed preview: brief content/diff when not expanded */}
        {collapsedPreview && (
          <div className="border-t border-gray-100 px-2 md:px-3 py-1.5">
            {typeof collapsedPreview === "string" ? (
              <pre className="font-mono text-[10px] leading-relaxed text-gray-500 whitespace-pre-wrap break-all line-clamp-3">
                {collapsedPreview}
              </pre>
            ) : collapsedPreview.type === "edit" ? (
              collapsedPreview.diff && result ? (
                <DiffPreview text={result} />
              ) : (
                <div className="opacity-70">
                  <EditChangeBlock oldStr={collapsedPreview.oldStr} newStr={collapsedPreview.newStr} maxLen={200} />
                </div>
              )
            ) : null}
          </div>
        )}
      </CollapsibleTrigger>

      <CollapsibleContent
        className={cn(
          "overflow-hidden",
          "data-[state=open]:animate-collapsible-down",
          "data-[state=closed]:animate-collapsible-up",
        )}
      >
        <div className={cn("border-t border-gray-100 px-2 md:px-3 py-2", isMobile && "max-h-[60vh] overflow-y-auto")}>
          {/* Permission prompt — shown when this tool needs user approval */}
          {needsPermission && permissionPrompt && (
            <PermissionPrompt
              toolName={permissionPrompt.toolName}
              title={permissionPrompt.title}
              displayName={permissionPrompt.displayName}
              onAllow={() => answerPermission(permissionPrompt.toolUseId, true)}
              onDeny={() => answerPermission(permissionPrompt.toolUseId, false)}
            />
          )}

          {/* Open in Editor — for tools that reference a file */}
          {canOpenInEditor && (
            <button
              type="button"
              onClick={() => openFile!(filePath)}
              className="inline-flex items-center gap-1 mb-2 px-2 py-1 rounded text-[11px] border border-gray-200 bg-white hover:bg-gray-50 text-gray-600 hover:text-gray-900 transition-colors"
            >
              <ExternalLink className="h-3 w-3" />
              Open in Editor
            </button>
          )}

          {/* Write — show full content with line numbers */}
          {isWrite && isDone && writeContent && (
            <WriteContentBlock content={writeContent} />
          )}

          {/* Edit / ApplyPatch — show diff (if result has one) or old→new change */}
          {isEdit && isDone && hasDiff && result && (
            <DiffView text={result} />
          )}
          {isEdit && isDone && !hasDiff && editHasChange && (
            <EditChangeBlock oldStr={editOld} newStr={editNew} />
          )}

          {/* Bash — show terminal-style output (only when there's content) */}
          {isBash && (summary || result !== undefined) && (
            <TerminalBlock
              command={summary}
              output={result}
            />
          )}

          {/* TodoWrite — checklist */}
          {isTodo && todos && todos.length > 0 && (
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
              toolCallId={toolCallId}
            />
          )}

          {/* Fallback: show result as code, suppress JSON args */}
          {!isWrite && !isBash && !isTodo && !isAgent && !(isEdit && (hasDiff || editHasChange)) && result !== undefined && (
            <CodeBlock text={typeof result === "string" ? result : JSON.stringify(result, null, 2)} />
          )}

          {/* Running state — show loader when no meaningful content yet (skip when waiting for permission) */}
          {isRunning && !needsPermission && !result && !hasArgs && !isAgent && !(isTodo && todos && todos.length > 0) && (
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
