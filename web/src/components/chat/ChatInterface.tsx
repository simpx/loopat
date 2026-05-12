import { useEffect, useRef, useState, useCallback, type FC } from "react";
import {
  ThreadPrimitive,
  AuiIf,
} from "@assistant-ui/react";
import { ArrowDownIcon } from "lucide-react";
import UserMessage from "./UserMessage";
import AssistantMessage from "./AssistantMessage";
import Composer from "./Composer";
import AskUserQuestionRenderer from "./AskUserQuestionRenderer";
import { useLoopRuntimeExtra } from "@/useLoopRuntime";
import ErrorBoundary from "./ErrorBoundary";

/* ─── Welcome screen ─── */

const ThreadWelcome: FC = () => {
  return (
    <div className="my-auto flex grow flex-col">
      <div className="flex w-full grow flex-col items-center justify-center">
        <div className="flex size-full flex-col justify-center px-4">
          <h1 className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both font-semibold text-xl md:text-2xl text-gray-900 duration-200">
            Hello there!
          </h1>
          <p className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-gray-500 text-lg md:text-xl delay-75 duration-200">
            How can I help you today?
          </p>
        </div>
      </div>
    </div>
  );
};

/* ─── Chat Interface ─── */

export default function ChatInterface({ archived = false, onUnarchive }: { archived?: boolean; onUnarchive?: () => void } = {}) {
  const { questions, sendAnswers } = useLoopRuntimeExtra();
  const containerRef = useRef<HTMLDivElement>(null);
  const vpRef = useRef<HTMLElement | null>(null);

  // Custom scroll-to-bottom button — only shows when scrolled > 200px from bottom
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const scrollToBottom = useCallback(() => {
    const vp = vpRef.current;
    if (!vp) return;
    vp.scrollTo({ top: vp.scrollHeight, behavior: "smooth" });
  }, []);

  // Auto-scroll to bottom: instant on first load, throttled during streaming.
  // Tracks whether the user has scrolled away via scroll events, so we know
  // their intent before content changes push them out of the near-bottom zone.
  const bottomRef = useRef<HTMLDivElement>(null);
  const didInitialScroll = useRef(false);
  useEffect(() => {
    const inner = containerRef.current;
    const vp = inner?.parentElement as HTMLElement | null;
    if (!inner || !vp) return;
    vpRef.current = vp;
    const nearBottom = () => vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 120;

    // Track user intent: if the user manually scrolls up, we stop following.
    // Reset when they scroll back to the bottom (or we programmatically put them there).
    let userScrolledUp = false;
    const onScroll = () => {
      if (nearBottom()) {
        userScrolledUp = false;
      } else {
        userScrolledUp = true;
      }
      // Show button when > 200px from bottom
      setShowScrollToBottom(vp.scrollTop + vp.clientHeight < vp.scrollHeight - 200);
    };
    vp.addEventListener("scroll", onScroll, { passive: true });

    let timer: ReturnType<typeof setTimeout> | null = null;
    const scroll = () => {
      if (didInitialScroll.current && userScrolledUp) return;
      if (!didInitialScroll.current && vp.scrollHeight > vp.clientHeight + 10) {
        const prev = vp.style.scrollBehavior;
        vp.style.scrollBehavior = "auto";
        vp.scrollTop = vp.scrollHeight;
        vp.style.scrollBehavior = prev;
        didInitialScroll.current = true;
        userScrolledUp = false;
      } else if (didInitialScroll.current) {
        vp.scrollTop = vp.scrollHeight;
      }
    };
    scroll();
    const ro = new ResizeObserver(() => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; scroll(); }, 80);
    });
    ro.observe(inner);
    return () => {
      ro.disconnect();
      if (timer) clearTimeout(timer);
      vp.removeEventListener("scroll", onScroll);
    };
  }, []);

  const questionEntries = questions.size > 0
    ? Array.from(questions.entries())
    : [];

  return (
    <ThreadPrimitive.Root
      className="flex h-full flex-col bg-white relative"
      style={
        {
          "--thread-max-width": "44rem",
        } as React.CSSProperties
      }
    >
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        className="relative flex-1 overflow-x-auto overflow-y-scroll scroll-smooth"
      >
        <div ref={containerRef} className="mx-auto flex w-full min-h-full flex-col px-2 md:px-3 pt-3 md:pt-4">
          {/* Empty state — matches thread.tsx: only show when truly empty & idle */}
          <AuiIf condition={(s) => s.thread.isEmpty && !s.thread.isRunning}>
            <ThreadWelcome />
          </AuiIf>

          {/* Message list */}
          <div className="flex flex-col gap-2 pb-3">
            <ThreadPrimitive.Messages>
              {({ message }) =>
                message.role === "user" ? (
                  <UserMessage />
                ) : (
                  <AssistantMessage />
                )
              }
            </ThreadPrimitive.Messages>
            <div ref={bottomRef} />
          </div>
        </div>
      </ThreadPrimitive.Viewport>

      {/* Footer — outside viewport so it stays fixed, never scrolls */}
      <div className="shrink-0 z-10 bg-gradient-to-t from-white via-white to-transparent px-2 md:px-3 pt-3 md:pt-4 pb-3 md:pb-6">
        {/* Pending questions (AskUserQuestion tool) — fixed above input */}
        {questionEntries.length > 0 && (
          <ErrorBoundary name="QuestionsPanel">
            <div className="mb-3 space-y-3 max-w-[44rem] mx-auto w-full">
              {questionEntries.map(([toolUseId, qs]) =>
                Array.isArray(qs) && qs.length > 0 ? (
                  <div
                    key={toolUseId}
                    className="rounded-lg border border-violet-200 bg-white p-4 shadow-md"
                  >
                    <AskUserQuestionRenderer
                      questions={qs}
                      toolUseId={toolUseId}
                      onAnswers={sendAnswers}
                      onDismiss={(id) => sendAnswers(id, {})}
                    />
                  </div>
                ) : null,
              )}
            </div>
          </ErrorBoundary>
        )}
        {archived ? (
          <div className="mx-3 md:mx-5 mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 flex items-center gap-2 text-[12px] text-amber-800">
            <span>📦</span>
            <span className="flex-1">This loop is archived (read-only).</span>
            {onUnarchive && (
              <button
                type="button"
                onClick={onUnarchive}
                className="rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
              >
                Unarchive
              </button>
            )}
          </div>
        ) : (
          <Composer />
        )}
      </div>

      {/* Scroll-to-bottom button — bottom-right, outside viewport so it isn't clipped */}
      {showScrollToBottom && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-40 right-4 z-20 flex h-7 w-7 items-center justify-center rounded-full bg-white border border-gray-200 shadow-sm text-gray-400 hover:text-gray-600 hover:border-gray-300 transition-all"
          aria-label="Scroll to bottom"
        >
          <ArrowDownIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </ThreadPrimitive.Root>
  );
}
