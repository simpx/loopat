import { useEffect, useRef, useState, useCallback, type FC } from "react";
import {
  ThreadPrimitive,
  useAuiState,
  useComposerRuntime,
} from "@assistant-ui/react";
import { ArrowDownIcon, GitBranch } from "lucide-react";
import UserMessage from "./UserMessage";
import AssistantMessage from "./AssistantMessage";
import Composer from "./Composer";
import AskUserQuestionRenderer from "./AskUserQuestionRenderer";

import { useLoopRuntimeExtra } from "@/useLoopRuntime";
import ErrorBoundary from "./ErrorBoundary";

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

export default function ChatInterface({ archived = false, onUnarchive, readOnly = false, repo, branch, title, driver, driverHistory, rfdRequestedAt, rfdRequestedBy, onTakeDrive, pickedFile, editorSelection }: { archived?: boolean; onUnarchive?: () => void; readOnly?: boolean; repo?: string; branch?: string; title?: string; driver?: string; driverHistory?: Array<{ driver: string; since: string }>; rfdRequestedAt?: string; rfdRequestedBy?: string; onTakeDrive?: () => void; pickedFile?: string | null; editorSelection?: { from: number; to: number } | null } = {}) {
  const { questions, sendAnswers, loadingHistory, loopId, hasHistory, showHistory, toggleShowHistory, hasOlderMessages, loadMoreMessages, thinkingBudget, setMaxThinkingTokens } = useLoopRuntimeExtra();
  const [thinkingNullMode, setThinkingNullMode] = useState<"normal" | "ultra">("normal")
  const isEmpty = useAuiState((s) => s.thread.isEmpty && !s.thread.isRunning) && !loadingHistory;
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
    setLoadingMore(true);
    loadMoreMessages();
  }, [loadMoreMessages]);

  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  loadingMoreRef.current = loadingMore;

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
    // Track upward wheel events so we can suppress auto-scroll immediately,
    // before the user has scrolled past the 120px nearBottom() threshold.
    // Without this, during rapid streaming the user can never escape the
    // nearBottom() zone — each ResizeObserver tick yanks them back down.
    let wheelUpTimer: ReturnType<typeof setTimeout> | null = null;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        userScrolledUp = true;
        if (wheelUpTimer) clearTimeout(wheelUpTimer);
        wheelUpTimer = setTimeout(() => {
          wheelUpTimer = null;
          if (nearBottom()) userScrolledUp = false;
        }, 200);
      }
    };
    const onScroll = () => {
      // Only reset userScrolledUp when near bottom if there's no pending
      // upward-wheel timer — otherwise the onWheel handler's timer will
      // decide once the user stops scrolling.
      if (!wheelUpTimer && nearBottom()) {
        userScrolledUp = false;
      } else if (!nearBottom()) {
        userScrolledUp = true;
      }
      setShowScrollToBottom(vp.scrollTop + vp.clientHeight < vp.scrollHeight - 200);
      setShowHistoryButton(vp.scrollTop < 20 && hasHistoryRef.current);
      // Auto-load when scrolled near top
      if (vp.scrollTop < 40 && hasOlderRef.current && !loadingMoreRef.current) {
        handleLoadMore();
      }
    };
    vp.addEventListener("scroll", onScroll, { passive: true });
    vp.addEventListener("wheel", onWheel, { passive: true });

    let timer: ReturnType<typeof setTimeout> | null = null;
    let suppressScroll = false;
    const scroll = () => {
      if (didInitialScroll.current && userScrolledUp) return;
      // After a programmatic scroll, briefly suppress re-triggers to break
      // the cycle: scrollTop change → content-visibility renders →
      // layout shift → ResizeObserver → scroll → ...
      if (suppressScroll) return;
      if (!didInitialScroll.current && vp.scrollHeight <= vp.clientHeight + 10) return;
      const prev = vp.style.scrollBehavior;
      vp.style.scrollBehavior = "auto";
      vp.scrollTop = vp.scrollHeight;
      vp.style.scrollBehavior = prev;
      if (!didInitialScroll.current) {
        if (!loadingHistoryRef.current) {
          didInitialScroll.current = true;
        }
        userScrolledUp = false;
      }
      // Suppress ResizeObserver callbacks for 120ms after a programmatic
      // scroll to let content-visibility settle without re-triggering.
      suppressScroll = true;
      requestAnimationFrame(() => {
        setTimeout(() => { suppressScroll = false; }, 120);
      });
    };
    scroll();
    const ro = new ResizeObserver(() => {
      if (timer) return;
      if (loadingHistoryRef.current) return;
      if (suppressScroll) return;
      timer = setTimeout(() => { timer = null; scroll(); }, 80);
    });
    ro.observe(inner);
    return () => {
      ro.disconnect();
      if (timer) clearTimeout(timer);
      if (wheelUpTimer) clearTimeout(wheelUpTimer);
      vp.removeEventListener("scroll", onScroll);
      vp.removeEventListener("wheel", onWheel);
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

  // Reset loading spinner after messages render.
  useEffect(() => {
    if (!loadingMore) return;
    const timer = setTimeout(() => setLoadingMore(false), 200);
    return () => clearTimeout(timer);
  }, [loadingMore, hasOlderMessages]);

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
        className={isEmpty ? "hidden" : "relative flex-1 overflow-x-auto overflow-y-scroll scroll-smooth"}
      >
        <div ref={containerRef} className="mx-auto flex w-full min-h-full flex-col px-2 md:px-3 pt-3 md:pt-4">
          {/* Loading state — show skeleton while history is being replayed */}
          {loadingHistory && (
            <HistoryLoading />
          )}

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

          {/* Loading spinner — shown briefly while older messages render */}
          {loadingMore && (
            <div className="flex justify-center py-2">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-500" />
            </div>
          )}

          {/* Driver handoff timeline. First entry is the creator at creation
              time — drop it; subsequent entries are real handoffs and the
              ones worth surfacing. Anchored at the top of the viewport so
              users skimming the conversation see who's been driving and when
              control changed hands. Timestamps stay explicit so handoffs can
              be correlated with nearby messages. */}
          {(driverHistory ?? []).length > 1 && (
            <div className="flex flex-col gap-1 pb-2">
              {(driverHistory ?? []).slice(1).map((h) => (
                <div key={h.since} className="flex items-center gap-2 text-[11px] text-gray-500">
                  <div className="flex-1 h-px bg-gray-200" />
                  <span className="text-gray-600">
                    <span className="text-amber-600">▸</span>{" "}driving by <span className="text-gray-900 font-medium">{h.driver}</span> since {new Date(h.since).toLocaleString()}
                  </span>
                  <div className="flex-1 h-px bg-gray-200" />
                </div>
              ))}
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

            {/* Pending questions (AskUserQuestion tool) — inside scroll,
                rendered as part of the message list so they don't cover history. */}
            {questionEntries.length > 0 && (
              <ErrorBoundary name="QuestionsPanel">
                <div className="space-y-3 w-full pt-2">
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
          </div>
        </div>
      </ThreadPrimitive.Viewport>

      {/* Footer — outside viewport so it stays fixed, never scrolls.
          When thread is empty the footer fills the page and is centered. */}
      <div className={isEmpty ? "flex-1 flex items-center justify-center px-2 md:px-3 pb-3 md:pb-6" : "shrink-0 z-10 bg-gradient-to-t from-white via-white to-transparent px-2 md:px-3 pt-1 md:pt-2 pb-3 md:pb-6"}>
        <div className={isEmpty ? "w-full max-w-[36rem]" : ""}>
        {/* Empty-state info & settings — repo info + thinking depth */}
        {isEmpty && (
          <div className="mb-4 space-y-2 px-4">
            <div className="flex items-baseline gap-3">
              {title && (
                <h1 className="text-xl font-semibold text-gray-800">{title}</h1>
              )}
              {driver && (
                <span className="text-xs text-gray-400">driver: {driver}</span>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-gray-400">
              {repo && (
                <span className="flex items-center gap-1.5 min-w-0">
                  <GitBranch className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                  <span className="font-mono truncate">{repo}{branch ? <span className="text-gray-300"> · {branch}</span> : ""}</span>
                </span>
              )}
              <span className="ml-auto flex gap-0.5">
                  {[
                    { label: "Normal", tokens: null, mode: "normal" },
                    { label: "Think", tokens: 16000, mode: "think" },
                    { label: "Hard", tokens: 32000, mode: "hard" },
                    { label: "Ultrathink", tokens: null, mode: "ultra" },
                  ].map((opt) => {
                    const active = opt.mode === "normal"
                      ? thinkingBudget === null && thinkingNullMode === "normal"
                      : opt.mode === "ultra"
                        ? thinkingBudget === null && thinkingNullMode === "ultra"
                        : thinkingBudget === opt.tokens
                    return (
                      <button
                        key={opt.label}
                        type="button"
                        onClick={() => {
                          setThinkingNullMode(opt.mode === "normal" ? "normal" : opt.mode === "ultra" ? "ultra" : "normal")
                          setMaxThinkingTokens(opt.tokens)
                        }}
                        className={
                          "px-1.5 py-0.5 text-[11px] rounded transition-colors " +
                          (active
                            ? "bg-gray-200 text-gray-700 font-medium"
                            : "text-gray-400 hover:text-gray-600 hover:bg-gray-100")
                        }
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </span>
            </div>
          </div>
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
        ) : rfdRequestedAt ? (
          <div className="mx-3 md:mx-5 mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 flex items-center gap-2 text-[12px] text-amber-800">
            <span>✋</span>
            <span className="flex-1">
              Released for drive{rfdRequestedBy ? ` by ${rfdRequestedBy}` : ""} — no one can write until someone takes over.
            </span>
            {onTakeDrive && (
              <button
                type="button"
                onClick={onTakeDrive}
                className="rounded bg-amber-500 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-amber-600"
              >
                Drive
              </button>
            )}
          </div>
        ) : readOnly ? null : (
          <Composer pickedFile={pickedFile} editorSelection={editorSelection} />
        )}
        </div>
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
