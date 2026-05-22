import { useEffect, useState } from "react";
import { useLoopRuntimeExtra } from "@/useLoopRuntime";

const ACTION_WORDS = [
  "Thinking",
  "Processing",
  "Analyzing",
  "Working",
  "Computing",
  "Reasoning",
];

function formatElapsedTime(totalSeconds: number) {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return mins < 1 ? `${secs}s` : `${mins}m ${secs}s`;
}

function formatTokens(n: number) {
  if (n < 0) n = 0;
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

interface ClaudeStatusProps {
  isLoading: boolean;
  /** Stable getter that reads the latest streaming output tokens directly from
   *  the ref — no React re-render needed. The rAF loop polls this every frame. */
  getTokenCount: () => number;
  /** Stable getter for the waiting-for-first-token flag. True while an LLM
   *  request is in-flight with no tokens yet (arrow-up), false once streaming
   *  (arrow-down). Reset on each message_start within a turn. */
  getWaitingForResponse: () => boolean;
}

export default function ClaudeStatus({ isLoading, getTokenCount, getWaitingForResponse }: ClaudeStatusProps) {
  const { thinkingBudget, turnGeneration, turnStartedAt } = useLoopRuntimeExtra();
  const [elapsedTime, setElapsedTime] = useState(0);
  const [displayTokens, setDisplayTokens] = useState(0);
  const [ellipsis, setEllipsis] = useState("");

  // Elapsed timer + ellipsis cycle.
  // Uses turnStartedAt (persisted in sessionStorage) as the effective start
  // time when available, so the timer survives page refreshes during an
  // active generation.
  useEffect(() => {
    if (!isLoading) {
      setElapsedTime(0);
      setDisplayTokens(0);
      setEllipsis("");
      return;
    }
    const effectiveStart = turnStartedAt ?? Date.now();
    const timer = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - effectiveStart) / 1000));
    }, 250);
    const dotTimer = setInterval(() => {
      setEllipsis((prev) => (prev.length >= 3 ? "" : prev + "."));
    }, 400);
    return () => {
      clearInterval(timer);
      clearInterval(dotTimer);
    };
  }, [isLoading, turnGeneration, turnStartedAt]);

  // Smooth easing rAF loop — polls the getter every frame, no React re-render
  // needed on the hot content_block_delta path. Same pattern as the official
  // Claude Code TUI (SpinnerAnimationRow / useAnimationFrame(50)).
  useEffect(() => {
    if (!isLoading) return;

    let raf: number;
    const step = () => {
      const target = getTokenCount();
      setDisplayTokens((prev) => {
        if (Math.abs(target - prev) < 0.5) return target;
        const diff = target - prev;
        const speed = Math.max(1, Math.ceil(Math.abs(diff) / 8));
        return prev + Math.sign(diff) * Math.min(speed, Math.abs(diff));
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [isLoading, getTokenCount]);

  if (!isLoading) return null;

  const statusText =
    ACTION_WORDS[Math.floor(elapsedTime / 3) % ACTION_WORDS.length];

  // ↑ uploading (LLM request in-flight, no tokens yet), ↓ streaming.
  // Uses the getter directly so it switches immediately on message_start
  // without waiting for a React re-render.
  const arrow = getWaitingForResponse() ? "↑" : "↓";

  const budgetLabel =
    thinkingBudget === null
      ? null
      : thinkingBudget >= 32000
        ? "think-hard"
        : thinkingBudget >= 16000
          ? "think"
          : null;

  return (
    <div className="relative mb-1.5 pl-6 md:pl-8">

      {/* Morphing dot — vertically centered with text line */}
      <div className="absolute left-[3px] top-1/2 -translate-y-1/2 z-10 h-[6px] w-[6px] animate-[morph_2s_ease-in-out_infinite] bg-blue-500 shadow-[0_0_6px_rgba(59,130,246,0.4)]" />

      {/* Content */}
      <div className="flex items-center gap-2 md:gap-3 text-xs text-gray-500 py-1">
        {/* Status text + ellipsis */}
        <span className="font-medium text-gray-600">
          {statusText}<span className="inline-block w-4 tabular-nums">{ellipsis}</span>
        </span>

        {/* Thinking budget badge (skip ultrathink) */}
        {budgetLabel && (
          <>
            <span className="text-gray-300">·</span>
            <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600">
              {budgetLabel}
            </span>
          </>
        )}

        {/* Elapsed time — pushed right but not flush */}
        <span className="tabular-nums text-gray-500 ml-auto mr-1">
          {formatElapsedTime(elapsedTime)}
        </span>

        {/* Token count — this turn's streaming tokens, eased toward real value */}
        <span className="tabular-nums text-gray-600 font-medium">
          {arrow}{formatTokens(displayTokens)} tk
        </span>
      </div>
    </div>
  );
}
