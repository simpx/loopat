import { useState, useRef, useEffect, useCallback } from "react";
import { useAuiState } from "@assistant-ui/react";
import { useComposerRuntime } from "@assistant-ui/react";
import { Brain, Zap, Sparkles, Route } from "lucide-react";
import { useLoopRuntimeExtra } from "@/useLoopRuntime";

interface SlashCommand {
  id: string;
  name: string;
  description: string;
  icon: React.ElementType;
  action: "insert" | "toggle";
  prefix: string;
  toggleKey?: "planMode";
}

const COMMANDS: SlashCommand[] = [
  {
    id: "think",
    name: "Think",
    description: "Basic extended thinking",
    icon: Brain,
    action: "insert",
    prefix: "/think ",
  },
  {
    id: "think-hard",
    name: "Think Hard",
    description: "More thorough evaluation",
    icon: Zap,
    action: "insert",
    prefix: "/think-hard ",
  },
  {
    id: "ultrathink",
    name: "Ultrathink",
    description: "Maximum thinking budget",
    icon: Sparkles,
    action: "insert",
    prefix: "/ultrathink ",
  },
  {
    id: "plan",
    name: "Plan Mode",
    description: "Plan first before implementation",
    icon: Route,
    action: "toggle",
    prefix: "",
    toggleKey: "planMode",
  },
];

export default function SlashCommand() {
  const text = useAuiState((s) => s.composer.text);
  const composerRuntime = useComposerRuntime();
  const { planMode, setPlanMode } = useLoopRuntimeExtra();
  const [open, setOpen] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [filter, setFilter] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const textTrimmed = typeof text === "string" ? text.trimStart() : text;
  const showDropdown =
    typeof textTrimmed === "string" &&
    textTrimmed.startsWith("/") &&
    !textTrimmed.includes(" ");

  const query = showDropdown ? textTrimmed.slice(1).toLowerCase() : "";

  const filtered = COMMANDS.filter(
    (c) => !query || c.id.includes(query) || c.name.toLowerCase().includes(query),
  );

  useEffect(() => {
    if (showDropdown) {
      setOpen(true);
      setFilter(query);
      setSelectedIdx(0);
    } else {
      setOpen(false);
    }
  }, [showDropdown, query]);

  const executeCommand = useCallback(
    (cmd: SlashCommand) => {
      if (cmd.action === "toggle" && cmd.toggleKey === "planMode") {
        setPlanMode(!planMode);
        composerRuntime.setText("");
      } else if (cmd.action === "insert") {
        composerRuntime.setText(cmd.prefix);
      }
      setOpen(false);
    },
    [composerRuntime, planMode, setPlanMode],
  );

  // Keyboard navigation — uses capture phase to intercept before composer
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSelectedIdx((prev) => Math.min(prev + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSelectedIdx((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Enter" && filtered.length > 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        executeCommand(filtered[selectedIdx]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        composerRuntime.setText("");
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [open, filtered, selectedIdx, composerRuntime, executeCommand]);

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return;
    const sel = listRef.current.children[selectedIdx] as HTMLElement | undefined;
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  if (!open || filtered.length === 0) return null;

  return (
    <div className="relative">
      <div className="absolute bottom-0 left-0 mb-1 w-64 rounded-lg border border-gray-200 bg-white shadow-lg z-20">
      <div className="border-b border-gray-100 p-2">
        <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">
          Commands
        </p>
      </div>
      <div ref={listRef} className="max-h-52 overflow-y-auto py-1">
        {filtered.map((cmd, i) => {
          const Icon = cmd.icon;
          const isSelected = i === selectedIdx;
          const isActive =
            cmd.toggleKey === "planMode" && planMode;
          return (
            <button
              key={cmd.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault(); // prevent blur on textarea
                executeCommand(cmd);
              }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                isSelected ? "bg-blue-50" : "hover:bg-gray-50"
              }`}
            >
              <Icon
                className={`h-4 w-4 flex-shrink-0 ${
                  isActive ? "text-blue-600" : "text-gray-400"
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-gray-700">
                    /{cmd.id}
                  </span>
                  {cmd.action === "toggle" && isActive && (
                    <span className="rounded bg-blue-100 px-1 py-0.5 text-[9px] text-blue-600">
                      ON
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 truncate">{cmd.description}</p>
              </div>
            </button>
          );
        })}
      </div>
      </div>
    </div>
  );
}
