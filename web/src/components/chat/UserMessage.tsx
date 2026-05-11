import {
  MessagePrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { MarkdownBlock } from "./MarkdownBlock";

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

  return (
    <MessagePrimitive.Root
      data-role="user"
      className="flex justify-end px-3 sm:px-0"
    >
      <div className="group flex w-full items-end gap-2 sm:w-auto sm:max-w-[85%] md:max-w-md lg:max-w-lg xl:max-w-xl">
        {/* Blue bubble */}
        <div className="flex-1 rounded-2xl rounded-br-md bg-sky-600 px-3 py-2 text-white shadow-sm sm:flex-initial sm:px-4">
          <div className="whitespace-pre-wrap break-words text-sm">
            <MessagePrimitive.Parts
              components={{
                // Use MarkdownBlock for text parts, fallback for others
                Text: () => <MarkdownBlock />,
              }}
            />
          </div>

          {/* Footer: time */}
          {time && (
            <div className="mt-1 flex items-center justify-end gap-1 text-xs text-sky-200">
              <span>{time}</span>
            </div>
          )}
        </div>

        {/* "U" avatar */}
        <div className="hidden h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-sky-600 text-sm text-white sm:flex">
          U
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}
