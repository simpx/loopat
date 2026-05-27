import { useEffect, useRef, useState, useCallback } from "react";
import {
  ComposerPrimitive,
  AuiIf,
  useAuiState,
  useAui,
} from "@assistant-ui/react";
import {
  ArrowUpIcon,
  SquareIcon,
  ListOrderedIcon,
  X,
  FileText,
  Plus,
  FilePlus,
  Target,
  CircleCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import ClaudeStatus from "./ClaudeStatus";

import PlanModeToggle from "./PlanModeToggle";
import ModelSelector from "./ModelSelector";
import PluginsButton from "./PluginsButton";
import SlashCommand from "./SlashCommand";
import TokenUsagePie from "./TokenUsagePie";
import { FilePicker } from "./FilePicker";
import { useLoopRuntimeExtra } from "@/useLoopRuntime";
import { getChatHistory, appendChatHistory, readFile } from "@/api";

const FALLBACK_CONTEXT_WINDOW = 200_000;
const MAX_HISTORY = 500;

export default function Composer({ pickedFile, editorSelection }: { pickedFile?: string | null; editorSelection?: { from: number; to: number } | null }) {
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const hasInput = useAuiState(
    (s) => typeof s.composer.text === "string" && s.composer.text.trim().length > 0,
  );
  const composerText = useAuiState((s) => s.composer.text);

  const { provider, permissionMode, setPermissionMode, enqueueMessage, queue, clearQueue, removeFromQueue, loopId, contextTokens, cumulativeTokens, getStreamingTokenCount, getWaitingForResponse, suppressSlashRef, goal, setGoal, goalStatus, completeGoal } = useLoopRuntimeExtra();
  const contextWindow = provider?.contextWindow ?? FALLBACK_CONTEXT_WINDOW;

  const aui = useAui();

  // ── File references ──
  const [includeEditorFile, setIncludeEditorFile] = useState(false)
  const [addedFiles, setAddedFiles] = useState<string[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)

  const allFileRefs = [
    ...(includeEditorFile && pickedFile ? [pickedFile] : []),
    ...addedFiles,
  ]

  const toggleEditorFile = () => setIncludeEditorFile((v) => !v)

  const addFile = (path: string) => {
    setAddedFiles((prev) => prev.includes(path) ? prev : [...prev, path])
    setPickerOpen(false)
  }

  const removeFile = (path: string) => {
    setAddedFiles((prev) => prev.filter((p) => p !== path))
  }

  const shortFileName = (path: string) => {
    const idx = path.lastIndexOf("/")
    return idx >= 0 ? path.slice(idx + 1) : path
  }

  // Pre-computed file context, updated when file refs change
  const fileContextRef = useRef("")
  const fileBlocksRef = useRef<{ path: string; content: string }[]>([])
  const [fileContextLoading, setFileContextLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function build() {
      if (allFileRefs.length === 0) {
        fileContextRef.current = ""
        fileBlocksRef.current = []
        return
      }
      setFileContextLoading(true)
      const parts: string[] = []
      const blocks: { path: string; content: string }[] = []
      for (const path of allFileRefs) {
        if (cancelled) return
        try {
          const r = await readFile(loopId, path)
          if (r && r.content) {
            const ext = path.includes(".") ? path.split(".").pop() ?? "" : ""
            const sel = (path === pickedFile) ? editorSelection : null
            let content = r.content
            let label = path
            if (sel) {
              const allLines = r.content.split("\n")
              const fromIdx = Math.max(0, sel.from - 1)
              const toIdx = Math.min(allLines.length, sel.to)
              content = allLines.slice(fromIdx, toIdx).join("\n")
              label = `${path} (${sel.from}-${sel.to})`
            }
            // Escape ``` in content so the regex-based parser in UserMessage can reliably detect boundaries
            const safe = content.replace(/```/g, "``​`")
            parts.push(`\n# File: ${label}\n\`\`\`${ext}\n${safe}\n\`\`\`\n`)
            blocks.push({ path: label, content })
          }
        } catch {}
      }
      if (!cancelled) {
        fileContextRef.current = parts.join("")
        fileBlocksRef.current = blocks
        setFileContextLoading(false)
      }
    }
    build()
    return () => { cancelled = true }
  }, [allFileRefs.join(","), loopId, pickedFile, editorSelection?.from, editorSelection?.to])

  const wrapWithContext = (text: string) => {
    const ctx = fileContextRef.current
    return ctx ? `${ctx}\n${text}` : text
  }

  // ── chat history ──
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const pendingDraftRef = useRef("");
  const textRef = useRef("");
  textRef.current = typeof composerText === "string" ? composerText : "";

  useEffect(() => {
    if (!loopId) return;
    getChatHistory(loopId).then((entries) => {
      setHistory(entries);
      setHistoryIdx(-1);
    });
  }, [loopId]);

  const saveToHistory = (text: string) => {
    if (!text.trim() || !loopId) return;
    const trimmed = text.trim();
    setHistory((prev) => {
      if (prev[prev.length - 1] === trimmed) return prev;
      const next = [...prev, trimmed];
      if (next.length > MAX_HISTORY) next.splice(0, next.length - MAX_HISTORY);
      return next;
    });
    setHistoryIdx(-1);
    appendChatHistory(loopId, trimmed).catch(() => {});
  };

  const handleEnqueue = () => {
    const text = typeof composerText === "string" ? composerText.trim() : "";
    if (!text) return;
    saveToHistory(text);
    if (fileContextRef.current) {
      try { sessionStorage.setItem("loopat:pendingFileContext", fileContextRef.current) } catch {}
    }
    enqueueMessage(wrapWithContext(text));
    aui.composer().setText("");
  };

  const handleSubmit = () => {
    const text = textRef.current.trim();
    if (!text) return;
    saveToHistory(text);
    if (fileContextRef.current) {
      try { sessionStorage.setItem("loopat:pendingFileContext", fileContextRef.current) } catch {}
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Ignore Enter during IME composition (e.g. Chinese input method
    // confirmation) to avoid prematurely sending unfinished text.
    if ((e.nativeEvent as any).isComposing || e.keyCode === 229) {
      return;
    }
    // Ctrl+C clears the input (macOS / Linux only; conflicts with copy on Windows).
    if (
      e.key === "c" &&
      e.ctrlKey &&
      !e.altKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !/windows/i.test(navigator.userAgent)
    ) {
      const ta = e.target as HTMLTextAreaElement
      if (ta.selectionStart === ta.selectionEnd && textRef.current.trim().length > 0) {
        e.preventDefault()
        aui.composer().setText("")
        return
      }
    }
    // Reset slash-suppression on any printable keystroke so the / menu
    // reappears once the user actually starts typing again.
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") {
      suppressSlashRef.current = false;
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing && !e.shiftKey && isRunning) {
      e.preventDefault();
      handleEnqueue();
      return;
    }
    if (e.key === "ArrowUp" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      if (history.length === 0) return;
      e.preventDefault();
      suppressSlashRef.current = true;
      if (historyIdx === -1) {
        pendingDraftRef.current = textRef.current;
        setHistoryIdx(history.length - 1);
        aui.composer().setText(history[history.length - 1]);
      } else if (historyIdx > 0) {
        const nextIdx = historyIdx - 1;
        setHistoryIdx(nextIdx);
        aui.composer().setText(history[nextIdx]);
      }
      return;
    }
    if (e.key === "ArrowDown" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      if (historyIdx === -1) return;
      e.preventDefault();
      suppressSlashRef.current = true;
      if (historyIdx < history.length - 1) {
        const nextIdx = historyIdx + 1;
        setHistoryIdx(nextIdx);
        aui.composer().setText(history[nextIdx]);
      } else {
        setHistoryIdx(-1);
        aui.composer().setText(pendingDraftRef.current);
      }
      return;
    }
  };

  return (
    <ComposerPrimitive.Root className="relative flex w-full flex-col" onSubmit={handleSubmit}>
      {/* Claude Status bar */}
      <ClaudeStatus isLoading={isRunning} getTokenCount={getStreamingTokenCount} getWaitingForResponse={getWaitingForResponse} />

      {/* Queue: inline items with per-item remove */}
      {queue.length > 0 && (
        <div className="mb-1.5 space-y-1 px-2">
          {queue.map((msg, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-2 bg-gray-50 border border-gray-200 rounded-md px-2.5 py-1.5"
            >
              <span className="text-xs text-gray-600 line-clamp-3 break-words whitespace-pre-wrap min-w-0">
                <span className="text-gray-400 mr-1.5 shrink-0">{i + 1}.</span>
                {msg}
              </span>
              <button
                onClick={() => removeFromQueue(i)}
                className="text-gray-400 hover:text-gray-600 shrink-0 p-0.5 rounded hover:bg-gray-100 transition-colors"
                title="Remove from queue"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* File references chips */}
      {allFileRefs.length > 0 && (
        <div className="flex items-center gap-1.5 px-1 mb-1 flex-wrap">
          {allFileRefs.map((path) => (
            <span
              key={path}
              className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] text-blue-700"
            >
              <FileText size={11} className="shrink-0" />
              <span className="truncate max-w-[160px]">{shortFileName(path)}</span>
              {path !== pickedFile && (
                <button
                  onClick={() => removeFile(path)}
                  className="ml-0.5 hover:text-blue-900"
                >
                  <X size={11} />
                </button>
              )}
              {path === pickedFile && includeEditorFile && (
                <span className="text-[9px] text-blue-400 ml-0.5">
                  {editorSelection ? `(${editorSelection.from}-${editorSelection.to})` : "editor"}
                </span>
              )}
            </span>
          ))}
          {fileContextLoading && (
            <span className="text-[10px] text-gray-400">loading...</span>
          )}
        </div>
      )}

      {/* Goal banner — shown when a /goal is active */}
      {goal && (
        <div className={`mb-1.5 flex items-center gap-2 px-2 py-1.5 rounded-lg border group ${
          goalStatus === "completed"
            ? "border-green-200 bg-green-50"
            : "border-amber-200 bg-amber-50"
        }`}>
          {goalStatus === "completed" ? (
            <CircleCheck className="h-3.5 w-3.5 text-green-600 shrink-0" />
          ) : (
            <Target className="h-3.5 w-3.5 text-amber-600 shrink-0" />
          )}
          <span className={`text-xs font-medium truncate flex-1 min-w-0 ${
            goalStatus === "completed"
              ? "text-green-800 line-through"
              : "text-amber-800"
          }`}>{goal}</span>
          {goalStatus === "active" && (
            <button
              onClick={() => completeGoal?.()}
              className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium text-amber-700 hover:bg-amber-200 opacity-0 group-hover:opacity-100 transition-opacity"
              title="Mark goal as complete"
            >
              Done
            </button>
          )}
          <button
            onClick={() => setGoal?.(null)}
            className="shrink-0 p-0.5 rounded hover:bg-amber-200/50 opacity-0 group-hover:opacity-100 transition-opacity"
            title="Clear goal"
          >
            <X className={`h-3 w-3 ${goalStatus === "completed" ? "text-green-500" : "text-amber-600"}`} />
          </button>
        </div>
      )}

      <div
        data-slot="composer-shell"
        className="flex w-full flex-col gap-2 rounded-2xl border border-gray-200 bg-white p-2.5 shadow-sm"
      >
        <SlashCommand />

        <ComposerPrimitive.Input
            placeholder="Send a message..."
            className="max-h-32 min-h-10 w-full resize-none bg-transparent px-1.5 py-1 text-sm text-gray-900 outline-none placeholder:text-gray-400"
            rows={1}
            autoFocus
            aria-label="Message input"
            onKeyDown={handleKeyDown}
          />

          {/* Toolbar */}
          <div className="flex items-center justify-between gap-0.5 border-t border-gray-100 pt-2 overflow-hidden">
            <div className="flex items-center gap-0.5 min-w-0">
              <TokenUsagePie
                used={Math.min(contextTokens, contextWindow)}
                total={contextWindow}
              />

              <ModelSelector />

              <PluginsButton
                onPick={(slashCommand) => {
                  const current = textRef.current
                  const next = current.length === 0 || current.endsWith(" ")
                    ? `${current}${slashCommand}`
                    : `${current} ${slashCommand}`
                  aui.composer().setText(next)
                }}
              />

              {/* File reference buttons */}
              {pickedFile && (
                <button
                  type="button"
                  onClick={toggleEditorFile}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] transition-colors ${
                    includeEditorFile
                      ? "bg-blue-50 text-blue-600 border border-blue-200"
                      : "text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                  }`}
                  title={includeEditorFile ? "Remove editor file from context" : "Include editor file in context"}
                >
                  <FileText size={12} />
                  {shortFileName(pickedFile)}
                </button>
              )}
              <button
                type="button"
                onClick={() => setPickerOpen((v) => !v)}
                className="inline-flex items-center justify-center rounded-md border border-gray-200 bg-gray-50 w-[21px] h-[21px] mt-px text-gray-500 hover:bg-gray-100 transition-colors"
                title="Add file to context"
              >
                <FilePlus size={12} />
              </button>
              {pickerOpen && (
                <FilePicker loopId={loopId} onPick={addFile} onClose={() => setPickerOpen(false)} />
              )}
            </div>

            <div className="flex items-center gap-1 sm:gap-2 shrink-0">
              <PlanModeToggle
                mode={permissionMode}
                onChange={setPermissionMode}
              />

              {/* Send / Enqueue button */}
              {hasInput && (
                isRunning ? (
                  <Button
                    type="button"
                    variant="default"
                    size="icon"
                    onClick={handleEnqueue}
                    className="h-8 w-8 rounded-lg bg-amber-500 hover:bg-amber-600 text-white"
                    aria-label="Enqueue message"
                    title="Enqueue message"
                  >
                    <ListOrderedIcon className="h-4 w-4" />
                  </Button>
                ) : (
                  <ComposerPrimitive.Send asChild>
                    <Button
                      type="button"
                      variant="default"
                      size="icon"
                      className="h-8 w-8 rounded-lg bg-gray-800 hover:bg-gray-900 text-white"
                      aria-label="Send message"
                    >
                      <ArrowUpIcon className="h-4 w-4" />
                    </Button>
                  </ComposerPrimitive.Send>
                )
              )}

              {/* Stop button: only visible when running */}
              <AuiIf condition={(s) => s.thread.isRunning}>
                <ComposerPrimitive.Cancel asChild>
                  <Button
                    type="button"
                    variant="default"
                    size="icon"
                    className="h-8 w-8 rounded-lg bg-red-500 hover:bg-red-600 text-white"
                    aria-label="Stop generating"
                  >
                    <SquareIcon className="h-3 w-3 fill-current" />
                  </Button>
                </ComposerPrimitive.Cancel>
              </AuiIf>
            </div>
          </div>
        </div>
    </ComposerPrimitive.Root>
  );
}
