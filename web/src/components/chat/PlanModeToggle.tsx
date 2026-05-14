import { useState } from "react";
import {
  Shield,
  PenLine,
  Zap,
  ClipboardList,
  FastForward,
  Sparkles,
  X,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger, PopoverClose } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Mirrors the SDK PermissionMode union. Kept in sync with
 * @anthropic-ai/claude-agent-sdk PermissionMode:
 *   'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'
 */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

const MODES: {
  id: PermissionMode;
  label: string;
  description: string;
  icon: React.ElementType;
  color: string;
  activeBg: string;
  activeBorder: string;
  activeHover: string;
}[] = [
  {
    id: "bypassPermissions",
    label: "YOLO",
    description: "Sandboxed — safe to proceed freely",
    icon: Zap,
    color: "text-green-600",
    activeBg: "bg-green-50",
    activeBorder: "border-green-200",
    activeHover: "hover:bg-green-100",
  },
  {
    id: "auto",
    label: "Auto",
    description: "Fully automatic, minimal prompts",
    icon: Sparkles,
    color: "text-amber-600",
    activeBg: "bg-amber-50",
    activeBorder: "border-amber-200",
    activeHover: "hover:bg-amber-100",
  },
  {
    id: "dontAsk",
    label: "Don't Ask",
    description: "Skip most confirmations",
    icon: FastForward,
    color: "text-blue-600",
    activeBg: "bg-blue-50",
    activeBorder: "border-blue-200",
    activeHover: "hover:bg-blue-100",
  },
  {
    id: "acceptEdits",
    label: "Accept Edits",
    description: "Auto-approve file edits, ask for rest",
    icon: PenLine,
    color: "text-yellow-600",
    activeBg: "bg-yellow-50",
    activeBorder: "border-yellow-200",
    activeHover: "hover:bg-yellow-100",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Plan first, then implement step by step",
    icon: ClipboardList,
    color: "text-purple-600",
    activeBg: "bg-purple-50",
    activeBorder: "border-purple-200",
    activeHover: "hover:bg-purple-100",
  },
  {
    id: "default",
    label: "Default",
    description: "Ask before each edit (safest)",
    icon: Shield,
    color: "text-gray-600",
    activeBg: "bg-gray-50",
    activeBorder: "border-gray-200",
    activeHover: "hover:bg-gray-100",
  },
];

interface PlanModeToggleProps {
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  className?: string;
}

export default function PlanModeToggle({
  mode,
  onChange,
  className = "",
}: PlanModeToggleProps) {
  const [open, setOpen] = useState(false);
  const current = MODES.find((m) => m.id === mode) ?? MODES[0];
  const CurrentIcon = current.icon;
  const isDefault = mode === "bypassPermissions";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-8 items-center gap-1 rounded-lg border px-1.5 text-[10px] transition-all",
            isDefault
              ? "border-gray-200 bg-gray-50 text-gray-500 hover:bg-gray-100"
              : `${current.activeBorder} ${current.activeBg} ${current.color} ${current.activeHover}`,
            className,
          )}
          title={`Mode: ${current.label}`}
          aria-label="Select permission mode"
        >
          <CurrentIcon className={cn("h-3 w-3", current.color)} />
          <span className="hidden font-medium sm:inline">{current.label}</span>
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-56">
        <div className="flex items-center justify-between border-b border-gray-200 p-3">
          <h3 className="text-sm font-semibold text-gray-900">Permission Mode</h3>
          <PopoverClose asChild>
            <button
              type="button"
              className="rounded p-1 hover:bg-gray-100"
              aria-label="Close"
            >
              <X className="h-4 w-4 text-gray-500" />
            </button>
          </PopoverClose>
        </div>

        <div className="py-1">
          {MODES.map((m) => {
            const ModeIcon = m.icon;
            const isSelected = m.id === mode;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
                className={cn(
                  "w-full px-4 py-2.5 text-left transition-colors hover:bg-gray-50",
                  isSelected && "bg-gray-50",
                )}
              >
                <div className="flex items-center gap-2.5">
                  <ModeIcon className={cn("h-4 w-4", m.color)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          "text-sm font-medium",
                          isSelected ? "text-gray-900" : "text-gray-700",
                        )}
                      >
                        {m.label}
                      </span>
                      {isSelected && (
                        <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[9px] text-blue-700">
                          Active
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500">{m.description}</p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
