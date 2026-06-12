import { useCallback, useState } from "react";
import { writePlainTextClipboard } from "./clipboard";

export function useClipboard(duration = 1500) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async (text: string) => {
    if (!text || copied) return false;
    try {
      await writePlainTextClipboard(text);
      setCopied(true);
      setTimeout(() => setCopied(false), duration);
      return true;
    } catch {
      return false;
    }
  }, [copied, duration]);

  return {
    copied,
    isCopied: copied,
    copy,
    copyToClipboard: copy,
  };
}
