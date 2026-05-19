import { useState } from "react";
import {
  MessagePrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { MarkdownBlock } from "./MarkdownBlock";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { cn } from "@/lib/utils";

function extractTime(messageId: string | undefined): string {
  if (!messageId) return "";
  const match = messageId.match(/(\d{13})/);
  if (match) {
    return new Date(parseInt(match[1], 10)).toLocaleTimeString();
  }
  return "";
}

export default function UserMessage() {
  const messageId = useAuiState((s) => s.message.id);
  const time = extractTime(messageId);
  const [expanded, setExpanded] = useState(false);
  const [needsTruncation, setNeedsTruncation] = useState(false);

  // Inline ref callback fires on every render, re-measuring as content streams
  const measureRef = (el: HTMLDivElement | null) => {
    if (!el) return;
    setNeedsTruncation(el.scrollHeight > 72);
  };

  return (
    <MessagePrimitive.Root
      data-role="user"
      className="group relative"
    >
      {/* Gray-bordered box */}
      <div
        className={cn(
          "relative overflow-hidden rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm shadow-sm transition-all",
          !expanded && needsTruncation && "max-h-[4.5rem]",
        )}
      >
        <div
          ref={measureRef}
          className="whitespace-pre-wrap break-words text-gray-800"
        >
          <MessagePrimitive.Parts
            components={{
              Text: () => <MarkdownBlock />,
            }}
          />
        </div>

        {/* Gradient fade at bottom when collapsed and overflowing */}
        {!expanded && needsTruncation && (
          <div className="user-msg-fade rounded-b-xl" />
        )}
      </div>

      {/* Show more / Show less button — appears on hover */}
      {needsTruncation && (
        <button
          onClick={() => setExpanded(!expanded)}
          className={cn(
            "absolute -bottom-0 right-2 z-10 flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-0.5 text-[10px] text-gray-500 shadow-sm transition-all hover:bg-gray-50 hover:text-gray-700",
            "opacity-0 group-hover:opacity-100",
            expanded && "opacity-100",
          )}
        >
          {expanded ? (
            <>
              <ChevronUpIcon className="h-3 w-3" />
              Show less
            </>
          ) : (
            <>
              <ChevronDownIcon className="h-3 w-3" />
              Show more
            </>
          )}
        </button>
      )}

      {/* Footer: time */}
      {time && (
        <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-gray-400">
          <span>{time}</span>
        </div>
      )}
    </MessagePrimitive.Root>
  );
}
