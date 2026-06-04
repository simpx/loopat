"use client";

import { CheckIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

type TableProps = React.ComponentProps<"table"> & { node?: unknown };

/** Snapshot the live, rendered cell text row by row. */
function readGrid(table: HTMLTableElement): string[][] {
  return Array.from(table.querySelectorAll("tr")).map((row) =>
    Array.from(row.querySelectorAll<HTMLTableCellElement>("th, td")).map((cell) =>
      (cell.textContent ?? "").trim(),
    ),
  );
}

/** Rebuild a GFM table from the grid (first row treated as the header). */
function gridToMarkdown(grid: string[][]): string {
  if (grid.length === 0) return "";
  const clean = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const [head, ...rows] = grid;
  const out = [
    `| ${head.map(clean).join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(clean).join(" | ")} |`),
  ];
  return out.join("\n");
}

/** Serialise the grid as RFC-4180 CSV (CRLF rows, quote-escaped cells). */
function gridToCsv(grid: string[][]): string {
  const field = (value: string) =>
    /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return grid.map((row) => row.map(field).join(",")).join("\r\n");
}

const toolbarButton =
  "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700";

export const TableWithToolbar = ({ node, className, ...props }: TableProps) => {
  void node;
  const tableRef = useRef<HTMLTableElement>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const table = tableRef.current;
    if (!table) return;
    const grid = readGrid(table);
    const markdown = gridToMarkdown(grid);
    const html = table.outerHTML;
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([markdown], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(markdown);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; fail quietly.
    }
  };

  const handleExportCsv = () => {
    const table = tableRef.current;
    if (!table) return;
    const csv = gridToCsv(readGrid(table));
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "table.csv";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="group relative my-2">
      <div className="overflow-x-auto">
        <table
          ref={tableRef}
          className={cn("min-w-full border-separate border-spacing-0", className)}
          {...props}
        />
      </div>
      <div
        data-copy-ignore
        className="absolute top-1 right-1 flex select-none items-center gap-0.5 rounded-md border border-gray-200 bg-white/90 p-0.5 opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-hover:opacity-100"
      >
        <button type="button" onClick={handleCopy} title="Copy table" className={toolbarButton}>
          {copied ? (
            <CheckIcon className="h-3 w-3 text-emerald-500" />
          ) : (
            <CopyIcon className="h-3 w-3" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          onClick={handleExportCsv}
          title="Export as CSV"
          className={toolbarButton}
        >
          <DownloadIcon className="h-3 w-3" />
          CSV
        </button>
      </div>
    </div>
  );
};
