import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useAuiState, useComposerRuntime } from "@assistant-ui/react";
import { Bot } from "lucide-react";
import { useLoopRuntimeExtra, type AgentMeta } from "@/useLoopRuntime";

/**
 * `@`-mention dropdown. Sister component to SlashCommand — same trigger
 * pattern (watches composer text, opens when text starts with `@`, capture-
 * phase keyboard nav) but for sub-agents instead of slash commands.
 *
 * On select, inserts `@<agent-name> ` into the composer; the user then
 * types the task and submits. The system-prompt's @-mention block (see
 * server/src/system-prompt.ts) tells Claude to dispatch to the named
 * sub-agent via the Agent tool — no client-side transformation needed.
 *
 * Mutually exclusive with SlashCommand by construction (text can't start
 * with both `@` and `/`), so no coordination needed.
 */
export default function AgentMention() {
  const text = useAuiState((s) => s.composer.text);
  const composerRuntime = useComposerRuntime();
  const { availableAgents } = useLoopRuntimeExtra();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const textTrimmed = typeof text === "string" ? text.trimStart() : text;
  // Trigger: text starts with `@` and doesn't contain whitespace yet (i.e.
  // user is still typing the agent name, hasn't moved on to the task).
  const showDropdown =
    typeof textTrimmed === "string" &&
    textTrimmed.startsWith("@") &&
    !/\s/.test(textTrimmed);

  const query = showDropdown ? textTrimmed.slice(1).toLowerCase() : "";

  const filtered = useMemo<AgentMeta[]>(
    () =>
      availableAgents.filter(
        (a) =>
          !query ||
          a.name.toLowerCase().includes(query) ||
          a.description.toLowerCase().includes(query),
      ),
    [availableAgents, query],
  );

  // The selectable list shows when there are matches to choose from.
  const showList = showDropdown && filtered.length > 0;
  // Distinct empty state: the user is `@`-mentioning but this loop has no
  // composed sub-agents at all. Show a hint instead of rendering nothing, so
  // typing `@` doesn't look broken. (When agents exist but the query matches
  // none, we stay silent — same as SlashCommand.)
  const showEmpty = showDropdown && availableAgents.length === 0;

  useEffect(() => {
    if (showList) setSelectedIdx(0);
  }, [showList, query]);

  const insertAgent = useCallback(
    (agent: AgentMeta) => {
      composerRuntime.setText(`@${agent.name} `);
    },
    [composerRuntime],
  );

  // Keyboard nav — capture phase, same trick as SlashCommand, so we beat
  // the composer's own Enter handler.
  useEffect(() => {
    if (!showList) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSelectedIdx((prev) =>
          Math.min(prev + 1, Math.max(filtered.length - 1, 0)),
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSelectedIdx((prev) =>
          Math.max(Math.min(prev - 1, filtered.length - 1), 0),
        );
      } else if (e.key === "Enter" && filtered.length > 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const idx = Math.min(selectedIdx, filtered.length - 1);
        insertAgent(filtered[idx]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        composerRuntime.setText("");
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [showList, filtered, selectedIdx, composerRuntime, insertAgent]);

  // Scroll selected row into view as user arrows through.
  useEffect(() => {
    if (!listRef.current) return;
    const sel = listRef.current.children[selectedIdx] as HTMLElement | undefined;
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  if (!showList && !showEmpty) return null;

  return (
    <div className="relative">
      <div className="absolute bottom-0 left-0 mb-1 w-80 rounded-lg border border-gray-200 bg-white shadow-lg z-20">
        <div className="px-3 pt-2 pb-1">
          <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">
            Sub-agents
          </p>
        </div>
        {showEmpty ? (
          <div className="flex items-start gap-2.5 px-3 pb-2.5 pt-0.5">
            <Bot className="h-4 w-4 flex-shrink-0 mt-0.5 text-gray-300" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-gray-500">
                No sub-agents in this loop
              </div>
              <p className="text-xs text-gray-400">
                Add agent files under knowledge or personal{" "}
                <code className="rounded bg-gray-100 px-1 py-0.5 text-[11px]">
                  .loopat/claude/agents/
                </code>
                , then restart the loop to load them.
              </p>
            </div>
          </div>
        ) : (
          <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
            {filtered.map((agent, idx) => {
              const isSelected = idx === selectedIdx;
              return (
                <button
                  key={agent.name}
                  type="button"
                  onMouseEnter={() => setSelectedIdx(idx)}
                  onMouseDown={(e) => {
                    e.preventDefault(); // keep focus on the textarea
                    insertAgent(agent);
                  }}
                  className={`w-full flex items-start gap-2.5 px-3 py-1.5 text-left transition-colors ${
                    isSelected ? "bg-blue-50" : "hover:bg-gray-50"
                  }`}
                >
                  <Bot
                    className="h-4 w-4 flex-shrink-0 mt-0.5 text-purple-500"
                    style={agent.color ? { color: agent.color } : undefined}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-700">
                      @{agent.name}
                    </div>
                    {agent.description && (
                      <p className="text-xs text-gray-500 line-clamp-2">
                        {agent.description}
                      </p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
