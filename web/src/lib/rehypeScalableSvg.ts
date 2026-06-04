import type { Element, Root } from "hast";
import { SKIP, visit } from "unist-util-visit";

/**
 * Two small HAST passes used by the markdown renderer when raw HTML is enabled.
 *
 * `rehypeStripUnsafe` is a defensive scrub: it removes elements that can run
 * code or load external content and deletes every inline event handler.
 *
 * `rehypeScalableSvg` makes inline `<svg>` graphics behave responsively by
 * giving them a viewBox and a fluid width, deferring to a runtime measurement
 * when the intrinsic size is expressed in non-pixel units.
 */

const UNSAFE_TAGS = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "foreignobject",
]);

export function rehypeStripUnsafe() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element, index, parent) => {
      if (UNSAFE_TAGS.has(node.tagName.toLowerCase())) {
        if (parent && typeof index === "number") {
          parent.children.splice(index, 1);
          return [SKIP, index];
        }
      }
      const props = node.properties;
      if (props) {
        for (const key of Object.keys(props)) {
          if (/^on/i.test(key)) delete props[key];
        }
      }
      return undefined;
    });
  };
}

type Dimension = { kind: "px"; value: number } | { kind: "unit" } | null;

function measureDimension(value: unknown): Dimension {
  if (typeof value === "number") return { kind: "px", value };
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  const pixels = /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(text);
  if (pixels) return { kind: "px", value: Number(pixels[1]) };
  if (/(?:em|rem|%|pt|ex|ch|vw|vh|vmin|vmax|cm|mm|in|pc|q)$/i.test(text)) {
    return { kind: "unit" };
  }
  return null;
}

function asCssLength(value: unknown): string | undefined {
  if (typeof value === "number") return `${value}px`;
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function appendStyle(existing: unknown, addition: string): string {
  const base = typeof existing === "string" ? existing.trim().replace(/;$/, "") : "";
  return base ? `${base}; ${addition}` : addition;
}

export function rehypeScalableSvg() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName.toLowerCase() !== "svg") return;
      const props = (node.properties ??= {});

      const hasViewBox =
        props.viewBox != null && String(props.viewBox).trim() !== "";
      if (hasViewBox) return; // (c) already scalable — leave alone.

      const width = measureDimension(props.width);
      const height = measureDimension(props.height);

      // (a) Concrete pixel box with no viewBox: derive one and go fluid.
      if (width?.kind === "px" && height?.kind === "px") {
        props.viewBox = `0 0 ${width.value} ${height.value}`;
        props.width = "100%";
        delete props.height;
        return;
      }

      // (b) Sized in relative units: flag for a post-mount measurement and
      // keep the original width as an upper bound.
      if (width?.kind === "unit" || height?.kind === "unit") {
        props["data-needs-measurement"] = "true";
        const original = asCssLength(props.width);
        if (original) {
          props.style = appendStyle(props.style, `max-width:${original}`);
        }
      }
    });
  };
}
