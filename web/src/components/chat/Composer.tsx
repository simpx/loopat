import { useEffect, useRef, useState } from "react";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import ClaudeStatus from "./ClaudeStatus";

import PlanModeToggle from "./PlanModeToggle";
import ModelSelector from "./ModelSelector";
import SlashCommand from "./SlashCommand";
import TokenUsagePie from "./TokenUsagePie";
import { useLoopRuntimeExtra } from "@/useLoopRuntime";
import { getChatHistory, appendChatHistory } from "@/api";

const FALLBACK_CONTEXT_WINDOW = 200_000;
const MAX_HISTORY = 500;

export default function Composer() {
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const hasInput = useAuiState(
    (s) => typeof s.composer.text === "string" && s.composer.text.trim().length > 0,
  );
  const composerText = useAuiState((s) => s.composer.text);

  const { provider, permissionMode, setPermissionMode, enqueueMessage, queue, clearQueue, removeFromQueue, loopId, contextTokens, cumulativeTokens, streamingTokenCount, suppressSlashRef } = useLoopRuntimeExtra();
  const contextWindow = provider?.contextWindow ?? FALLBACK_CONTEXT_WINDOW;

  const aui = useAui();

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
    enqueueMessage(text);
    aui.composer().setText("");
  };

  const handleSubmit = () => {
    const text = textRef.current.trim();
    if (text) saveToHistory(text);
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
    if (e.key === "Enter" && !e.shiftKey && isRunning) {
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
      <ClaudeStatus isLoading={isRunning} tokenCount={streamingTokenCount} />

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
