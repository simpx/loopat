import { useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  LoaderIcon,
  XCircleIcon,
  AlertCircleIcon,
  PencilIcon,
  TerminalIcon,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

type ToolStatus = "running" | "complete" | "incomplete" | "requires-action";

interface ToolRendererProps {
  toolName: string;
  args: Record<string, unknown>;
  result?: string;
  status?: ToolStatus;
}

/* ─── Category colors ─── */

const CATEGORY_STYLES: Record<string, { border: string; bg: string; icon: string }> = {
  edit: {
    border: "border-amber-300",
    bg: "bg-amber-50/50",
    icon: "text-amber-500",
  },
  bash: {
    border: "border-gray-500",
    bg: "bg-gray-900",
    icon: "text-gray-400",
  },
  search: {
    border: "border-blue-300",
    bg: "bg-blue-50/50",
    icon: "text-blue-500",
  },
  default: {
    border: "border-gray-300",
    bg: "bg-gray-50/50",
    icon: "text-gray-500",
  },
};

const STATUS_CONFIG: Record<ToolStatus, { label: string; className: string }> = {
  running: {
    label: "Running",
    className: "bg-blue-100 text-blue-700",
  },
  complete: {
    label: "Done",
    className: "bg-emerald-100 text-emerald-700",
  },
  incomplete: {
    label: "Error",
    className: "bg-red-100 text-red-700",
  },
  "requires-action": {
    label: "Action needed",
    className: "bg-amber-100 text-amber-700",
  },
};

function getCategory(toolName: string): string {
  const name = toolName || "";
  if (["Edit", "Write", "ApplyPatch"].includes(name)) return "edit";
  if (["Grep", "Glob", "WebSearch", "WebFetch"].includes(name)) return "search";
  if (name === "Bash") return "bash";
  return "default";
}

/* ─── Status badge ─── */

function StatusBadge({ status }: { status: ToolStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-px text-[10px] font-medium",
        cfg.className,
      )}
    >
      {cfg.label}
    </span>
  );
}

/* ─── Status icon ─── */

function StatusIcon({ status }: { status: ToolStatus }) {
  switch (status) {
    case "running":
      return <LoaderIcon className="h-3.5 w-3.5 animate-spin text-blue-500" />;
    case "complete":
      return <CheckIcon className="h-3.5 w-3.5 text-emerald-500" />;
    case "incomplete":
      return <XCircleIcon className="h-3.5 w-3.5 text-red-500" />;
    case "requires-action":
      return <AlertCircleIcon className="h-3.5 w-3.5 text-amber-500" />;
  }
}

/* ─── Extract display value from args ─── */

function getDisplayValue(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
      return (args.command as string) || (args.description as string) || "";
    case "Edit":
    case "Write":
    case "ApplyPatch":
      return (args.file_path as string) || (args.filePath as string) || "";
    case "Grep":
    case "Glob":
      return (args.pattern as string) || "";
    case "Read":
      return (args.file_path as string) || (args.filePath as string) || "";
    default:
      return "";
  }
}

/* ─── Main renderer ─── */

export default function ToolRenderer({
  toolName,
  args,
  result,
  status = "complete",
}: ToolRendererProps) {
  const category = getCategory(toolName);
  const style = CATEGORY_STYLES[category] || CATEGORY_STYLES.default;
  const [open, setOpen] = useState(category === "bash" ? false : true);

  const displayValue = getDisplayValue(toolName, args);
  const formattedArgs = JSON.stringify(args, null, 2);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "group/tool my-2 overflow-hidden rounded-lg border",
        style.border,
        category === "bash" ? style.bg : style.bg,
      )}
    >
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
          category === "bash"
            ? "text-gray-200 hover:bg-gray-800"
            : "text-gray-700 hover:bg-gray-50",
        )}
      >
        <StatusIcon status={status} />

        <span className="font-medium">{toolName}</span>

        {displayValue && (
          <>
            <span className="text-gray-400">·</span>
            <span
              className={cn(
                "truncate font-mono text-xs",
                category === "bash" ? "text-green-400" : "text-gray-500",
              )}
            >
              {displayValue}
            </span>
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          <StatusBadge status={status} />
          <ChevronDownIcon
            className={cn(
              "h-4 w-4 shrink-0 transition-transform",
              open ? "rotate-180" : "rotate-0",
              category === "bash" ? "text-gray-500" : "text-gray-400",
            )}
          />
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent
        className={cn(
          "overflow-hidden text-sm",
          "data-[state=open]:animate-collapsible-down",
          "data-[state=closed]:animate-collapsible-up",
        )}
      >
        <div
          className={cn(
            "border-t px-3 py-2",
            category === "bash"
              ? "border-gray-700 bg-gray-900"
              : "border-gray-200 bg-white",
          )}
        >
          {/* Args */}
          <div className="mb-2">
            <h4
              className={cn(
                "mb-1 text-xs font-medium",
                category === "bash" ? "text-gray-400" : "text-gray-500",
              )}
            >
              Input
            </h4>
            <pre
              className={cn(
                "overflow-x-auto rounded p-2 text-xs leading-relaxed whitespace-pre-wrap",
                category === "bash"
                  ? "bg-gray-800 text-gray-300"
                  : "bg-gray-100 text-gray-700",
              )}
            >
              {formattedArgs}
            </pre>
          </div>

          {/* Result */}
          {result !== undefined && (
            <div>
              <h4
                className={cn(
                  "mb-1 text-xs font-medium",
                  category === "bash" ? "text-gray-400" : "text-gray-500",
                )}
              >
                Result
              </h4>
              <pre
                className={cn(
                  "max-h-64 overflow-auto rounded p-2 text-xs leading-relaxed whitespace-pre-wrap",
                  category === "bash"
                    ? "bg-gray-800 text-gray-300"
                    : "bg-gray-100 text-gray-700",
                )}
              >
                {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
