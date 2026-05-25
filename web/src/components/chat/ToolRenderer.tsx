import { useState, useEffect, useMemo } from "react";
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
import hljs from "highlight.js";
import "highlight.js/styles/github.css";
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

function highlightLine(text: string, lang?: string): string | null {
  if (!lang) return null
  try {
    const r = hljs.highlight(text, { language: lang, ignoreIllegals: true })
    return r.value
  } catch { return null }
}

function useHighlightedLines(lines: string[], lang?: string): (string | null)[] {
  return useMemo(() => lines.map(l => highlightLine(l, lang)), [lines, lang])
}

function DiffView({ text, maxLines, lang }: { text: string; maxLines?: number; lang?: string }) {
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

  const allLines = displayHunks.flatMap(h => h.lines.map(l => l.text))
  const highlighted = useHighlightedLines(allLines, lang)
  let lineIdx = 0

  const total = parsed.hunks.reduce((s, h) => s + h.lines.length, 0)

  return (
    <div className="overflow-hidden rounded-md font-mono text-xs leading-5" style={{ border: `1px solid var(--cm-code-border)`, backgroundColor: "var(--cm-code-bg)", color: "var(--cm-text)" }}>
      {parsed.filePath && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] truncate" style={{ borderBottom: `1px solid var(--cm-border)`, color: "var(--cm-gutter)" }}>
          <FileTextIcon className="h-3 w-3 shrink-0" style={{ color: "var(--cm-gutter)" }} />
          <span>{shortPath(parsed.filePath)}</span>
        </div>
      )}
      {displayHunks.map((hunk, hi) => (
        <div key={hi}>
          <div className="px-3 py-0.5 font-medium text-[10px]" style={{ backgroundColor: "var(--cm-diff-hdr-bg)", color: "var(--cm-diff-hdr-text)", borderBottom: `1px solid var(--cm-border)` }}>
            {hunk.header}
          </div>
          {hunk.lines.map((ln, li) => {
            const isAdd = ln.type === "add"
            const isDel = ln.type === "del"
            const lineNum = ln.newNum ?? ln.oldNum ?? ""
            const hl = highlighted[lineIdx++]
            return (
              <div
                key={li}
                className="flex"
                style={{ backgroundColor: isAdd ? "var(--cm-diff-add-bg)" : isDel ? "var(--cm-diff-del-bg)" : "transparent" }}
              >
                <span className="w-10 shrink-0 text-right pr-2 py-px text-[9px] select-none border-r" style={{
                  color: isAdd ? "var(--cm-diff-add-text)" : isDel ? "var(--cm-diff-del-text)" : "var(--cm-gutter)",
                  borderColor: "var(--cm-border)",
                }}>
                  {lineNum}
                </span>
                <span className={`pl-2 py-px whitespace-pre-wrap break-all flex-1 ${isAdd ? "diff-line-add" : isDel ? "diff-line-del" : "diff-line-ctx"}`}>
                  <span className="select-none text-[9px] mr-1 opacity-50">
                    {isAdd ? "+" : isDel ? "−" : " "}
                  </span>
                  {hl ? (
                    <span dangerouslySetInnerHTML={{ __html: hl }} />
                  ) : (
                    ln.text
                  )}
                </span>
              </div>
            )
          })}
        </div>
      ))}
      {truncated && (
        <div className="px-3 py-1.5 text-[10px] italic" style={{ borderTop: `1px solid var(--cm-border)`, color: "var(--cm-gutter)" }}>
          ... {total - (maxLines ?? total)} more lines
        </div>
      )}
    </div>
  )
}

/** Compact diff preview for collapsed state — line-number-free for space */
function DiffPreview({ text, maxLines = 8, lang }: { text: string; maxLines?: number; lang?: string }) {
  const parsed = parseDiff(text)
  if (!parsed) return null

  const flat: { type: "hdr" | "ctx" | "add" | "del"; text: string }[] = []
  for (const h of parsed.hunks) {
    flat.push({ type: "hdr", text: h.header })
    for (const l of h.lines) flat.push({ type: l.type, text: l.text })
  }

  const lines = flat.slice(0, maxLines)
  const truncated = flat.length > maxLines
  const codeLines = lines.filter(l => l.type !== "hdr")
  const highlighted = useHighlightedLines(codeLines.map(l => l.text), lang)
  let hlIdx = 0

  return (
    <div className="overflow-hidden rounded font-mono text-[10px] leading-relaxed opacity-80" style={{ border: `1px solid var(--cm-code-border)`, backgroundColor: "var(--cm-code-bg)" }}>
      {parsed.filePath && (
        <div className="px-2 py-0.5 truncate" style={{ borderBottom: `1px solid var(--cm-border)`, color: "var(--cm-gutter)" }}>
          {shortPath(parsed.filePath)}
        </div>
      )}
      {lines.map((line, i) => {
        const isCode = line.type !== "hdr"
        const hl = isCode ? highlighted[hlIdx++] : null
        const prefix = line.type === "add" ? "+" : line.type === "del" ? "−" : " "
        return (
          <div
            key={i}
            className={`px-2 py-px whitespace-pre-wrap break-all ${line.type === "add" ? "diff-line-add" : line.type === "del" ? "diff-line-del" : line.type === "ctx" ? "diff-line-ctx" : ""}`}
            style={{
              backgroundColor: line.type === "add" ? "var(--cm-diff-add-bg)" : line.type === "del" ? "var(--cm-diff-del-bg)" : line.type === "hdr" ? "var(--cm-diff-hdr-bg)" : "transparent",
              ...(line.type === "hdr" ? { color: "var(--cm-diff-hdr-text)", fontWeight: 500 } : {}),
            }}
          >
            {isCode ? (
              <>
                <span className="select-none opacity-50 mr-0.5">{prefix}</span>
                {hl ? <span dangerouslySetInnerHTML={{ __html: hl }} /> : line.text}
              </>
            ) : line.text}
          </div>
        )
      })}
      {truncated && (
        <div className="px-2 py-0.5 italic" style={{ color: "var(--cm-gutter)" }}>...</div>
      )}
    </div>
  )
}

/* ─── Write content block with line numbers ─── */

function WriteContentBlock({ content, maxChars, lang }: { content: string; maxChars?: number; lang?: string }) {
  const truncated = maxChars && content.length > maxChars
  const display = truncated ? content.slice(0, maxChars) : content
  const lineCount = content.split("\n").length

  const highlighted = useMemo(() => {
    try {
      if (lang) {
        const r = hljs.highlight(display, { language: lang, ignoreIllegals: true })
        return r.value
      }
    } catch {}
    return null
  }, [display, lang])

  const lines = display.split("\n")

  return (
    <div className="overflow-hidden rounded-md font-mono text-xs leading-5" style={{ border: `1px solid var(--cm-code-border)`, backgroundColor: "var(--cm-code-bg)" }}>
      <div className="flex items-center gap-2 px-3 py-1.5 text-[10px]" style={{ borderBottom: `1px solid var(--cm-border)`, color: "var(--cm-gutter)" }}>
        <FileTextIcon className="h-3 w-3 shrink-0" />
        {lang ? `${lang} · ` : ""}{lineCount.toLocaleString()} lines · {content.length.toLocaleString()} chars
      </div>
      <div className="overflow-auto max-h-80">
        {highlighted ? (
          <div className="flex">
            <div className="shrink-0 text-right text-[9px] select-none" style={{ color: "var(--cm-gutter)", borderRight: `1px solid var(--cm-border)`, minWidth: "3rem" }}>
              {lines.map((_, i) => (
                <div key={i} className="pr-3 py-px">{i + 1}</div>
              ))}
            </div>
            <pre className="flex-1 pl-2 py-px whitespace-pre-wrap break-all" dangerouslySetInnerHTML={{ __html: highlighted }} />
          </div>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="flex">
              <span className="w-12 shrink-0 text-right pr-3 py-px text-[9px] select-none border-r" style={{ color: "var(--cm-gutter)", borderColor: "var(--cm-border)" }}>
                {i + 1}
              </span>
              <span className="pl-2 py-px whitespace-pre-wrap break-all" style={{ color: "var(--cm-text)" }}>{line}</span>
            </div>
          ))
        )}
        {truncated && (
          <div className="pl-14 py-1 text-[10px] italic" style={{ color: "var(--cm-gutter)" }}>
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

/* ─── Line-based diff (LCS) for EditChangeBlock ─── */

function lineDiff(oldLines: string[], newLines: string[]): { type: "del" | "add" | "ctx"; oldNum: number | null; newNum: number | null; text: string }[] {
  const m = oldLines.length, n = newLines.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = oldLines[i - 1] === newLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])

  const result: { type: "del" | "add" | "ctx"; oldNum: number | null; newNum: number | null; text: string }[] = []
  let i = m, j = n
  const stack: typeof result = []
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      stack.push({ type: "ctx", oldNum: i, newNum: j, text: oldLines[i - 1] })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      stack.push({ type: "add", oldNum: null, newNum: j, text: newLines[j - 1] })
      j--
    } else {
      stack.push({ type: "del", oldNum: i, newNum: null, text: oldLines[i - 1] })
      i--
    }
  }
  return stack.reverse()
}

function EditChangeBlock({ oldStr, newStr, maxLen, lang }: { oldStr: string; newStr: string; maxLen?: number; lang?: string }) {
  const oldLines = oldStr.split("\n")
  const newLines = newStr.split("\n")
  const diff = useMemo(() => lineDiff(oldLines, newLines), [oldStr, newStr])
  const truncated = maxLen !== undefined && diff.length > maxLen
  const display = truncated ? diff.slice(0, maxLen) : diff
  const highlighted = useHighlightedLines(display.map(d => d.text), lang)
  let lineIdx = 0

  return (
    <div className="overflow-hidden rounded-md font-mono text-xs leading-5" style={{ border: `1px solid var(--cm-code-border)` }}>
      <div className="flex items-center gap-2 px-3 py-1 text-[10px]" style={{ borderBottom: `1px solid var(--cm-border)`, color: "var(--cm-gutter)" }}>
        {oldLines.length} → {newLines.length} lines · {diff.filter(d => d.type !== "ctx").length} changes
      </div>
      {display.map((ln, i) => {
        const isDel = ln.type === "del"
        const isAdd = ln.type === "add"
        const lineNum = ln.newNum ?? ln.oldNum ?? ""
        const hl = highlighted[lineIdx++]
        return (
          <div key={i} className="flex" style={{
            backgroundColor: isDel ? "var(--cm-diff-del-bg)" : isAdd ? "var(--cm-diff-add-bg)" : "transparent",
          }}>
            <span className="w-10 shrink-0 text-right pr-2 py-px text-[9px] select-none border-r" style={{
              color: isAdd ? "var(--cm-diff-add-text)" : isDel ? "var(--cm-diff-del-text)" : "var(--cm-gutter)",
              borderColor: "var(--cm-border)",
            }}>
              {lineNum}
            </span>
            <span className={`pl-2 py-px whitespace-pre-wrap break-all flex-1 ${isDel ? "diff-line-del" : isAdd ? "diff-line-add" : "diff-line-ctx"}`}>
              <span className="select-none text-[9px] mr-1 opacity-50">
                {isDel ? "−" : isAdd ? "+" : " "}
              </span>
              {hl ? (
                <span dangerouslySetInnerHTML={{ __html: hl }} />
              ) : (
                ln.text
              )}
            </span>
          </div>
        )
      })}
      {truncated && (
        <div className="px-3 py-1 text-[10px] italic" style={{ color: "var(--cm-gutter)" }}>
          ... {diff.length - (maxLen ?? 0)} more lines
        </div>
      )}
    </div>
  )
}

/* ─── Code block ─── */

function CodeBlock({ text, lang }: { text: string; lang?: string }) {
  const lines = text.split("\n")

  const highlighted = useMemo(() => {
    try {
      if (lang) {
        const r = hljs.highlight(text, { language: lang, ignoreIllegals: true })
        return r.value
      } else {
        const r = hljs.highlightAuto(text)
        if (r.language) return r.value
      }
    } catch {}
    return null
  }, [text, lang])

  return (
    <div className="overflow-hidden rounded-md font-mono text-xs leading-5" style={{ border: `1px solid var(--cm-code-border)`, backgroundColor: "var(--cm-code-bg)" }}>
      <div className="max-h-80 overflow-auto">
        {highlighted ? (
          <div className="flex">
            <div className="shrink-0 text-right text-[9px] select-none" style={{ color: "var(--cm-gutter)", borderRight: `1px solid var(--cm-border)`, minWidth: "3rem" }}>
              {lines.map((_, i) => (
                <div key={i} className="pr-3 py-px">{i + 1}</div>
              ))}
            </div>
            <pre className="flex-1 pl-2 py-px whitespace-pre-wrap break-all" dangerouslySetInnerHTML={{ __html: highlighted }} />
          </div>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="flex">
              <span className="w-12 shrink-0 text-right pr-3 py-px text-[9px] select-none border-r" style={{ color: "var(--cm-gutter)", borderColor: "var(--cm-border)" }}>
                {i + 1}
              </span>
              <span className="pl-2 py-px whitespace-pre-wrap break-all" style={{ color: "var(--cm-text)" }}>{line}</span>
            </div>
          ))
        )}
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

  // Detect language for syntax highlighting
  const codeLang = useMemo(() => {
    const ext = filePath.includes(".") ? filePath.split(".").pop()?.toLowerCase() ?? "" : ""
    const map: Record<string, string> = {
      js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
      py: "python", rs: "rust", go: "go", rb: "ruby", swift: "swift",
      java: "java", c: "c", cpp: "cpp", cs: "csharp", kt: "kotlin",
      json: "json", yaml: "yaml", yml: "yaml", toml: "ini", xml: "xml",
      html: "xml", htm: "xml", svg: "xml", css: "css", scss: "scss", less: "less",
      sql: "sql", sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
      md: "markdown", dockerfile: "dockerfile", proto: "protobuf",
      php: "php", lua: "lua", r: "r", scala: "scala",
    }
    return map[ext] || (ext && ext.length <= 5 ? ext : "")
  }, [filePath])

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
                <DiffView text={result} lang={codeLang} maxLines={8} />
              ) : (
                <div className="opacity-70">
                  <EditChangeBlock oldStr={collapsedPreview.oldStr} newStr={collapsedPreview.newStr} maxLen={20} lang={codeLang} />
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
            <WriteContentBlock content={writeContent} lang={codeLang} />
          )}

          {/* Edit / ApplyPatch — show diff (if result has one) or old→new change */}
          {isEdit && isDone && hasDiff && result && (
            <DiffView text={result} lang={codeLang} />
          )}
          {isEdit && isDone && !hasDiff && editHasChange && (
            <EditChangeBlock oldStr={editOld} newStr={editNew} lang={codeLang} />
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
            <CodeBlock text={typeof result === "string" ? result : JSON.stringify(result, null, 2)} lang={codeLang} />
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
