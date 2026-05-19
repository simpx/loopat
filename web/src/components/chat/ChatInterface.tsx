import { useEffect, useRef, useState, useCallback, type FC } from "react";
import {
  ThreadPrimitive,
  AuiIf,
  useAuiState,
  useComposerRuntime,
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

/* ─── History loading spinner ─── */

const HistoryLoading: FC = () => {
  return (
    <div className="my-auto flex grow flex-col items-center justify-center gap-3">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600" />
      <p className="text-sm text-gray-400">Loading history…</p>
    </div>
  );
};

/* ─── Composer draft cache ─── */

const DRAFT_STORAGE_KEY = "loopat:composer:drafts";

function getDraft(loopId: string): string | null {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const drafts = JSON.parse(raw) as Record<string, string>;
    return drafts[loopId] ?? null;
  } catch {
    return null;
  }
}

function setDraft(loopId: string, text: string): void {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    const drafts: Record<string, string> = raw ? JSON.parse(raw) : {};
    if (text.trim()) {
      drafts[loopId] = text;
    } else {
      delete drafts[loopId];
    }
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // ignore storage errors
  }
}

/* ─── Chat Interface ─── */

export default function ChatInterface({ archived = false, onUnarchive, readOnly = false }: { archived?: boolean; onUnarchive?: () => void; readOnly?: boolean } = {}) {
  const { questions, sendAnswers, loadingHistory, loopId, hasHistory, showHistory, toggleShowHistory, hasOlderMessages, loadMoreMessages } = useLoopRuntimeExtra();
  const containerRef = useRef<HTMLDivElement>(null);
  const vpRef = useRef<HTMLElement | null>(null);

  // Custom scroll-to-bottom button — only shows when scrolled > 200px from bottom
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const scrollToBottom = useCallback(() => {
    const vp = vpRef.current;
    if (!vp) return;
    vp.scrollTo({ top: vp.scrollHeight, behavior: "smooth" });
  }, []);

  // Ref-backed copies so the scroll listener (which runs in a []-memoized effect)
  // always sees the latest values without re-subscribing.
  const hasHistoryRef = useRef(hasHistory);
  hasHistoryRef.current = hasHistory;
  const showHistoryRef = useRef(showHistory);
  showHistoryRef.current = showHistory;
  const hasOlderRef = useRef(hasOlderMessages);
  hasOlderRef.current = hasOlderMessages;

  // Scroll-to-top history button — shows when user scrolls to the very top
  // and there is pre-clear history to reveal.
  const [showHistoryButton, setShowHistoryButton] = useState(false);

  // Scroll-anchor refs: preserve scroll position when history is toggled
  const scrollAnchorRef = useRef({ oldScrollTop: 0, oldScrollHeight: 0, active: false });
  const handleShowHistory = useCallback(() => {
    const vp = vpRef.current;
    if (vp) {
      scrollAnchorRef.current = {
        oldScrollTop: vp.scrollTop,
        oldScrollHeight: vp.scrollHeight,
        active: true,
      };
    }
    toggleShowHistory();
  }, [toggleShowHistory]);

  // Scroll-anchor for load-more: preserve position when older messages appear above
  const loadMoreAnchorRef = useRef({ oldScrollTop: 0, oldScrollHeight: 0, active: false });
  const handleLoadMore = useCallback(() => {
    const vp = vpRef.current;
    if (vp) {
      loadMoreAnchorRef.current = {
        oldScrollTop: vp.scrollTop,
        oldScrollHeight: vp.scrollHeight,
        active: true,
      };
    }
    loadMoreMessages();
  }, [loadMoreMessages]);

  const [showLoadMoreButton, setShowLoadMoreButton] = useState(false);

  // Persist composer text across loop switches and page refresh.
  const composer = useComposerRuntime();
  const composerText = useAuiState((s) => s.composer.text);
  const composerTextRef = useRef(composerText);
  composerTextRef.current = composerText;

  // Load draft from localStorage on mount
  useEffect(() => {
    const draft = getDraft(loopId);
    if (draft) {
      composer.setText(draft);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save draft to localStorage on unmount and when text changes
  useEffect(() => {
    return () => {
      setDraft(loopId, composerTextRef.current);
    };
  }, [loopId]);

  // Also save when text changes (debounced)
  useEffect(() => {
    if (!composerText) return;
    const timer = setTimeout(() => {
      setDraft(loopId, composerText);
    }, 300);
    return () => clearTimeout(timer);
  }, [composerText, loopId]);

  // Clear draft when message is sent (composer text becomes empty after send)
  const [prevText, setPrevText] = useState(composerText);
  useEffect(() => {
    // If user manually cleared the input, also clear storage
    if (prevText && !composerText) {
      setDraft(loopId, "");
    }
    setPrevText(composerText);
  }, [composerText, loopId]);

  // Auto-scroll to bottom: instant on load, throttled during streaming.
  // During history replay (loadingHistory=true), keep snapping to bottom on
  // every content change without setting didInitialScroll — content-visibility
  // may cause scrollHeight to be underestimated until all messages render.
  const bottomRef = useRef<HTMLDivElement>(null);
  const didInitialScroll = useRef(false);
  const loadingHistoryRef = useRef(loadingHistory);
  loadingHistoryRef.current = loadingHistory;
  const prevLoading = useRef(loadingHistory);
  useEffect(() => {
    const inner = containerRef.current;
    const vp = inner?.parentElement as HTMLElement | null;
    if (!inner || !vp) return;
    vpRef.current = vp;
    const nearBottom = () => vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 120;

    let userScrolledUp = false;
    const onScroll = () => {
      if (nearBottom()) {
        userScrolledUp = false;
      } else {
        userScrolledUp = true;
      }
      setShowScrollToBottom(vp.scrollTop + vp.clientHeight < vp.scrollHeight - 200);
      setShowHistoryButton(vp.scrollTop < 20 && hasHistoryRef.current);
      setShowLoadMoreButton(vp.scrollTop < 20 && hasOlderRef.current);
    };
    vp.addEventListener("scroll", onScroll, { passive: true });

    let timer: ReturnType<typeof setTimeout> | null = null;
    const scroll = () => {
      if (didInitialScroll.current && userScrolledUp) return;
      const prev = vp.style.scrollBehavior;
      vp.style.scrollBehavior = "auto";
      if (!didInitialScroll.current && vp.scrollHeight > vp.clientHeight + 10) {
        vp.scrollTop = vp.scrollHeight;
        if (!loadingHistoryRef.current) {
          didInitialScroll.current = true;
        }
        userScrolledUp = false;
      } else if (didInitialScroll.current && !loadingHistoryRef.current) {
        vp.scrollTop = vp.scrollHeight;
      }
      vp.style.scrollBehavior = prev;
    };
    scroll();
    const ro = new ResizeObserver(() => {
      if (timer) return;
      // During history loading content-visibility underestimates scrollHeight;
      // skip re-snapping — the loadingHistory change effect does one final scroll.
      if (loadingHistoryRef.current) return;
      timer = setTimeout(() => { timer = null; scroll(); }, 80);
    });
    ro.observe(inner);
    ro.observe(vp);
    return () => {
      ro.disconnect();
      if (timer) clearTimeout(timer);
      vp.removeEventListener("scroll", onScroll);
    };
  }, []);
  // When history finishes loading, do one final snap to bottom and finalize
  // initial-scroll.  No resize may happen at the exact moment loadingHistory
  // flips, so we drive the scroll directly.
  useEffect(() => {
    if (prevLoading.current && !loadingHistory) {
      const vp = vpRef.current;
      if (vp) {
        const prev = vp.style.scrollBehavior;
        vp.style.scrollBehavior = "auto";
        vp.scrollTop = vp.scrollHeight;
        vp.style.scrollBehavior = prev;
        didInitialScroll.current = true;
      }
    }
    prevLoading.current = loadingHistory;
  }, [loadingHistory]);

  // When showHistory toggles, preserve the user's visible scroll position
  // so prepended/removed messages don't cause a jump.
  useEffect(() => {
    if (!scrollAnchorRef.current.active) return;
    const vp = vpRef.current;
    if (!vp) return;
    const { oldScrollTop, oldScrollHeight } = scrollAnchorRef.current;
    scrollAnchorRef.current.active = false;
    requestAnimationFrame(() => {
      const delta = vp.scrollHeight - oldScrollHeight;
      vp.scrollTop = oldScrollTop + delta;
    });
  }, [showHistory]);

  // When loadMore increases renderCount, preserve scroll position so
  // older messages appearing at top don't cause a jump.
  useEffect(() => {
    if (!loadMoreAnchorRef.current.active) return;
    const vp = vpRef.current;
    if (!vp) return;
    const { oldScrollTop, oldScrollHeight } = loadMoreAnchorRef.current;
    loadMoreAnchorRef.current.active = false;
    requestAnimationFrame(() => {
      const delta = vp.scrollHeight - oldScrollHeight;
      vp.scrollTop = oldScrollTop + delta;
    });
  }, [hasOlderMessages]);

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
          {/* Loading state — show skeleton while history is being replayed */}
          {loadingHistory && (
            <HistoryLoading />
          )}

          {/* Empty state — matches thread.tsx: only show when truly empty & idle */}
          <AuiIf condition={(s) => s.thread.isEmpty && !s.thread.isRunning}>
            <ThreadWelcome />
          </AuiIf>

          {/* View/collapse earlier messages — appears when scrolled to top and there is pre-clear history */}
          {showHistoryButton && (
            <div className="flex justify-center pb-2">
              <button
                type="button"
                onClick={handleShowHistory}
                className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs text-gray-500 hover:text-gray-700 hover:border-gray-300 shadow-sm transition-colors"
              >
                {showHistory ? "Collapse earlier messages" : "View earlier messages"}
              </button>
            </div>
          )}

          {/* Load earlier messages — appears when render window is smaller than total aggregated messages */}
          {showLoadMoreButton && (
            <div className="flex justify-center pb-2">
              <button
                type="button"
                onClick={handleLoadMore}
                className="rounded-full border border-gray-200 bg-white px-4 py-1.5 text-xs text-gray-500 hover:text-gray-700 hover:border-gray-300 shadow-sm transition-colors"
              >
                Load earlier messages
              </button>
            </div>
          )}

          {/* Message list */}
          <div className="flex flex-col gap-2 pb-1">
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
      <div className="shrink-0 z-10 bg-gradient-to-t from-white via-white to-transparent px-2 md:px-3 pt-1 md:pt-2 pb-3 md:pb-6">
        {/* Pending questions (AskUserQuestion tool) — fixed above input */}
        {questionEntries.length > 0 && (
          <ErrorBoundary name="QuestionsPanel">
            <div className="mb-3 space-y-3 max-w-[44rem] mx-auto w-full">
              {questionEntries.map(([toolUseId, qs]) =>
                Array.isArray(qs) && qs.length > 0 ? (
                  <div
                    key={toolUseId}
                    className="rounded-lg border border-violet-100 bg-violet-50/30 p-4 shadow-sm"
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
        ) : readOnly ? null : (
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
