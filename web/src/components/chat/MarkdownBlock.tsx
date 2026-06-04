"use client";

import "@assistant-ui/react-markdown/styles/dot.css";
import "katex/dist/katex.min.css";
// mhchem extends KaTeX with chemistry macros (\ce, \pu); copy-tex makes a
// selection copy the underlying TeX rather than the rendered glyphs. Both are
// side-effect modules that patch the shared KaTeX instance / document.
import "katex/contrib/mhchem";
import "katex/contrib/copy-tex";
import "remark-github-blockquote-alert/alert.css";

import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  type SyntaxHighlighterProps,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import { useMessagePartText } from "@assistant-ui/react";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkCjkFriendly from "remark-cjk-friendly";
import { remarkAlert } from "remark-github-blockquote-alert";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import type { PluggableList } from "unified";
import {
  Fragment,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CheckIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CopyIcon,
  WrapTextIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { processLatexBrackets } from "@/lib/processLatexBrackets";
import { isSvgContent } from "@/lib/sanitizeSvg";
import { rehypeScalableSvg, rehypeStripUnsafe } from "@/lib/rehypeScalableSvg";
import {
  setTall,
  toggleCollapsed,
  toggleWrap,
  useCodeBlockUi,
} from "@/lib/codeBlockUiStore";
import { HtmlArtifactCard } from "./HtmlArtifactCard";
import { TableWithToolbar } from "./TableWithToolbar";
import { CitationLink } from "./CitationTooltip";
import { FencedSvg, SvgRenderer } from "./SvgRenderer";
import { MermaidBlock } from "./MermaidBlock";
import { PlantUMLBlock } from "./PlantUMLBlock";
import { GraphvizBlock } from "./GraphvizBlock";

/** Vertical height (px) past which a code block is offered collapsed. */
const COLLAPSE_THRESHOLD_PX = 400;
/** Minimum line count before a gutter of line numbers is drawn. */
const GUTTER_MIN_LINES = 5;

// Raw-HTML parsing is opt-in per message: rehype-raw is only worth the cost
// when the source actually contains one of the inline tags we care about.
const RAW_HTML_HINT =
  /<(svg|details|summary|sup|sub|br|abbr|table|thead|tbody|tr|th|td)\b/i;

const REMARK_PLUGINS: PluggableList = [
  remarkGfm,
  remarkCjkFriendly,
  [remarkMath, { singleDollarTextMath: true }],
  remarkAlert,
];
const REHYPE_PLAIN: PluggableList = [rehypeKatex, rehypeScalableSvg];
const REHYPE_WITH_RAW: PluggableList = [
  rehypeRaw,
  rehypeStripUnsafe,
  rehypeKatex,
  rehypeScalableSvg,
];

const MarkdownTextImpl = () => {
  const { text } = useMessagePartText();
  const allowRaw = RAW_HTML_HINT.test(text);
  const rehypePlugins = useMemo(
    () => (allowRaw ? REHYPE_WITH_RAW : REHYPE_PLAIN),
    [allowRaw],
  );

  return (
    <MarkdownTextPrimitive
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={rehypePlugins}
      preprocess={processLatexBrackets}
      disallowedElements={["iframe", "script"]}
      className="aui-md"
      components={defaultComponents}
      componentsByLanguage={componentsByLanguage}
    />
  );
};

export const MarkdownBlock = memo(MarkdownTextImpl);

/* ─── Code header with language label and copy button ─── */

const CodeHeader: React.FC<CodeHeaderProps> = ({ language, code }) => {
  const key = code ?? "";
  const { wrap } = useCodeBlockUi(key);
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
      <div data-copy-ignore className="flex select-none items-center gap-1">
        <button
          type="button"
          onClick={() => toggleWrap(key)}
          aria-pressed={wrap}
          title="Toggle soft wrap"
          className={cn(
            "flex items-center gap-1 rounded px-1.5 py-0.5 text-gray-400 transition-colors hover:bg-gray-700 hover:text-gray-200",
            wrap && "text-gray-200",
          )}
        >
          <WrapTextIcon className="h-3 w-3" />
          <span className="text-[10px]">Wrap</span>
        </button>
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
    </div>
  );
};

/* ─── Per-language code block overrides ─── */

// Languages whose blocks render as bespoke widgets suppress the code header.
const NoCodeHeader = () => null;

// ```svg → always an image.
const SvgFencedBlock = ({ code }: SyntaxHighlighterProps) => <FencedSvg svg={code} />;

// ```xml → an image when it is actually SVG, otherwise a normal code block.
const XmlBlock = ({ code, node, components }: SyntaxHighlighterProps) => {
  if (isSvgContent(code)) return <FencedSvg svg={code} />;
  const { Pre, Code } = components;
  return (
    <Pre>
      <Code node={node}>{code}</Code>
    </Pre>
  );
};

const XmlHeader = ({ language, code }: CodeHeaderProps) =>
  isSvgContent(code) ? null : <CodeHeader language={language} code={code} />;

const componentsByLanguage = {
  html: { SyntaxHighlighter: HtmlArtifactCard, CodeHeader: NoCodeHeader },
  svg: { SyntaxHighlighter: SvgFencedBlock, CodeHeader: NoCodeHeader },
  xml: { SyntaxHighlighter: XmlBlock, CodeHeader: XmlHeader },
  mermaid: { SyntaxHighlighter: MermaidBlock, CodeHeader: NoCodeHeader },
  plantuml: { SyntaxHighlighter: PlantUMLBlock, CodeHeader: NoCodeHeader },
  dot: { SyntaxHighlighter: GraphvizBlock, CodeHeader: NoCodeHeader },
  graphviz: { SyntaxHighlighter: GraphvizBlock, CodeHeader: NoCodeHeader },
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

/* ─── Shared code-block body: gutter, wrap, collapse ─── */

// The <pre> receives its <code> child as a React element; pull the raw source
// back out so the header, the scroller and the gutter all key off one string.
function readCodeText(children: React.ReactNode): string {
  if (isValidElement(children)) {
    const inner = (children.props as { children?: unknown }).children;
    if (typeof inner === "string") return inner;
  }
  return "";
}

const CodeBlockPre = ({
  className,
  children,
  ...props
}: React.ComponentProps<"pre">) => {
  const key = readCodeText(children);
  const { wrap, collapsed, tall } = useCodeBlockUi(key);
  const scrollerRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () =>
      setTall(key, el.scrollHeight > COLLAPSE_THRESHOLD_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [key]);

  const clamped = tall && collapsed;

  return (
    <div className="relative">
      <pre
        ref={scrollerRef}
        className={cn(
          "overflow-x-auto rounded-t-none rounded-b-lg border border-gray-700 border-t-0 bg-gray-900 p-3 text-xs leading-relaxed text-gray-200",
          wrap && "whitespace-pre-wrap break-words",
          clamped && "overflow-y-hidden",
          className,
        )}
        style={clamped ? { maxHeight: COLLAPSE_THRESHOLD_PX } : undefined}
        {...props}
      >
        {children}
      </pre>
      {clamped && (
        <div
          data-copy-ignore
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-16 rounded-b-lg bg-gradient-to-t from-gray-900 to-transparent"
        />
      )}
      {tall && (
        <div className="mt-1 flex justify-center">
          <button
            type="button"
            data-copy-ignore
            onClick={() => toggleCollapsed(key)}
            className="flex select-none items-center gap-1 rounded-full border border-gray-700 bg-gray-800 px-2.5 py-0.5 text-[10px] text-gray-300 transition-colors hover:bg-gray-700"
          >
            {collapsed ? (
              <ChevronsUpDownIcon className="h-3 w-3" />
            ) : (
              <ChevronsDownUpIcon className="h-3 w-3" />
            )}
            {collapsed ? "Show more" : "Show less"}
          </button>
        </div>
      )}
    </div>
  );
};

const CodeBlockCode = ({
  className,
  children,
  ...props
}: React.ComponentProps<"code">) => {
  const isCodeBlock = useIsMarkdownCodeBlock();
  const text = typeof children === "string" ? children : "";
  const { wrap } = useCodeBlockUi(text);

  if (!isCodeBlock) {
    return (
      <code
        className={cn(
          "rounded-md border border-gray-200 bg-gray-100 px-1.5 py-0.5 font-mono text-[0.85em] text-gray-800",
          className,
        )}
        {...props}
      >
        {children}
      </code>
    );
  }

  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length < GUTTER_MIN_LINES) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }

  const gutterWidth = `${String(lines.length).length + 1}ch`;
  const lineWhitespace = wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre";

  return (
    <code
      className={cn("grid", className)}
      style={{ gridTemplateColumns: "auto minmax(0, 1fr)" }}
      {...props}
    >
      {lines.map((line, index) => (
        <Fragment key={index}>
          <span
            data-copy-ignore
            aria-hidden
            className="sticky left-0 select-none bg-gray-900 pr-3 text-right text-gray-600 tabular-nums"
            style={{ minWidth: gutterWidth }}
          >
            {index + 1}
          </span>
          <span className={lineWhitespace}>{`${line}\n`}</span>
        </Fragment>
      ))}
    </code>
  );
};

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
        "my-1 leading-normal first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  a: CitationLink,
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
  table: TableWithToolbar,
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
  pre: CodeBlockPre,
  code: CodeBlockCode,
  svg: SvgRenderer,
  CodeHeader,
});
