import { useEffect, useRef, useState } from "react";

export interface DebouncedRenderResult {
  html: string;
  error: string | null;
  isLoading: boolean;
}

const IDLE: DebouncedRenderResult = { html: "", error: null, isLoading: false };

/**
 * Debounce an async string→HTML render. After `content` (or `renderKey`)
 * changes, the renderer is invoked once the input has been still for `delay`
 * ms. Only the most recent invocation is allowed to commit — a monotonically
 * increasing token discards results from superseded or unmounted renders.
 *
 * `renderKey` lets callers force a re-render when the content itself is
 * unchanged (e.g. a theme switch). Empty content resets to the idle state.
 */
export function useDebouncedRender(
  content: string,
  renderFn: (content: string) => Promise<string>,
  delay = 300,
  renderKey?: unknown,
): DebouncedRenderResult {
  const [result, setResult] = useState<DebouncedRenderResult>(IDLE);

  // Always call the freshest renderFn without making it an effect dependency.
  const renderFnRef = useRef(renderFn);
  renderFnRef.current = renderFn;

  const tokenRef = useRef(0);

  useEffect(() => {
    if (content.trim() === "") {
      tokenRef.current += 1;
      setResult(IDLE);
      return;
    }

    const token = (tokenRef.current += 1);
    setResult((prev) => ({ ...prev, isLoading: true, error: null }));

    const timer = setTimeout(() => {
      renderFnRef.current(content).then(
        (html) => {
          if (tokenRef.current === token) {
            setResult({ html, error: null, isLoading: false });
          }
        },
        (err: unknown) => {
          if (tokenRef.current === token) {
            const message = err instanceof Error ? err.message : String(err);
            setResult({ html: "", error: message, isLoading: false });
          }
        },
      );
    }, delay);

    return () => {
      clearTimeout(timer);
      // Invalidate this run so a late-resolving promise (including across an
      // unmount) cannot commit stale output.
      tokenRef.current += 1;
    };
  }, [content, renderKey, delay]);

  return result;
}
