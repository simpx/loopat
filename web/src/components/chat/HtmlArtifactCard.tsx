"use client";

import { type SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import { CodeIcon, DownloadIcon, EyeIcon, FileCodeIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Renders ```html fenced blocks as an interactive artifact: a live sandboxed
 * preview plus a source view and a download action. While the block is still
 * being streamed we hold off on the heavy iframe and just echo the tail of the
 * incoming markup; once the text stops growing for ~1s we swap in the card.
 */

const SETTLE_DELAY_MS = 1000;
const TAIL_LINE_COUNT = 4;

function readDocumentTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match?.[1]?.trim();
  return title ? title : null;
}

function toFileName(title: string): string {
  const slug = title.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${slug || "artifact"}.html`;
}

const chromeButton =
  "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-gray-400 transition-colors hover:bg-gray-700 hover:text-gray-200";

export const HtmlArtifactCard = ({ code }: SyntaxHighlighterProps) => {
  const [settled, setSettled] = useState(false);
  const [showSource, setShowSource] = useState(false);

  // Each fresh chunk of streamed text restarts the settle timer; the card only
  // appears once the content has been quiet for a beat.
  useEffect(() => {
    setSettled(false);
    const timer = setTimeout(() => setSettled(true), SETTLE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [code]);

  const title = useMemo(() => readDocumentTitle(code) ?? "HTML document", [code]);

  const handleDownload = () => {
    const blob = new Blob([code], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = toFileName(title);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  if (!settled) {
    const tail = code.replace(/\n$/, "").split("\n").slice(-TAIL_LINE_COUNT);
    return (
      <div
        data-copy-ignore
        className="my-2 rounded-lg border border-gray-700 bg-gray-900 p-3 text-xs"
      >
        <div className="mb-2 flex items-center gap-2 text-gray-400">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
          <span>Building HTML artifact…</span>
        </div>
        <pre className="overflow-hidden font-mono text-[11px] leading-relaxed text-gray-500">
          {tail.join("\n")}
        </pre>
      </div>
    );
  }

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-gray-700 bg-gray-900">
      <div
        data-copy-ignore
        className="flex select-none items-center justify-between gap-2 border-gray-700 border-b bg-gray-800 px-3 py-1.5 text-xs"
      >
        <span className="flex min-w-0 items-center gap-1.5 text-gray-300">
          <FileCodeIcon className="h-3.5 w-3.5 shrink-0 text-gray-400" />
          <span className="truncate font-medium">{title}</span>
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setShowSource((v) => !v)}
            aria-pressed={showSource}
            className={cn(chromeButton, showSource && "text-gray-200")}
          >
            {showSource ? (
              <EyeIcon className="h-3 w-3" />
            ) : (
              <CodeIcon className="h-3 w-3" />
            )}
            <span>{showSource ? "Preview" : "Source"}</span>
          </button>
          <button type="button" onClick={handleDownload} className={chromeButton}>
            <DownloadIcon className="h-3 w-3" />
            <span>Download</span>
          </button>
        </div>
      </div>
      {showSource ? (
        <pre className="max-h-80 overflow-auto p-3 font-mono text-gray-200 text-xs leading-relaxed">
          {code}
        </pre>
      ) : (
        <iframe
          title={title}
          srcDoc={code}
          sandbox="allow-scripts allow-same-origin"
          className="h-80 w-full border-0 bg-white"
        />
      )}
    </div>
  );
};
