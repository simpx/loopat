import { useState, useEffect } from "react";
import { Cpu, ChevronDown, User, Globe } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { getProviders, type ProvidersResponse } from "@/api";
import { useLoopRuntimeExtra } from "@/useLoopRuntime";

export default function ModelSelector() {
  const { provider, selectProvider } = useLoopRuntimeExtra();
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    getProviders().then(setProviders);
  }, []);

  const currentName = provider?.name || "default";
  const currentModel = provider?.model || "";
  const entries = providers ? Object.entries(providers.providers) : [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-gray-100 transition-colors"
          title="Select model"
          aria-label="Select model"
        >
          <Cpu className="h-3 w-3" />
          <span className="font-medium text-gray-700 truncate max-w-20 sm:max-w-none">{currentName}</span>
          {currentModel && (
            <>
              <span className="hidden sm:inline text-gray-400">·</span>
              <span className="hidden sm:inline font-mono">{currentModel}</span>
            </>
          )}
          <ChevronDown className="h-2.5 w-2.5 text-gray-400" />
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-80">
        <div className="border-b border-gray-200 p-3">
          <h3 className="text-sm font-semibold text-gray-900">Model</h3>
          <p className="mt-0.5 text-xs text-gray-500">
            Select provider and model (only before first message)
          </p>
        </div>

        <div className="max-h-64 overflow-y-auto py-1">
          {entries.map(([name, info]) => {
            const isActive = name === currentName;
            const isPersonal = info.source === "personal";
            return (
              <button
                key={name}
                type="button"
                onClick={() => {
                  selectProvider(name, info.source);
                  setOpen(false);
                }}
                className={`w-full px-4 py-2.5 text-left transition-colors hover:bg-gray-50 ${
                  isActive ? "bg-blue-50" : ""
                }`}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`text-sm font-medium ${
                      isActive ? "text-blue-700" : "text-gray-700"
                    }`}
                  >
                    {name}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium ${
                      isPersonal
                        ? "bg-violet-100 text-violet-700"
                        : "bg-gray-100 text-gray-500"
                    }`}
                  >
                    {isPersonal ? (
                      <User className="h-2.5 w-2.5" />
                    ) : (
                      <Globe className="h-2.5 w-2.5" />
                    )}
                    {isPersonal ? "personal" : "workspace"}
                  </span>
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-gray-500">
                  {info.model}
                </div>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
