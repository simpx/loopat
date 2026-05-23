import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Cpu, ChevronDown, Search, User, Globe, CornerDownLeft, ArrowUp, ArrowDown } from "lucide-react";
import { getProviders, stripThinkingBlocks, type ProvidersResponse } from "@/api";
import { useLoopRuntimeExtra } from "@/useLoopRuntime";

interface FlatModel {
  provName: string
  modelId: string
  source: "personal" | "workspace"
}

export default function ModelSelector() {
  const { provider, selectProvider, thinkingBlockCount, loopId } = useLoopRuntimeExtra();
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getProviders().then(setProviders);
  }, []);

  const currentName = provider?.name || "default";
  const currentModel = provider?.model || "";

  // Build a flat list of enabled models from all enabled providers,
  // filtered by the search query.
  const flatModels = useMemo<FlatModel[]>(() => {
    if (!providers) return [];
    const result: FlatModel[] = [];
    for (const [provName, info] of Object.entries(providers.providers)) {
      if (info.enabled === false || !info.hasKey) continue;
      for (const m of info.models ?? []) {
        if (m.enabled === false) continue;
        const q = search.toLowerCase().trim();
        if (q && !m.id.toLowerCase().includes(q) && !provName.toLowerCase().includes(q)) continue;
        result.push({ provName, modelId: m.id, source: info.source });
      }
    }
    return result;
  }, [providers, search]);

  // Reset selection when filter changes.
  useEffect(() => {
    setSelectedIdx(0);
  }, [search, open]);

  // Scroll selected item into view.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.children[selectedIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  // Keyboard shortcut: Ctrl+K / Cmd+K to open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Group flat models by provider for display.
  const groups = useMemo(() => {
    const map = new Map<string, { source: "personal" | "workspace"; models: { modelId: string; idx: number }[] }>();
    flatModels.forEach((m, i) => {
      const g = map.get(m.provName) ?? { source: m.source, models: [] };
      g.models.push({ modelId: m.modelId, idx: i });
      map.set(m.provName, g);
    });
    return map;
  }, [flatModels]);

  const isClaudeModel = (model: string) => model.toLowerCase().startsWith("claude");
  const onPick = useCallback(async (item: FlatModel) => {
    setOpen(false);
    if (item.provName === currentName && item.modelId === currentModel) return;
    const crossClaudeBoundary = isClaudeModel(currentModel) !== isClaudeModel(item.modelId);
    if (crossClaudeBoundary && thinkingBlockCount > 0 && loopId) {
      const msg =
        `Switching between Claude and non-Claude models makes the ${thinkingBlockCount} ` +
        `existing thinking block${thinkingBlockCount === 1 ? "" : "s"} in this conversation ` +
        `fail signature validation.\n\n` +
        `Click OK to remove them from the AI's context (chat history stays). ` +
        `Cancel to keep the current provider.`;
      if (!window.confirm(msg)) return;
      await stripThinkingBlocks(loopId);
    }
    selectProvider(item.provName, item.source, item.modelId);
  }, [currentName, currentModel, thinkingBlockCount, loopId, selectProvider]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, flatModels.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (flatModels[selectedIdx]) onPick(flatModels[selectedIdx]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-gray-100 transition-colors"
        title="Select model (Ctrl+K)"
        aria-label="Select model"
      >
        <Cpu className="h-3 w-3" />
        <span className="font-medium text-gray-700 truncate max-w-16 md:max-w-24">{currentName}</span>
        {currentModel && (
          <>
            <span className="hidden md:inline text-gray-400">/</span>
            <span className="hidden md:inline font-mono truncate max-w-20">{currentModel}</span>
          </>
        )}
        <ChevronDown className="h-2.5 w-2.5 text-gray-400" />
      </button>
    );
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/20"
        onClick={() => setOpen(false)}
      />

      {/* Dialog */}
      <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
        <div
          className="w-[480px] max-h-[60vh] bg-white rounded-xl shadow-2xl border border-gray-200 flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleKeyDown}
        >
          {/* Search header */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 shrink-0">
            <Search className="h-4 w-4 text-gray-400 shrink-0" />
            <input
              ref={inputRef}
              autoFocus
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search models..."
              className="flex-1 text-sm outline-none text-gray-900 placeholder:text-gray-400"
            />
            <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-400 font-mono">
              esc
            </kbd>
          </div>

          {/* Model list */}
          <div ref={listRef} className="flex-1 overflow-y-auto py-2" role="listbox">
            {Array.from(groups.entries()).map(([provName, g]) => (
              <div key={provName} className="mb-1">
                {/* Provider header */}
                <div className="flex items-center gap-1.5 px-4 py-1">
                  <span className="text-[11px] font-medium text-gray-500">{provName}</span>
                  <span
                    className={`inline-flex items-center gap-0.5 rounded px-1 py-0 text-[8px] font-medium ${
                      g.source === "personal"
                        ? "bg-violet-100 text-violet-600"
                        : "bg-gray-100 text-gray-400"
                    }`}
                  >
                    {g.source === "personal" ? <User className="h-2 w-2" /> : <Globe className="h-2 w-2" />}
                    {g.source}
                  </span>
                </div>

                {g.models.map((m) => {
                  const isSelected = m.idx === selectedIdx;
                  const isActive = provName === currentName && m.modelId === currentModel;
                  return (
                    <button
                      key={m.modelId}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => onPick(flatModels[m.idx])}
                      onMouseEnter={() => setSelectedIdx(m.idx)}
                      className={`w-full px-6 py-1.5 text-left flex items-center gap-2 transition-colors ${
                        isSelected ? "bg-blue-50" : ""
                      }`}
                    >
                      <span
                        className={`font-mono text-[12px] flex-1 truncate ${
                          isActive
                            ? "text-blue-700 font-medium"
                            : isSelected
                              ? "text-gray-900"
                              : "text-gray-600"
                        }`}
                      >
                        {m.modelId}
                      </span>
                      {isActive && (
                        <span className="h-1.5 w-1.5 rounded-full bg-blue-500 shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>
            ))}

            {flatModels.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-gray-400">
                {search ? "No models match your search" : "No models available"}
              </div>
            )}
          </div>

          {/* Footer with shortcuts */}
          <div className="flex items-center gap-4 px-4 py-2 border-t border-gray-100 text-[10px] text-gray-400 shrink-0">
            <span className="flex items-center gap-1">
              <ArrowUp className="h-3 w-3" />
              <ArrowDown className="h-3 w-3" />
              navigate
            </span>
            <span className="flex items-center gap-1">
              <CornerDownLeft className="h-3 w-3" />
              select
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-gray-100 font-mono text-[9px]">esc</kbd>
              close
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
