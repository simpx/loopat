import { ClipboardList } from "lucide-react";
import { cn } from "@/lib/utils";

interface PlanModeToggleProps {
  active: boolean;
  onChange: (active: boolean) => void;
  className?: string;
}

export default function PlanModeToggle({
  active,
  onChange,
  className = "",
}: PlanModeToggleProps) {
  return (
    <button
      type="button"
      onClick={() => onChange(!active)}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-lg transition-all",
        active
          ? "bg-purple-100 text-purple-600 hover:bg-purple-200"
          : "bg-gray-100 text-gray-400 hover:bg-gray-200 hover:text-gray-500",
        className,
      )}
      title={active ? "Plan mode: on" : "Plan mode: off"}
      aria-label={active ? "Disable plan mode" : "Enable plan mode"}
    >
      <ClipboardList className="h-4 w-4" />
    </button>
  );
}
