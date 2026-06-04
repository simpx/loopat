import { useCallback, useSyncExternalStore } from "react";

/**
 * The markdown renderer emits a code block's header and its body as sibling
 * fragments with no common React parent, so they cannot share state through
 * props or context. This tiny external store bridges them: the header, the
 * <pre> wrapper and the <code> gutter all look up the same record by the code
 * text itself, so toggling wrap/collapse in one place is observed everywhere.
 */

export interface CodeBlockUi {
  /** User collapsed the block (only meaningful once `tall` is true). */
  collapsed: boolean;
  /** Soft-wrap long lines instead of horizontal scrolling. */
  wrap: boolean;
  /** Measured: the rendered body overflows the collapse threshold. */
  tall: boolean;
}

const INITIAL: CodeBlockUi = { collapsed: true, wrap: false, tall: false };

const records = new Map<string, CodeBlockUi>();
const watchers = new Map<string, Set<() => void>>();

function read(key: string): CodeBlockUi {
  return records.get(key) ?? INITIAL;
}

function write(key: string, patch: Partial<CodeBlockUi>): void {
  const current = records.get(key) ?? INITIAL;
  const updated: CodeBlockUi = { ...current, ...patch };
  if (
    updated.collapsed === current.collapsed &&
    updated.wrap === current.wrap &&
    updated.tall === current.tall
  ) {
    return;
  }
  records.set(key, updated);
  watchers.get(key)?.forEach((notify) => notify());
}

function watch(key: string, notify: () => void): () => void {
  let set = watchers.get(key);
  if (!set) {
    set = new Set();
    watchers.set(key, set);
  }
  set.add(notify);
  return () => {
    set!.delete(notify);
    if (set!.size === 0) {
      // No live consumer for this code text — drop the record so a long
      // streaming session (every token is a fresh key) cannot leak memory.
      watchers.delete(key);
      records.delete(key);
    }
  };
}

export function useCodeBlockUi(key: string): CodeBlockUi {
  const subscribe = useCallback((notify: () => void) => watch(key, notify), [key]);
  const snapshot = useCallback(() => read(key), [key]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function toggleWrap(key: string): void {
  write(key, { wrap: !read(key).wrap });
}

export function toggleCollapsed(key: string): void {
  write(key, { collapsed: !read(key).collapsed });
}

export function setTall(key: string, tall: boolean): void {
  write(key, { tall });
}
