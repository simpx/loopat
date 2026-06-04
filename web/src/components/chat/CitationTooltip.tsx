"use client";

import { isValidElement, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

type AnchorProps = React.ComponentProps<"a"> & { node?: unknown };

const CITATION_TEXT = /^\s*\[\d+\]\s*$/;
const OPEN_DELAY_MS = 300;
const CLOSE_DELAY_MS = 150;

/** Flatten a React subtree down to its visible text. */
function collectText(node: React.ReactNode): string {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (isValidElement(node)) {
    return collectText((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

/** Best-effort human label + hostname for a citation target. */
function describeTarget(href: string | undefined): { title: string; host: string } {
  if (!href) return { title: "", host: "" };
  try {
    const url = new URL(href, window.location.href);
    const host = url.hostname.replace(/^www\./, "");
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments.length ? segments[segments.length - 1] : "";
    const fromPath = last
      ? decodeURIComponent(last)
          .replace(/\.[a-z0-9]+$/i, "")
          .replace(/[-_]+/g, " ")
          .trim()
      : "";
    return { title: fromPath || host, host };
  } catch {
    return { title: href, host: href };
  }
}

const CitationAnchor = ({ node, className, children, href, ...props }: AnchorProps) => {
  void node;
  const anchorRef = useRef<HTMLAnchorElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const [anchorPoint, setAnchorPoint] = useState({ left: 0, top: 0 });

  const clearTimers = () => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  };

  const open = () => {
    clearTimers();
    openTimer.current = setTimeout(() => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setAnchorPoint({ left: rect.left + rect.width / 2, top: rect.top });
      setMounted(true);
    }, OPEN_DELAY_MS);
  };

  const close = () => {
    clearTimers();
    closeTimer.current = setTimeout(() => setShown(false), CLOSE_DELAY_MS);
  };

  // Fade in on the frame after the card mounts.
  useEffect(() => {
    if (!mounted) return;
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, [mounted]);

  useEffect(() => () => clearTimers(), []);

  const { title, host } = describeTarget(href);

  return (
    <>
      <a
        ref={anchorRef}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
        className={cn(
          "cursor-help font-medium text-blue-600 no-underline hover:text-blue-500",
          className,
        )}
        {...props}
      >
        {children}
      </a>
      {mounted &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            role="tooltip"
            data-copy-ignore
            onMouseEnter={clearTimers}
            onMouseLeave={close}
            onTransitionEnd={() => {
              if (!shown) setMounted(false);
            }}
            style={{
              position: "fixed",
              left: anchorPoint.left,
              top: anchorPoint.top,
              transform: `translate(-50%, calc(-100% - ${shown ? 8 : 2}px))`,
              opacity: shown ? 1 : 0,
              pointerEvents: shown ? "auto" : "none",
              zIndex: 60,
            }}
            className="max-w-xs rounded-lg border border-gray-200 bg-white p-2.5 text-xs shadow-lg transition-[opacity,transform] duration-150 ease-out"
          >
            {title && (
              <div className="line-clamp-2 font-medium text-gray-800">{title}</div>
            )}
            <div className="mt-1 truncate text-[10px] text-gray-400">{host}</div>
          </div>,
          document.body,
        )}
    </>
  );
};

export const CitationLink = ({ children, ...props }: AnchorProps) => {
  const isCitation = CITATION_TEXT.test(collectText(children));
  if (isCitation) {
    return <CitationAnchor {...props}>{children}</CitationAnchor>;
  }

  const { node, className, ...rest } = props;
  void node;
  return (
    <a
      target="_blank"
      rel="noopener noreferrer"
      className={cn("text-blue-600 hover:underline", className)}
      {...rest}
    >
      {children}
    </a>
  );
};
