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
  const { provider, permissionMode, setPermissionMode, contextUsage, enqueueMessage, queue, clearQueue, removeFromQueue } = useLoopRuntimeExtra();
  const contextWindow = provider?.contextWindow ?? FALLBACK_CONTEXT_WINDOW;

  const aui = useAui();

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

      {/* Queue: inline items with per-item remove */}
      {queue.length > 0 && (
        <div className="mb-1.5 space-y-1 px-2">
          {queue.map((msg, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-2 bg-gray-50 border border-gray-200 rounded-md px-2.5 py-1.5"
            >
              <span className="text-xs text-gray-600 truncate min-w-0">
                <span className="text-gray-400 mr-1.5">{i + 1}.</span>
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
