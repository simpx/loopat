import { useState } from "react";
import {
  MessagePrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { MarkdownBlock } from "./MarkdownBlock";

function extractTime(messageId: string | undefined): string {
  if (!messageId) return "";
  const match = messageId.match(/(\d{13})/);
  if (match) {
    return new Date(parseInt(match[1], 10)).toLocaleTimeString();
  }
  return "";
}

function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!content || copied) return;
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-0.5 text-blue-100 opacity-0 transition-opacity group-hover:opacity-100 hover:text-white"
      title="Copy message"
    >
      {copied ? (
        <CheckIcon className="h-3 w-3" />
      ) : (
        <CopyIcon className="h-3 w-3" />
      )}
    </button>
  );
}

export default function UserMessage() {
  const messageId = useAuiState((s) => s.message.id);
  const time = extractTime(messageId);

  const textContent = useAuiState((s) => {
    const parts = s.message.content;
    if (!Array.isArray(parts)) return "";
    return parts
      .filter((p: { type: string }) => p.type === "text")
      .map((p: { text?: string }) => p.text ?? "")
      .join("");
  });

  return (
    <MessagePrimitive.Root
      data-role="user"
      className="flex justify-end px-3 sm:px-0"
    >
      <div className="group flex w-full items-end gap-2 sm:w-auto sm:max-w-[85%] md:max-w-md lg:max-w-lg xl:max-w-xl">
        {/* Blue bubble */}
        <div className="flex-1 rounded-2xl rounded-br-md bg-blue-600 px-3 py-2 text-white shadow-sm sm:flex-initial sm:px-4">
          <div className="whitespace-pre-wrap break-words text-sm">
            <MessagePrimitive.Parts
              components={{
                // Use MarkdownBlock for text parts, fallback for others
                Text: () => <MarkdownBlock />,
              }}
            />
          </div>

          {/* Footer: copy + time */}
          <div className="mt-1 flex items-center justify-end gap-1 text-xs text-blue-200">
            <CopyButton content={textContent} />
            {time && <span>{time}</span>}
          </div>
        </div>

        {/* "U" avatar */}
        <div className="hidden h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm text-white sm:flex">
          U
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}
