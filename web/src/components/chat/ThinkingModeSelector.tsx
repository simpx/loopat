import { useState, useRef, useEffect, useCallback, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Brain, Zap, Sparkles, Atom, X } from "lucide-react";
import type { ThinkingMode } from "./types";

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
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<CSSProperties | null>(null);

  const closeDropdown = useCallback(() => {
    setIsOpen(false);
  }, []);

  const updateDropdownPosition = useCallback(() => {
    const trigger = triggerRef.current;
    const dropdown = dropdownRef.current;
    if (!trigger || !dropdown || typeof window === "undefined") return;

    const triggerRect = trigger.getBoundingClientRect();
    const viewportPadding = window.innerWidth < 640 ? 12 : 16;
    const spacing = 8;
    const width = Math.min(
      window.innerWidth - viewportPadding * 2,
      window.innerWidth < 640 ? 320 : 256,
    );
    let left = triggerRect.left + triggerRect.width / 2 - width / 2;
    left = Math.max(
      viewportPadding,
      Math.min(left, window.innerWidth - width - viewportPadding),
    );

    const measuredHeight = dropdown.offsetHeight || 0;
    const spaceBelow =
      window.innerHeight - triggerRect.bottom - spacing - viewportPadding;
    const spaceAbove = triggerRect.top - spacing - viewportPadding;
    const openBelow =
      spaceBelow >= Math.min(measuredHeight || 320, 320) ||
      spaceBelow >= spaceAbove;
    const availableHeight = Math.min(
      window.innerHeight - viewportPadding * 2,
      Math.max(180, openBelow ? spaceBelow : spaceAbove),
    );
    const panelHeight = Math.min(
      measuredHeight || availableHeight,
      availableHeight,
    );
    const top = openBelow
      ? Math.min(
          triggerRect.bottom + spacing,
          window.innerHeight - viewportPadding - panelHeight,
        )
      : Math.max(viewportPadding, triggerRect.top - spacing - panelHeight);

    setDropdownStyle({
      position: "fixed",
      top,
      left,
      width,
      maxHeight: availableHeight,
      zIndex: 80,
    });
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setDropdownStyle(null);
      return;
    }

    const rafId = window.requestAnimationFrame(updateDropdownPosition);
    const handleViewportChange = () => updateDropdownPosition();

    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [isOpen, updateDropdownPosition]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        containerRef.current?.contains(target) ||
        dropdownRef.current?.contains(target)
      )
        return;
      closeDropdown();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDropdown();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, closeDropdown]);

  const currentMode =
    THINKING_MODES.find((m) => m.id === selectedMode) ?? THINKING_MODES[0];
  const CurrentIcon = currentMode.Icon;

  return (
    <div className={`relative ${className}`} ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className={`flex h-10 w-10 items-center justify-center rounded-full transition-all ${
          selectedMode === "none"
            ? "bg-gray-100 hover:bg-gray-200"
            : "bg-blue-100 hover:bg-blue-200"
        }`}
        title={`Thinking: ${currentMode.name}`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
      >
        <CurrentIcon className={`h-5 w-5 ${currentMode.color}`} />
      </button>

      {isOpen &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={dropdownRef}
            style={
              dropdownStyle || {
                position: "fixed",
                top: 0,
                left: 0,
                visibility: "hidden",
              }
            }
            className="flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl"
            role="dialog"
            aria-modal="false"
          >
            <div className="border-b border-gray-200 p-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-900">
                  Thinking Mode
                </h3>
                <button
                  type="button"
                  onClick={closeDropdown}
                  className="rounded p-1 hover:bg-gray-100"
                >
                  <X className="h-4 w-4 text-gray-500" />
                </button>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                Control how much Claude thinks before responding
              </p>
            </div>

            <div className="min-h-0 overflow-y-auto py-1">
              {THINKING_MODES.map((mode) => {
                const ModeIcon = mode.Icon;
                const isSelected = mode.id === selectedMode;

                return (
                  <button
                    key={mode.id}
                    type="button"
                    onClick={() => {
                      onModeChange(mode.id);
                      closeDropdown();
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
                              isSelected
                                ? "text-gray-900"
                                : "text-gray-700"
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
                <strong>Tip:</strong> More thinking improves complex
                reasoning but uses more tokens.
              </p>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
