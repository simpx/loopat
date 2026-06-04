"use client";

import { ExternalLinkIcon, LinkIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { sanitizeSvg } from "@/lib/sanitizeSvg";

type SvgRendererProps = React.SVGProps<SVGSVGElement> & { node?: unknown };

const MEASURE_KEY = "dataneedsmeasurement";

function normalize(key: string): string {
  return key.toLowerCase().replace(/-/g, "");
}

/**
 * Renders an inline `<svg>` element coming from raw markdown HTML.
 *
 * Graphics flagged by the scalable-svg pass (intrinsic size in relative units,
 * no viewBox) are measured once after layout and rewritten to a pixel viewBox
 * with a fluid width. The measured result is then locked in: subsequent renders
 * (e.g. while a message is still streaming) drop the original width/height and
 * the marker from the spread so React cannot undo the adjustment.
 *
 * A right-click offers opening the graphic in a new tab or copying a blob URL.
 */
export const SvgRenderer = ({ node, children, ...rest }: SvgRendererProps) => {
  void node;
  const svgRef = useRef<SVGSVGElement>(null);
  const measuredRef = useRef(false);
  const [viewBox, setViewBox] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; url: string } | null>(
    null,
  );

  const props = rest as Record<string, unknown>;

  const needsMeasurement = useMemo(
    () =>
      Object.entries(props).some(
        ([key, value]) =>
          normalize(key) === MEASURE_KEY && (value === true || value === "true"),
      ),
    [props],
  );

  useEffect(() => {
    if (!needsMeasurement || measuredRef.current) return;
    const el = svgRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return; // hidden — leave as-is
      measuredRef.current = true;
      setViewBox(`0 0 ${Math.round(rect.width)} ${Math.round(rect.height)}`);
    });
    return () => cancelAnimationFrame(frame);
  }, [needsMeasurement]);

  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("click", dismiss);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("keydown", onKey);
      URL.revokeObjectURL(menu.url);
    };
  }, [menu]);

  const measured = viewBox !== null;

  const svgProps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (measured) {
      const norm = normalize(key);
      if (norm === "width" || norm === "height" || norm === MEASURE_KEY) continue;
    }
    svgProps[key] = value;
  }
  if (measured) {
    svgProps.viewBox = viewBox;
    svgProps.width = "100%";
  }

  const openContextMenu = (event: React.MouseEvent) => {
    const el = svgRef.current;
    if (!el) return;
    event.preventDefault();
    const markup = new XMLSerializer().serializeToString(el);
    const blob = new Blob([markup], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    setMenu({ x: event.clientX, y: event.clientY, url });
  };

  return (
    <>
      <svg
        ref={svgRef}
        {...(svgProps as React.SVGProps<SVGSVGElement>)}
        onContextMenu={openContextMenu}
      >
        {children}
      </svg>
      {menu &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            role="menu"
            data-copy-ignore
            onClick={(e) => e.stopPropagation()}
            style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 60 }}
            className="min-w-[10rem] overflow-hidden rounded-md border border-gray-200 bg-white py-1 text-xs shadow-lg"
          >
            <button
              type="button"
              onClick={() => {
                window.open(menu.url, "_blank", "noopener,noreferrer");
                setMenu(null);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 hover:bg-gray-100"
            >
              <ExternalLinkIcon className="h-3.5 w-3.5" />
              Open in new tab
            </button>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(menu.url);
                setMenu(null);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-gray-700 hover:bg-gray-100"
            >
              <LinkIcon className="h-3.5 w-3.5" />
              Copy URL
            </button>
          </div>,
          document.body,
        )}
    </>
  );
};

/**
 * Renders a fenced ```svg / SVG-flavoured ```xml block as a sanitised, centred
 * image. No code header — the graphic is the content.
 */
export const FencedSvg = ({ svg }: { svg: string }) => {
  const html = sanitizeSvg(svg);
  if (!html) return null;
  return (
    <div
      className="my-2 flex justify-center overflow-x-auto [&>svg]:h-auto [&>svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
