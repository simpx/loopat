interface TokenUsagePieProps {
  used: number;
  total: number;
}

export default function TokenUsagePie({ used, total }: TokenUsagePieProps) {
  if (used == null || total == null || total <= 0) return null;

  const percentage = Math.min(100, (used / total) * 100);
  const radius = 10;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;

  const getColor = () => {
    if (percentage < 50) return "#3b82f6";
    if (percentage < 75) return "#f59e0b";
    return "#ef4444";
  };

  return (
    <div className="flex items-center gap-2 text-xs text-gray-500">
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
      <span title={`${used.toLocaleString()} / ${total.toLocaleString()} tokens`}>
        {percentage.toFixed(1)}%
      </span>
    </div>
  );
}
