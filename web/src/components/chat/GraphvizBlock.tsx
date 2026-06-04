"use client";

import { type SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import { CodeIcon, EyeIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { sanitizeSvg } from "@/lib/sanitizeSvg";
import { useDebouncedRender } from "@/lib/useDebouncedRender";

interface VizInstance {
  renderSVGElement(input: string): SVGSVGElement;
}

// The Graphviz WASM bundle is heavy, so it is imported on demand and the
// instance is created once and shared across every diagram block.
let vizPromise: Promise<VizInstance> | null = null;
function loadViz(): Promise<VizInstance> {
  if (!vizPromise) {
    vizPromise = import("@viz-js/viz").then((mod) => mod.instance());
  }
  return vizPromise;
}

async function renderDot(source: string): Promise<string> {
  let viz: VizInstance;
  try {
    viz = await loadViz();
  } catch {
    throw new Error("Graphviz failed to load");
  }
  try {
    const svg = viz.renderSVGElement(source);
    return sanitizeSvg(new XMLSerializer().serializeToString(svg));
  } catch {
    throw new Error("Graphviz render error");
  }
}

const headerButton =
  "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-gray-400 transition-colors hover:bg-gray-700 hover:text-gray-200";

export const GraphvizBlock = ({ code }: SyntaxHighlighterProps) => {
  const [showSource, setShowSource] = useState(false);
  const [vizReady, setVizReady] = useState(false);

  useEffect(() => {
    let active = true;
    loadViz().then(
      () => {
        if (active) setVizReady(true);
      },
      () => {
        /* surfaced as a render error on the next attempt */
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const { html, error, isLoading } = useDebouncedRender(code, renderDot, 300);
  const sourceVisible = showSource || error !== null;

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-gray-700 bg-gray-900">
      <div
        data-copy-ignore
        className="flex select-none items-center justify-between gap-2 border-gray-700 border-b bg-gray-800 px-3 py-1.5 text-xs"
      >
        <span className="font-medium text-gray-400 lowercase">graphviz</span>
        <button
          type="button"
          onClick={() => setShowSource((v) => !v)}
          aria-pressed={showSource}
          className={cn(headerButton, showSource && "text-gray-200")}
        >
          {sourceVisible ? (
            <EyeIcon className="h-3 w-3" />
          ) : (
            <CodeIcon className="h-3 w-3" />
          )}
          <span>{sourceVisible ? "Preview" : "Source"}</span>
        </button>
      </div>

      {sourceVisible ? (
        <div>
          {error !== null && (
            <div className="border-red-500/40 border-b bg-red-500/10 px-3 py-1.5 text-[11px] text-red-300">
              {error}
            </div>
          )}
          <pre className="overflow-x-auto p-3 text-gray-200 text-xs leading-relaxed">
            {code}
          </pre>
        </div>
      ) : (
        <div className="p-3">
          {!html && !vizReady ? (
            <div className="text-gray-500 text-xs">Loading Graphviz…</div>
          ) : isLoading && !html ? (
            <div className="text-gray-500 text-xs">Rendering diagram…</div>
          ) : (
            <div
              className="flex justify-center [&>svg]:h-auto [&>svg]:max-w-full"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </div>
      )}
    </div>
  );
};
