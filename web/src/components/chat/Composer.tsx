import { useState } from "react";
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
import {
  ComposerAttachments,
  ComposerAddAttachment,
} from "@/components/assistant-ui/attachment";
import ClaudeStatus from "./ClaudeStatus";

import PlanModeToggle from "./PlanModeToggle";
import ModelSelector from "./ModelSelector";
import SlashCommand from "./SlashCommand";
import TokenUsagePie from "./TokenUsagePie";
import { useLoopRuntimeExtra } from "@/useLoopRuntime";

const FALLBACK_CONTEXT_WINDOW = 200_000;

function estimateTokens(messages: readonly unknown[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m === "object" && m !== null) {
      chars += JSON.stringify(m).length;
    }
  }
  return Math.round(chars / 3.5);
}

export default function Composer() {
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const hasInput = useAuiState(
    (s) => typeof s.composer.text === "string" && s.composer.text.trim().length > 0,
  );
  const composerText = useAuiState((s) => s.composer.text);

  const messagesArray = useAuiState((s) => s.thread.messages);
  const usedTokens = estimateTokens(messagesArray);
  const { provider, permissionMode, setPermissionMode, contextUsage, enqueueMessage, queue, clearQueue } = useLoopRuntimeExtra();
  const contextWindow = provider?.contextWindow ?? FALLBACK_CONTEXT_WINDOW;

  const aui = useAui();
  const [queueOpen, setQueueOpen] = useState(false);

  const handleEnqueue = () => {
    const text = typeof composerText === "string" ? composerText.trim() : "";
    if (!text) return;
    enqueueMessage(text);
    aui.composer().setText("");
  };

  return (
    <ComposerPrimitive.Root className="relative flex w-full flex-col">
      {/* Claude Status bar */}
      <ClaudeStatus isLoading={isRunning} tokenCount={usedTokens} />

      {/* Queue indicator */}
      {queue.length > 0 && (
        <div className="relative mb-1.5 pl-6 md:pl-8">
          <div className="absolute left-[3px] top-1/2 -translate-y-1/2 z-10 h-[6px] w-[6px] bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.4)]" />
          <div className="flex items-center gap-2 md:gap-3 text-xs text-gray-500 py-1">
            <button
              onClick={() => setQueueOpen(!queueOpen)}
              className="flex items-center gap-1 font-medium text-amber-600 hover:text-amber-700"
            >
              <ListOrderedIcon className="h-3.5 w-3.5" /> {queue.length} queued
            </button>
          </div>
          {queueOpen && (
            <>
              <div className="fixed inset-0 z-40 sm:hidden" onClick={() => setQueueOpen(false)} />
              <div className="absolute left-0 top-full mt-1 w-72 max-h-64 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg z-50">
                <div className="flex items-center justify-between p-2 border-b border-gray-100">
                  <span className="text-xs font-medium text-gray-500">Queued Messages</span>
                  <button
                    onClick={clearQueue}
                    className="text-xs text-gray-400 hover:text-red-500 p-1 rounded hover:bg-gray-50"
                    title="Clear queue"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                {queue.map((msg, i) => (
                  <div key={i} className="px-3 py-2 text-xs text-gray-700 border-b border-gray-50 last:border-b-0 truncate">
                    <span className="text-gray-400 mr-1.5">{i + 1}.</span>
                    {msg}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          data-slot="composer-shell"
          className="flex w-full flex-col gap-2 rounded-2xl border border-gray-200 bg-white p-2.5 shadow-sm"
        >
          <SlashCommand />

          <ComposerAttachments />

          <ComposerPrimitive.Input
            placeholder="Send a message..."
            className="max-h-32 min-h-10 w-full resize-none bg-transparent px-1.5 py-1 text-sm text-gray-900 outline-none placeholder:text-gray-400"
            rows={1}
            autoFocus
            aria-label="Message input"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && isRunning) {
                e.preventDefault();
                handleEnqueue();
              }
            }}
          />

          {/* Toolbar */}
          <div className="flex items-center justify-between gap-0.5 border-t border-gray-100 pt-2 overflow-hidden">
            <div className="flex items-center gap-0.5 min-w-0">
              <ComposerAddAttachment />

              <TokenUsagePie
                used={Math.min(usedTokens, contextWindow)}
                total={contextWindow}
                contextUsage={contextUsage}
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
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
}
