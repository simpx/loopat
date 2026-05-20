import { useEffect, useState, useRef } from "react";
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
  tokenCount: number;
}

export default function ClaudeStatus({ isLoading, tokenCount }: ClaudeStatusProps) {
  const { thinkingBudget } = useLoopRuntimeExtra();
  const [elapsedTime, setElapsedTime] = useState(0);
  const [displayTokens, setDisplayTokens] = useState(0);
  const [ellipsis, setEllipsis] = useState("");

  // Elapsed timer + ellipsis cycle
  useEffect(() => {
    if (!isLoading) {
      setElapsedTime(0);
      setDisplayTokens(0);
      setEllipsis("");
      return;
    }
    const startTime = Date.now();
    const timer = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
    }, 250);
    const dotTimer = setInterval(() => {
      setEllipsis((prev) => (prev.length >= 3 ? "" : prev + "."));
    }, 400);
    return () => {
      clearInterval(timer);
      clearInterval(dotTimer);
    };
  }, [isLoading]);

  // Keep target in sync so the rAF loop reads latest without re-subscribing
  const targetRef = useRef(0);
  targetRef.current = tokenCount;

  // Smooth easing rAF loop
  useEffect(() => {
    if (!isLoading) return;

    let raf: number;
    const step = () => {
      const target = targetRef.current;
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
  }, [isLoading]);

  if (!isLoading) return null;

  const statusText =
    ACTION_WORDS[Math.floor(elapsedTime / 3) % ACTION_WORDS.length];

  // ↑ uploading (request sent, no response yet), ↓ streaming (tokens coming in)
  const arrow = tokenCount > 0 ? "↓" : "↑";

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
