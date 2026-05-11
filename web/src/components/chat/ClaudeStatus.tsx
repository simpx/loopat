import { useEffect, useState } from "react";
import { BrainIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

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

interface ClaudeStatusProps {
  isLoading: boolean;
  onAbort?: () => void;
}

export default function ClaudeStatus({
  isLoading,
  onAbort,
}: ClaudeStatusProps) {
  const [elapsedTime, setElapsedTime] = useState(0);
  const [dots, setDots] = useState("");

  useEffect(() => {
    if (!isLoading) {
      setElapsedTime(0);
      return;
    }
    const startTime = Date.now();
    const timer = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    const dotTimer = setInterval(() => {
      setDots((prev) => (prev.length >= 3 ? "" : prev + "."));
    }, 500);

    return () => {
      clearInterval(timer);
      clearInterval(dotTimer);
    };
  }, [isLoading]);

  if (!isLoading) return null;

  const statusText =
    ACTION_WORDS[Math.floor(elapsedTime / 3) % ACTION_WORDS.length];

  return (
    <div className="mb-3 w-full">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 overflow-hidden rounded-full border border-gray-200 bg-gray-100 px-3 py-1.5 shadow-sm">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-100 ring-1 ring-blue-200">
            <BrainIcon className="h-3.5 w-3.5 text-blue-600" />
            <span className="absolute inset-0 animate-pulse rounded-full ring-2 ring-emerald-500/20" />
          </div>

          <div className="flex min-w-0 flex-col sm:flex-row sm:items-center sm:gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
              Claude
            </span>
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
              <p className="truncate text-xs font-medium text-gray-700">
                {statusText}
                <span className="inline-block w-4 text-blue-600">
                  {dots}
                </span>
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-md bg-gray-200/50 px-2 py-0.5 text-[10px] font-medium tabular-nums text-gray-500">
            {formatElapsedTime(elapsedTime)}
          </div>

          {onAbort && (
            <Button
              type="button"
              variant="destructive"
              size="xs"
              onClick={onAbort}
              className="group rounded-full text-[10px] font-bold"
            >
              <SquareIcon className="h-3 w-3 fill-current" />
              <span className="hidden sm:inline">STOP</span>
              <kbd className="hidden rounded bg-black/10 px-1 text-[9px] group-hover:bg-white/20 sm:block">
                ESC
              </kbd>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
