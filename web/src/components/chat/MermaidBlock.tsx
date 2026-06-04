"use client";

import { type SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import mermaid from "mermaid";
import { CodeIcon, EyeIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { sanitizeSvg } from "@/lib/sanitizeSvg";
import { useDebouncedRender } from "@/lib/useDebouncedRender";

/** Whether the page is currently in a dark colour scheme. */
function detectDark(): boolean {
  if (typeof document === "undefined") return false;
  if (document.documentElement.classList.contains("dark")) return true;
  if (document.body?.classList.contains("dark")) return true;
  return Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches);
}

/**
 * Tracks dark mode by observing the `class` attribute on both the root and the
 * body, and by listening to the OS colour-scheme preference.
 */
function useDarkMode(): boolean {
  const [dark, setDark] = useState(detectDark);

  useEffect(() => {
    const sync = () => setDark(detectDark());
    const observer = new MutationObserver(sync);
    const opts: MutationObserverInit = {
      attributes: true,
      attributeFilter: ["class"],
    };
    observer.observe(document.documentElement, opts);
    if (document.body) observer.observe(document.body, opts);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", sync);
    sync();
    return () => {
      observer.disconnect();
      media.removeEventListener("change", sync);
    };
  }, []);

  return dark;
}

const headerButton =
  "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-gray-400 transition-colors hover:bg-gray-700 hover:text-gray-200";

export const MermaidBlock = ({ code }: SyntaxHighlighterProps) => {
  const isDark = useDarkMode();
  const [showSource, setShowSource] = useState(false);

  const rawId = useId();
  const diagramId = `mermaid-${rawId.replace(/:/g, "_")}`;

  const { html, error, isLoading } = useDebouncedRender(
    code,
    async (source) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: isDark ? "dark" : "default",
        securityLevel: "strict",
      });
      // Validate first: a syntax error rejects here, so we never call render()
      // on bad input (which would otherwise leave a stray error node in body).
      await mermaid.parse(source);
      const { svg } = await mermaid.render(diagramId, source);
      return svg.replace(/translate\(undefined,\s*NaN\)/g, "translate(0, 0)");
    },
    300,
    isDark, // theme flip re-renders even though the source is unchanged
  );

  // Mount the rendered SVG into an open shadow root so the diagram's own styles
  // stay isolated from the app's CSS.
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    shadow.innerHTML = html
      ? `<style>:host{display:block}svg{max-width:100%;height:auto}</style>${sanitizeSvg(html)}`
      : "";
  }, [html]);

  const sourceVisible = showSource || error !== null;

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-gray-700 bg-gray-900">
      <div
        data-copy-ignore
        className="flex select-none items-center justify-between gap-2 border-gray-700 border-b bg-gray-800 px-3 py-1.5 text-xs"
      >
        <span className="font-medium text-gray-400 lowercase">mermaid</span>
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

      {/* Kept mounted so the shadow root persists across the source toggle. */}
      <div className={cn("p-3", sourceVisible && "hidden")}>
        {isLoading && !html && (
          <div className="text-gray-500 text-xs">Rendering diagram…</div>
        )}
        <div ref={hostRef} className="flex justify-center" />
      </div>

      {sourceVisible && (
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
      )}
    </div>
  );
};
