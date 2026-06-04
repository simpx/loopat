import DOMPurify from "dompurify";

/**
 * Sanitise an SVG string before it is injected as raw markup. DOMPurify is
 * restricted to the SVG and SVG-filter profiles so only drawing primitives
 * survive — scripts, event handlers and foreign content are dropped.
 *
 * Returns an empty string outside the browser (no DOM to purify against).
 */
export function sanitizeSvg(svg: string): string {
  if (typeof window === "undefined") return "";
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
  });
}

/** True when the text looks like a standalone SVG document. */
export function isSvgContent(code: string): boolean {
  return /^\s*(?:<\?xml[\s\S]*?\?>\s*)?<svg[\s>]/i.test(code);
}
