import type { Blockquote, Paragraph, Root, Text } from "mdast";
import { visit } from "unist-util-visit";

/**
 * Render GitHub-style alert blockquotes.
 *
 * Markdown that opens a blockquote with `[!NOTE]` (or TIP / IMPORTANT /
 * WARNING / CAUTION) on its first line becomes a coloured callout: the marker
 * is dropped, a title row is prepended, and the blockquote is re-tagged as a
 * styled `<div>`. Styling rides entirely on Tailwind utility classes baked
 * into the emitted className, so no extra stylesheet is needed.
 *
 *   > [!WARNING]
 *   > This is important.
 */

type AlertKind = "note" | "tip" | "important" | "warning" | "caution";

const MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i;

// Per-kind border / title-text Tailwind classes (light + dark).
const KIND_STYLES: Record<AlertKind, { border: string; title: string }> = {
  note: { border: "border-blue-400 dark:border-blue-500", title: "text-blue-600 dark:text-blue-400" },
  tip: { border: "border-green-400 dark:border-green-500", title: "text-green-600 dark:text-green-400" },
  important: { border: "border-purple-400 dark:border-purple-500", title: "text-purple-600 dark:text-purple-400" },
  warning: { border: "border-amber-400 dark:border-amber-500", title: "text-amber-600 dark:text-amber-500" },
  caution: { border: "border-red-400 dark:border-red-500", title: "text-red-600 dark:text-red-400" },
};

const TITLE_TEXT: Record<AlertKind, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

function leadingText(node: Blockquote): Text | undefined {
  const first = node.children[0];
  if (!first || first.type !== "paragraph") return undefined;
  const lead = (first as Paragraph).children[0];
  return lead && lead.type === "text" ? (lead as Text) : undefined;
}

export function remarkAlert() {
  return (tree: Root) => {
    visit(tree, "blockquote", (node: Blockquote) => {
      const lead = leadingText(node);
      const match = lead?.value.match(MARKER);
      if (!lead || !match) return;

      const kind = match[1].toLowerCase() as AlertKind;
      const style = KIND_STYLES[kind];

      // Strip the marker; drop the now-empty leading line break if any.
      lead.value = lead.value.slice(match[0].length).replace(/^\n+/, "");

      const title: Paragraph = {
        type: "paragraph",
        children: [{ type: "text", value: TITLE_TEXT[kind] }],
        data: {
          hProperties: {
            className: `mb-1 flex items-center gap-2 text-sm font-medium ${style.title}`,
          },
        },
      };
      node.children.unshift(title);

      node.data = {
        hName: "div",
        hProperties: {
          className: `my-4 border-l-4 ${style.border} rounded-r bg-gray-50/50 py-2 pr-2 pl-4 dark:bg-gray-800/30`,
          dir: "auto",
        },
      };
    });
  };
}

export default remarkAlert;
