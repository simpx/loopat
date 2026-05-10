"use client";

import "@assistant-ui/react-markdown/styles/dot.css";

import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { memo, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const MarkdownTextImpl = () => {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="aui-md"
      components={defaultComponents}
    />
  );
};

export const MarkdownBlock = memo(MarkdownTextImpl);

/* ─── Code header with language label and copy button ─── */

const CodeHeader: React.FC<CodeHeaderProps> = ({ language, code }) => {
  const { isCopied, copyToClipboard } = useClipboard();
  const onCopy = () => {
    if (!code || isCopied) return;
    copyToClipboard(code);
  };

  return (
    <div className="flex items-center justify-between gap-2 rounded-t-lg border border-gray-700 border-b-0 bg-gray-800 px-3 py-1.5 text-xs">
      <span className="font-medium text-gray-400 lowercase">
        {language || "text"}
      </span>
      <button
        type="button"
        onClick={onCopy}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-gray-400 transition-colors hover:bg-gray-700 hover:text-gray-200"
      >
        {isCopied ? (
          <CheckIcon className="h-3 w-3 text-emerald-400" />
        ) : (
          <CopyIcon className="h-3 w-3" />
        )}
        <span className="text-[10px]">{isCopied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
};

/* ─── Clipboard hook ─── */

function useClipboard({ copiedDuration = 2000 } = {}) {
  const [isCopied, setIsCopied] = useState(false);

  const copyToClipboard = (value: string) => {
    if (!value) return;
    navigator.clipboard.writeText(value).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), copiedDuration);
    });
  };

  return { isCopied, copyToClipboard };
}

/* ─── Custom markdown components ─── */

const defaultComponents = memoizeMarkdownComponents({
  h1: ({ className, ...props }: React.ComponentProps<"h1">) => (
    <h1
      className={cn(
        "mb-2 scroll-m-20 font-semibold text-base first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h2: ({ className, ...props }: React.ComponentProps<"h2">) => (
    <h2
      className={cn(
        "mt-3 mb-1.5 scroll-m-20 font-semibold text-sm first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h3: ({ className, ...props }: React.ComponentProps<"h3">) => (
    <h3
      className={cn(
        "mt-2.5 mb-1 scroll-m-20 font-semibold text-sm first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h4: ({ className, ...props }: React.ComponentProps<"h4">) => (
    <h4
      className={cn(
        "mt-2 mb-1 scroll-m-20 font-medium text-sm first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  p: ({ className, ...props }: React.ComponentProps<"p">) => (
    <p
      className={cn(
        "my-2.5 leading-normal first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  a: ({ className, ...props }: React.ComponentProps<"a">) => (
    <a
      className={cn(
        "text-blue-600 underline underline-offset-2 hover:text-blue-500",
        className,
      )}
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    />
  ),
  blockquote: ({ className, ...props }: React.ComponentProps<"blockquote">) => (
    <blockquote
      className={cn(
        "my-2.5 border-gray-300 border-s-2 ps-3 text-gray-500 italic",
        className,
      )}
      {...props}
    />
  ),
  ul: ({ className, ...props }: React.ComponentProps<"ul">) => (
    <ul
      className={cn(
        "my-2 ms-4 list-disc marker:text-gray-400 [&>li]:mt-1",
        className,
      )}
      {...props}
    />
  ),
  ol: ({ className, ...props }: React.ComponentProps<"ol">) => (
    <ol
      className={cn(
        "my-2 ms-4 list-decimal marker:text-gray-400 [&>li]:mt-1",
        className,
      )}
      {...props}
    />
  ),
  hr: ({ className, ...props }: React.ComponentProps<"hr">) => (
    <hr
      className={cn("my-2 border-gray-200", className)}
      {...props}
    />
  ),
  table: ({ className, ...props }: React.ComponentProps<"table">) => (
    <table
      className={cn(
        "my-2 w-full border-separate border-spacing-0 overflow-y-auto",
        className,
      )}
      {...props}
    />
  ),
  th: ({ className, ...props }: React.ComponentProps<"th">) => (
    <th
      className={cn(
        "bg-gray-50 px-2 py-1 text-start font-medium first:rounded-ss-lg last:rounded-se-lg [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }: React.ComponentProps<"td">) => (
    <td
      className={cn(
        "border-gray-200 border-s border-b px-2 py-1 text-start last:border-e [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }: React.ComponentProps<"tr">) => (
    <tr
      className={cn(
        "m-0 border-b p-0 first:border-t [&:last-child>td:first-child]:rounded-es-lg [&:last-child>td:last-child]:rounded-ee-lg",
        className,
      )}
      {...props}
    />
  ),
  li: ({ className, ...props }: React.ComponentProps<"li">) => (
    <li className={cn("leading-normal", className)} {...props} />
  ),
  sup: ({ className, ...props }: React.ComponentProps<"sup">) => (
    <sup
      className={cn("[&>a]:text-xs [&>a]:no-underline", className)}
      {...props}
    />
  ),
  pre: ({ className, ...props }: React.ComponentProps<"pre">) => (
    <pre
      className={cn(
        "overflow-x-auto rounded-t-none rounded-b-lg border border-gray-700 border-t-0 bg-gray-900 p-3 text-xs leading-relaxed text-gray-200",
        className,
      )}
      {...props}
    />
  ),
  code: function Code({ className, ...props }: React.ComponentProps<"code">) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    return (
      <code
        className={cn(
          !isCodeBlock &&
            "rounded-md border border-gray-200 bg-gray-100 px-1.5 py-0.5 font-mono text-[0.85em] text-gray-800",
          className,
        )}
        {...props}
      />
    );
  },
  CodeHeader,
});
