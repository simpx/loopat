import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ContextUsage } from "@/useLoopRuntime";

interface TokenUsagePieProps {
  used: number;
  total: number;
  contextUsage?: ContextUsage | null;
}

export default function TokenUsagePie({ used, total, contextUsage }: TokenUsagePieProps) {
  // Prefer server-reported accurate data over client estimate
  const displayTotal = contextUsage?.maxTokens || total;
  const displayUsed = contextUsage?.totalTokens ?? used;
  const displayPercentage = contextUsage?.percentage ?? Math.min(100, (used / total) * 100);

  if (!displayTotal || displayTotal <= 0) return null;

  const percentage = Math.min(100, displayPercentage);
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;

  const getColor = () => {
    if (percentage < 50) return "#3b82f6";
    if (percentage < 75) return "#f59e0b";
    return "#ef4444";
  };

  // Accurate tag shows when server data is available
  const accurate = !!contextUsage;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 text-xs text-gray-500">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            className="-rotate-90 transform"
          >
            <circle
              cx="12"
              cy="12"
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-gray-300"
            />
            <circle
              cx="12"
              cy="12"
              r={radius}
              fill="none"
              stroke={getColor()}
              strokeWidth="2"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              strokeLinecap="round"
            />
          </svg>
          <span>
            {percentage.toFixed(0)}%{accurate ? "" : "~"}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <div className="text-xs">
          <p>
            {displayUsed.toLocaleString()} / {displayTotal.toLocaleString()} tokens
          </p>
          {accurate && (
            <p className="text-gray-400 mt-0.5">
              {contextUsage!.model}
            </p>
          )}
          {!accurate && (
            <p className="text-gray-400 mt-0.5">estimated (run /usage for accurate)</p>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
