import { useState, type RefObject } from "react";
import { CheckIcon, CopyIcon, XIcon } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { buildClipboardHtml, writeRichClipboard } from "@/lib/clipboard";

interface MessageCopyButtonProps {
  contentRef: RefObject<HTMLElement | null>;
  getPlainText: () => string;
  alwaysVisible?: boolean;
  className?: string;
}

export default function MessageCopyButton({
  contentRef,
  getPlainText,
  alwaysVisible,
  className,
}: MessageCopyButtonProps) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  const onClick = async () => {
    if (status !== "idle") return;

    const plainText = getPlainText();
    if (!plainText) return;

    const html = contentRef.current
      ? buildClipboardHtml(contentRef.current)
      : plainText;

    try {
      await writeRichClipboard({ plainText, html });
      setStatus("copied");
      setTimeout(() => setStatus("idle"), 2000);
    } catch {
      setStatus("failed");
      setTimeout(() => setStatus("idle"), 2000);
    }
  };

  const label =
    status === "copied"
      ? "Copied"
      : status === "failed"
        ? "Copy failed"
        : "Copy message";

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            data-copy-ignore
            aria-label={label}
            className={cn(
              "inline-flex h-5 w-5 select-none items-center justify-center rounded text-gray-400 transition-all hover:bg-gray-100 hover:text-gray-600",
              !alwaysVisible &&
                "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
              className,
            )}
          >
            {status === "copied" ? (
              <CheckIcon className="h-3 w-3 text-emerald-500" />
            ) : status === "failed" ? (
              <XIcon className="h-3 w-3 text-red-500" />
            ) : (
              <CopyIcon className="h-3 w-3" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
