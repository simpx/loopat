import { useState } from "react";
import {
  MessagePrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { MarkdownBlock } from "./MarkdownBlock";
import { ChevronDownIcon, ChevronUpIcon, FileText, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

function extractTime(messageId: string | undefined): string {
  if (!messageId) return "";
  const match = messageId.match(/(\d{13})/);
  if (match) {
    return new Date(parseInt(match[1], 10)).toLocaleTimeString();
  }
  return "";
}

/** Parse `# File: path\n\`\`\`ext\n...\n\`\`\`\n` blocks */
function parseFileBlocks(text: string): { path: string; content: string }[] {
  const blocks: { path: string; content: string }[] = []
  const re = /(?:^|\n)# File: (.+?)\n```(\w*)\n([\s\S]*?)```\n/g
  let m
  while ((m = re.exec(text)) !== null) {
    blocks.push({ path: m[1], content: m[3] })
  }
  return blocks
}

function stripFileBlocks(text: string): string {
  return text.replace(/(?:\n|^)# File: .+?\n```\w*\n[\s\S]*?```\n/g, "").trim()
}

function FileCard({ filePath, content }: { filePath: string; content: string }) {
  const [open, setOpen] = useState(false)
  const shortName = filePath.includes("/") ? filePath.slice(filePath.lastIndexOf("/") + 1) : filePath
  const ext = filePath.includes(".") ? filePath.split(".").pop() ?? "" : ""
  return (
    <div className="inline-flex flex-col overflow-hidden rounded border border-gray-200 bg-gray-50/70 text-xs max-w-max">
      <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 px-1.5 py-0.5 text-left hover:bg-gray-100 transition-colors">
        <ChevronRight size={9} className={cn("shrink-0 text-gray-400 transition-transform", open && "rotate-90")} />
        <FileText size={9} className="shrink-0 text-gray-400" />
        <span className="text-gray-500 truncate max-w-[200px]">{shortName}</span>
        <span className="text-[9px] text-gray-400 ml-1">{ext}</span>
      </button>
      {open && (
        <pre className="border-t border-gray-200 px-2 py-1 text-[10px] leading-relaxed text-gray-500 whitespace-pre-wrap break-all max-h-48 overflow-auto font-mono">
          {content}
        </pre>
      )}
    </div>
  )
}

export default function UserMessage() {
  const messageId = useAuiState((s) => s.message.id);
  const time = extractTime(messageId);
  const [expanded, setExpanded] = useState(false);
  const [needsTruncation, setNeedsTruncation] = useState(false);

  const measureRef = (el: HTMLDivElement | null) => {
    if (!el) return;
    setNeedsTruncation(el.scrollHeight > 72);
  };

  return (
    <MessagePrimitive.Root data-role="user" className="group relative">

      <div className={cn("relative overflow-hidden rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm shadow-sm transition-all", !expanded && needsTruncation && "max-h-[4.5rem]")}>
        <div ref={measureRef} className="whitespace-pre-wrap break-words text-gray-800">
          <MessagePrimitive.Parts
            components={{
              Text: (props) => {
                const raw = (props as any).text ?? ""
                const blocks = parseFileBlocks(raw)
                const cleaned = stripFileBlocks(raw)
                if (blocks.length === 0) return <MarkdownBlock />
                return (
                  <>
                    <div className="flex flex-wrap gap-1 mb-1.5">
                      {blocks.map((b, i) => <FileCard key={i} filePath={b.path} content={b.content} />)}
                    </div>
                    {cleaned ? <span>{cleaned}</span> : <span className="text-red-500">[empty after strip]</span>}
                  </>
                )
              },
            }}
          />
        </div>
        {!expanded && needsTruncation && <div className="user-msg-fade rounded-b-xl" />}
      </div>

      {needsTruncation && (
        <button onClick={() => setExpanded(!expanded)} className={cn("absolute -bottom-0 right-2 z-10 flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-0.5 text-[10px] text-gray-500 shadow-sm transition-all hover:bg-gray-50 hover:text-gray-700", "opacity-0 group-hover:opacity-100", expanded && "opacity-100")}>
          {expanded ? <><ChevronUpIcon className="h-3 w-3" />Show less</> : <><ChevronDownIcon className="h-3 w-3" />Show more</>}
        </button>
      )}

      {time && <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-gray-400"><span>{time}</span></div>}
    </MessagePrimitive.Root>
  );
}
