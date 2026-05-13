import { useState } from "react";
import {
  ComposerPrimitive,
  AuiIf,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowUpIcon,
  SquareIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ComposerAttachments,
  ComposerAddAttachment,
} from "@/components/assistant-ui/attachment";
import ClaudeStatus from "./ClaudeStatus";
import ThinkingModeSelector from "./ThinkingModeSelector";
import PlanModeToggle from "./PlanModeToggle";
import ModelSelector from "./ModelSelector";
import SlashCommand from "./SlashCommand";
import TokenUsagePie from "./TokenUsagePie";
import { cn } from "@/lib/utils";
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
  const [thinkingMode, setThinkingMode] = useState("none");

  const isRunning = useAuiState((s) => s.thread.isRunning);
  const hasInput = useAuiState(
    (s) => typeof s.composer.text === "string" && s.composer.text.trim().length > 0,
  );

  const messagesArray = useAuiState((s) => s.thread.messages);
  const usedTokens = estimateTokens(messagesArray);
  const { provider, planMode, setPlanMode } = useLoopRuntimeExtra();
  const contextWindow = provider?.contextWindow ?? FALLBACK_CONTEXT_WINDOW;

  return (
    <ComposerPrimitive.Root className="relative flex w-full flex-col">
      {/* Claude Status bar */}
      <ClaudeStatus isLoading={isRunning} />

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
          />

          {/* Toolbar */}
          <div className="flex items-center justify-between gap-0.5 border-t border-gray-100 pt-2 overflow-hidden">
            <div className="flex items-center gap-0.5 min-w-0">
              <ComposerAddAttachment />

              <div className="hidden md:block">
                <ThinkingModeSelector
                  selectedMode={thinkingMode}
                  onModeChange={setThinkingMode}
                />
              </div>

              <div className="hidden sm:block">
                <TokenUsagePie
                  used={Math.min(usedTokens, contextWindow)}
                  total={contextWindow}
                />
              </div>

              <ModelSelector />
            </div>

            <div className="flex items-center gap-1 sm:gap-2 shrink-0">
              <PlanModeToggle
                active={planMode}
                onChange={setPlanMode}
              />

              <div
                className={cn(
                  "hidden text-xs text-gray-300 transition-opacity lg:block",
                  hasInput ? "opacity-0" : "opacity-100",
                )}
              >
                Enter to send
              </div>

              <AuiIf condition={(s) => !s.thread.isRunning}>
                <ComposerPrimitive.Send asChild>
                  <Button
                    type="button"
                    variant="default"
                    size="icon"
                    className="h-8 w-8 rounded-lg bg-gray-800 hover:bg-gray-900 text-white"
                    disabled={!hasInput}
                    aria-label="Send message"
                  >
                    <ArrowUpIcon className="h-4 w-4" />
                  </Button>
                </ComposerPrimitive.Send>
              </AuiIf>

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
