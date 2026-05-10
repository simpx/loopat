import { useState, type FC } from "react";
import {
  MessagePrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { BrainIcon, CheckIcon, CopyIcon } from "lucide-react";
import { MarkdownBlock } from "./MarkdownBlock";
import ToolRenderer from "./ToolRenderer";
import {
  ReasoningRoot,
  ReasoningTrigger,
  ReasoningContent,
  ReasoningText,
} from "@/components/assistant-ui/reasoning";
import {
  ToolGroupRoot,
  ToolGroupTrigger,
  ToolGroupContent,
} from "@/components/assistant-ui/tool-group";

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
      className="inline-flex items-center gap-0.5 text-gray-400 transition-colors hover:text-gray-600"
      title="Copy message"
    >
      {copied ? (
        <CheckIcon className="h-3 w-3 text-emerald-500" />
      ) : (
        <CopyIcon className="h-3 w-3" />
      )}
    </button>
  );
}

/* ─── JSON detection helper ─── */

function JsonBlock({ content }: { content: string }) {
  const trimmed = content.trim();
  if (
    !(trimmed.startsWith("{") || trimmed.startsWith("[")) ||
    !(trimmed.endsWith("}") || trimmed.endsWith("]"))
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    const formatted = JSON.stringify(parsed, null, 2);
    return (
      <div className="my-2">
        <div className="mb-2 flex items-center gap-2 text-sm text-gray-500">
          <svg
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
            />
          </svg>
          <span className="font-medium">JSON</span>
        </div>
        <div className="overflow-hidden rounded-lg border border-gray-600/30 bg-gray-900">
          <pre className="overflow-x-auto p-4">
            <code className="block whitespace-pre font-mono text-sm text-gray-200">
              {formatted}
            </code>
          </pre>
        </div>
      </div>
    );
  } catch {
    return null;
  }
}

/* ─── Tool group display ─── */

const ToolGroupDisplay: FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <ToolGroupRoot>
      <ToolGroupTrigger
        count={1}
        active={false}
      />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
};

/* ─── Assistant message ─── */

export default function AssistantMessage() {
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

  const children = (
    <MessagePrimitive.GroupedParts
      groupBy={(part) => {
        if (part.type === "reasoning")
          return ["group-chainOfThought", "group-reasoning"];
        if (part.type === "tool-call")
          return ["group-chainOfThought", "group-tool"];
        return null;
      }}
    >
      {({ part, children }) => {
        switch (part.type) {
          case "group-chainOfThought":
            return <div data-slot="chain-of-thought">{children}</div>;
          case "group-reasoning": {
            const running = part.status.type === "running";
            return (
              <ReasoningRoot defaultOpen={running}>
                <ReasoningTrigger active={running} />
                <ReasoningContent aria-busy={running}>
                  <ReasoningText>{children}</ReasoningText>
                </ReasoningContent>
              </ReasoningRoot>
            );
          }
          case "group-tool":
            return (
              <ToolGroupRoot>
                <ToolGroupTrigger
                  count={part.indices.length}
                  active={part.status.type === "running"}
                />
                <ToolGroupContent>{children}</ToolGroupContent>
              </ToolGroupRoot>
            );
          case "text": {
            const content = textContent;
            const jsonBlock = JsonBlock({ content });
            if (jsonBlock) {
              return <div>{jsonBlock}</div>;
            }
            return <MarkdownBlock />;
          }
          case "reasoning":
            return null; // handled by group-reasoning
          case "tool-call": {
            const args = (part as any).args ?? {};
            const result = (part as any).result;
            const status = (part as any).status?.type ?? "complete";
            return (
              <ToolRenderer
                toolName={(part as any).toolName ?? "Unknown"}
                args={args}
                result={result}
                status={status}
              />
            );
          }
          default:
            return null;
        }
      }}
    </MessagePrimitive.GroupedParts>
  );

  return (
    <MessagePrimitive.Root
      data-role="assistant"
      className="px-3 sm:px-0"
    >
      {/* Avatar + name header */}
      <div className="mb-2 flex items-center gap-3">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-orange-100">
          <BrainIcon className="h-4 w-4 text-orange-600" />
        </div>
        <span className="text-sm font-medium text-gray-900">Claude</span>
      </div>

      {/* Content */}
      <div className="w-full text-sm text-gray-700">
        {children}
      </div>

      {/* Footer: copy + time */}
      <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-400">
        <CopyButton content={textContent} />
        {time && <span>{time}</span>}
      </div>
    </MessagePrimitive.Root>
  );
}
