import copy from "copy-to-clipboard"

/**
 * Single clipboard entry point for the web app.
 *
 * Previously copy was open-coded everywhere: ~10 sites called
 * `navigator.clipboard.writeText` with no fallback (silently broken over
 * http://<ip>, a non-secure context where `navigator.clipboard` is
 * undefined), plus two components carried their own duplicated
 * textarea+execCommand fallback. This centralizes both.
 *
 * `copy-to-clipboard` works in non-secure contexts: it copies via a hidden
 * element + synchronous `execCommand("copy")`, so it does not depend on the
 * async Clipboard API or a secure origin.
 */

/** Copy plain text. Synchronous; returns whether the copy succeeded. */
export function copyText(text: string): boolean {
  if (!text) return false
  try {
    return copy(text)
  } catch {
    return false
  }
}

/**
 * Copy rich content: registers both `text/html` and `text/plain` so pasting
 * into a rich target keeps formatting while plain targets get the text.
 * Falls back to plain-text {@link copyText} when `ClipboardItem` / the async
 * Clipboard API is unavailable (older browsers, non-secure contexts).
 */
export async function copyRich({ text, html }: { text: string; html: string }): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ])
      return true
    }
  } catch {
    // Clipboard write can be denied / unsupported — fall back to plain text.
  }
  return copyText(text)
}
