import { useState } from "react";
import { Brain, Zap, Sparkles, Atom, X } from "lucide-react";
import type { ThinkingMode } from "./types";
import { Popover, PopoverContent, PopoverTrigger, PopoverClose } from "@/components/ui/popover";

const THINKING_MODES: (ThinkingMode & { Icon: React.ElementType })[] = [
  {
    id: "none",
    name: "Standard",
    description: "Regular Claude response",
    icon: null,
    prefix: "",
    color: "text-gray-600",
    Icon: Brain,
  },
  {
    id: "think",
    name: "Think",
    description: "Basic extended thinking",
    icon: "brain" as unknown as React.ElementType,
    prefix: "think",
    color: "text-blue-600",
    Icon: Brain,
  },
  {
    id: "think-hard",
    name: "Think Hard",
    description: "More thorough evaluation",
    icon: "zap" as unknown as React.ElementType,
    prefix: "think hard",
    color: "text-purple-600",
    Icon: Zap,
  },
  {
    id: "think-harder",
    name: "Think Harder",
    description: "Deep analysis with alternatives",
    icon: "sparkles" as unknown as React.ElementType,
    prefix: "think harder",
    color: "text-indigo-600",
    Icon: Sparkles,
  },
  {
    id: "ultrathink",
    name: "Ultrathink",
    description: "Maximum thinking budget",
    icon: "atom" as unknown as React.ElementType,
    prefix: "ultrathink",
    color: "text-red-600",
    Icon: Atom,
  },
];

interface ThinkingModeSelectorProps {
  selectedMode: string;
  onModeChange: (modeId: string) => void;
  className?: string;
}

export default function ThinkingModeSelector({
  selectedMode,
  onModeChange,
  className = "",
}: ThinkingModeSelectorProps) {
  const [open, setOpen] = useState(false);

  const currentMode =
    THINKING_MODES.find((m) => m.id === selectedMode) ?? THINKING_MODES[0];
  const CurrentIcon = currentMode.Icon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`flex h-10 w-10 items-center justify-center rounded-full transition-all ${
            selectedMode === "none"
              ? "bg-gray-100 hover:bg-gray-200"
              : "bg-blue-100 hover:bg-blue-200"
          }`}
          title={`Thinking: ${currentMode.name}`}
          aria-label="Select thinking mode"
        >
          <CurrentIcon className={`h-5 w-5 ${currentMode.color}`} />
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-64">
        <div className="border-b border-gray-200 p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">
              Thinking Mode
            </h3>
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
          <p className="mt-1 text-xs text-gray-500">
            Control how much Claude thinks before responding
          </p>
        </div>

        <div className="max-h-80 overflow-y-auto py-1">
          {THINKING_MODES.map((mode) => {
            const ModeIcon = mode.Icon;
            const isSelected = mode.id === selectedMode;

            return (
              <button
                key={mode.id}
                type="button"
                onClick={() => {
                  onModeChange(mode.id);
                  setOpen(false);
                }}
                className={`w-full px-4 py-3 text-left transition-colors hover:bg-gray-50 ${
                  isSelected ? "bg-gray-50" : ""
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className={`mt-0.5 ${mode.color}`}>
                    <ModeIcon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-sm font-medium ${
                          isSelected ? "text-gray-900" : "text-gray-700"
                        }`}
                      >
                        {mode.name}
                      </span>
                      {isSelected && (
                        <span className="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
                          Active
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {mode.description}
                    </p>
                    {mode.prefix && (
                      <code className="mt-1 inline-block rounded bg-gray-100 px-1.5 py-0.5 text-xs">
                        {mode.prefix}
                      </code>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <div className="border-t border-gray-200 bg-gray-50 p-3">
          <p className="text-xs text-gray-600">
            <strong>Tip:</strong> More thinking improves complex reasoning but
            uses more tokens.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
