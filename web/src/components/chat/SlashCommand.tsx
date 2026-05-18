import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useAuiState } from "@assistant-ui/react";
import { useComposerRuntime } from "@assistant-ui/react";
import { Brain, Zap, Sparkles, Route, Eraser, BarChart3, Terminal, Puzzle, Network } from "lucide-react";
import { useLoopRuntimeExtra } from "@/useLoopRuntime";
import { McpStatusPanel } from "../McpStatusPanel";
import type { PermissionMode } from "./PlanModeToggle";

/**
 * One group of commands in the dropdown. Rendered with a small header.
 * Groups are stable; commands inside a group are filtered by query.
 */
type GroupId = "quick" | "plugin" | "skill";

interface SlashCommand {
  id: string;
  name: string;
  description: string;
  icon: React.ElementType;
  /** Which visual section this row belongs to. */
  group: GroupId;
  /**
   *   - "command" / "toggle": runs locally (clears composer text)
   *   - "agent":  inserted into composer as `/<id> ` for the agent to receive
   */
  action: "insert" | "toggle" | "command" | "agent";
  prefix: string;
  toggleKey?: "permissionMode";
  /** Required when action === "command"; identifies which runtime action to fire. */
  commandKey?: "clearContext" | "setMaxThinkingTokens" | "getContextUsage" | "openMcpPanel";
  /** Budget in tokens for setMaxThinkingTokens (null = unlimited). */
  tokens?: number | null;
  /** Show ON badge when true. */
  isActive?: boolean;
  /** For plugin commands: the plugin name (text before `:`). Used to sort
   *  rows of the same plugin together. */
  pluginName?: string;
}

const COMMANDS: SlashCommand[] = [
  {
    id: "think",
    name: "Think",
    description: "Extended thinking (16k token budget)",
    icon: Brain,
    group: "quick",
    action: "command",
    prefix: "",
    commandKey: "setMaxThinkingTokens",
    tokens: 16000,
  },
  {
    id: "think-hard",
    name: "Think Hard",
    description: "Deep thinking (32k token budget)",
    icon: Zap,
    group: "quick",
    action: "command",
    prefix: "",
    commandKey: "setMaxThinkingTokens",
    tokens: 32000,
  },
  {
    id: "ultrathink",
    name: "Ultrathink",
    description: "Maximum thinking (no budget limit)",
    icon: Sparkles,
    group: "quick",
    action: "command",
    prefix: "",
    commandKey: "setMaxThinkingTokens",
    tokens: null,
  },
  {
    id: "plan",
    name: "Permission",
    description: "Cycle permission mode",
    icon: Route,
    group: "quick",
    action: "toggle",
    prefix: "",
    toggleKey: "permissionMode",
  },
  {
    id: "usage",
    name: "Context Usage",
    description: "Show context window token usage",
    icon: BarChart3,
    group: "quick",
    action: "command",
    prefix: "",
    commandKey: "getContextUsage",
  },
  {
    id: "clear",
    name: "Clear Context",
    description: "Reset AI conversation (history kept)",
    icon: Eraser,
    group: "quick",
    action: "command",
    prefix: "",
    commandKey: "clearContext",
  },
  {
    id: "mcp",
    name: "MCP Servers",
    description: "Show MCP servers + tools available to this loop",
    icon: Network,
    group: "quick",
    action: "command",
    prefix: "",
    commandKey: "openMcpPanel",
  },
];

/** Header text + sort order for each group. Groups missing rows are hidden. */
const GROUPS: { id: GroupId; label: string }[] = [
  { id: "quick", label: "Quick actions" },
  { id: "plugin", label: "Plugin commands" },
  { id: "skill", label: "Skills" },
];

/** Local-only command ids — when filtering against CC's reported list, these
 *  must never get hidden as duplicates of CC's "clear" etc. */
const LOCAL_IDS = new Set(COMMANDS.map((c) => c.id));

export default function SlashCommand() {
  const text = useAuiState((s) => s.composer.text);
  const composerRuntime = useComposerRuntime();
  const {
    permissionMode,
    setPermissionMode,
    clearContext,
    setMaxThinkingTokens,
    getContextUsage,
    availableSlashCommands,
  } = useLoopRuntimeExtra();
  const [open, setOpen] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [filter, setFilter] = useState("");
  // /mcp opens a floating panel anchored above the composer. Rendered
  // alongside the slash-command dropdown but mutually independent.
  const [mcpOpen, setMcpOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Merge: built-in loopat quick-actions + commands reported by CC at init.
  // Group routing:
  //   - "<plugin>:<skill>"  → group:"plugin"  (loopat, jira-pack, …)
  //   - bare id, not local  → group:"skill"   (CC built-ins + workspace/personal loose skills)
  //   - local id            → already group:"quick" from COMMANDS
  const allCommands = useMemo<SlashCommand[]>(() => {
    const fromAgent: SlashCommand[] = availableSlashCommands
      .filter((id) => !LOCAL_IDS.has(id))
      .map((id) => {
        const isPlugin = id.includes(":");
        const pluginName = isPlugin ? id.split(":", 1)[0] : undefined;
        return {
          id,
          name: id,
          description: isPlugin ? `from ${pluginName} plugin` : "skill",
          icon: isPlugin ? Puzzle : Terminal,
          group: isPlugin ? ("plugin" as const) : ("skill" as const),
          action: "agent" as const,
          prefix: "",
          pluginName,
        };
      });
    return [...COMMANDS, ...fromAgent];
  }, [availableSlashCommands]);

  const textTrimmed = typeof text === "string" ? text.trimStart() : text;
  const showDropdown =
    typeof textTrimmed === "string" &&
    textTrimmed.startsWith("/") &&
    !textTrimmed.includes(" ");

  const query = showDropdown ? textTrimmed.slice(1).toLowerCase() : "";

  // Apply filter, then bucket by group. Flat list still exists for keyboard nav.
  const filtered = useMemo(
    () =>
      allCommands.filter(
        (c) =>
          !query ||
          c.id.toLowerCase().includes(query) ||
          c.name.toLowerCase().includes(query),
      ),
    [allCommands, query],
  );

  /** Order rows for keyboard nav: by group order, then plugin grouping, then alpha. */
  const flatOrdered = useMemo(() => {
    const groupOrder: Record<GroupId, number> = { quick: 0, plugin: 1, skill: 2 };
    return [...filtered].sort((a, b) => {
      if (a.group !== b.group) return groupOrder[a.group] - groupOrder[b.group];
      if (a.group === "plugin") {
        if (a.pluginName !== b.pluginName)
          return (a.pluginName ?? "").localeCompare(b.pluginName ?? "");
      }
      return a.id.localeCompare(b.id);
    });
  }, [filtered]);

  /** Group → ordered list of rows in that group. Empty groups are dropped at render time. */
  const grouped = useMemo(() => {
    const m = new Map<GroupId, SlashCommand[]>();
    for (const c of flatOrdered) {
      const arr = m.get(c.group) ?? [];
      arr.push(c);
      m.set(c.group, arr);
    }
    return m;
  }, [flatOrdered]);

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
      if (cmd.action === "toggle" && cmd.toggleKey === "permissionMode") {
        const modes: PermissionMode[] = ["bypassPermissions", "auto", "dontAsk", "acceptEdits", "plan", "default"];
        const idx = modes.indexOf(permissionMode);
        const next = modes[(idx + 1) % modes.length];
        setPermissionMode(next);
        composerRuntime.setText("");
      } else if (cmd.action === "command") {
        if (cmd.commandKey === "clearContext") {
          clearContext();
          composerRuntime.setText("");
        } else if (cmd.commandKey === "setMaxThinkingTokens") {
          setMaxThinkingTokens(cmd.tokens ?? null);
          composerRuntime.setText("");
        } else if (cmd.commandKey === "getContextUsage") {
          getContextUsage();
          composerRuntime.setText("");
        } else if (cmd.commandKey === "openMcpPanel") {
          setMcpOpen(true);
          composerRuntime.setText("");
        }
      } else if (cmd.action === "agent") {
        // CC-side command: fill the composer with `/<id> ` so the user can
        // submit (or keep typing args). Don't auto-send — same UX as CC.
        composerRuntime.setText(`/${cmd.id} `);
      }
      setOpen(false);
    },
    [composerRuntime, permissionMode, setPermissionMode, clearContext, setMaxThinkingTokens, getContextUsage],
  );

  // Keyboard navigation — uses capture phase to intercept before composer.
  // Index is into `flatOrdered` so it matches the visual order (with group
  // sections respected); group headers themselves aren't selectable.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSelectedIdx((prev) => Math.min(prev + 1, flatOrdered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSelectedIdx((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Enter" && flatOrdered.length > 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        executeCommand(flatOrdered[selectedIdx]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        composerRuntime.setText("");
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [open, flatOrdered, selectedIdx, composerRuntime, executeCommand]);

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return;
    const sel = listRef.current.children[selectedIdx] as HTMLElement | undefined;
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  // Build a flat index → so each row knows its position in flatOrdered for
  // selection highlighting + onClick.
  let runningIdx = -1;

  // If only the MCP panel is open (no dropdown), render just it.
  if (mcpOpen && (!open || flatOrdered.length === 0)) {
    return (
      <div className="relative">
        <div className="absolute bottom-0 left-0 mb-1 w-[28rem] rounded-lg border border-gray-200 bg-white shadow-lg z-20">
          <McpStatusPanel variant="popover" onClose={() => setMcpOpen(false)} />
        </div>
      </div>
    );
  }

  if (!open || flatOrdered.length === 0) return null;

  return (
    <div className="relative">
      {mcpOpen && (
        <div className="absolute bottom-0 left-0 mb-1 w-[28rem] rounded-lg border border-gray-200 bg-white shadow-lg z-30">
          <McpStatusPanel variant="popover" onClose={() => setMcpOpen(false)} />
        </div>
      )}
      <div className="absolute bottom-0 left-0 mb-1 w-72 rounded-lg border border-gray-200 bg-white shadow-lg z-20">
        <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
          {GROUPS.map((g) => {
            const rows = grouped.get(g.id);
            if (!rows || rows.length === 0) return null;
            return (
              <div key={g.id}>
                <div className="px-3 pt-2 pb-1">
                  <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">
                    {g.label}
                  </p>
                </div>
                {rows.map((cmd) => {
                  runningIdx += 1;
                  const myIdx = runningIdx;
                  const Icon = cmd.icon;
                  const isSelected = myIdx === selectedIdx;
                  const isActive =
                    (cmd.toggleKey === "permissionMode" &&
                      permissionMode !== "bypassPermissions") ||
                    cmd.isActive;
                  return (
                    <button
                      key={cmd.id}
                      type="button"
                      onMouseEnter={() => setSelectedIdx(myIdx)}
                      onMouseDown={(e) => {
                        e.preventDefault(); // prevent blur on textarea
                        executeCommand(cmd);
                      }}
                      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${
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
            );
          })}
        </div>
      </div>
    </div>
  );
}
