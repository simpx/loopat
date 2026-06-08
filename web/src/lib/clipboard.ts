export type ClipboardWriteMode = "rich" | "plain";

export function buildClipboardHtml(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("[data-copy-ignore]").forEach((node) => node.remove());
  return clone.innerHTML;
}

function execCommandCopy(text: string): boolean {
  if (typeof document === "undefined" || !document.body) return false;

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "-9999px";
  textarea.style.opacity = "0";

  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

export async function writePlainTextClipboard(text: string): Promise<void> {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;

  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return;
    } catch {
      // Fall back to execCommand for insecure HTTP contexts and denied writes.
    }
  }

  if (!execCommandCopy(text)) {
    throw new Error("Unable to write text to clipboard");
  }
}

export async function writeRichClipboard({
  plainText,
  html,
}: {
  plainText: string;
  html: string;
}): Promise<ClipboardWriteMode> {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;

  if (
    html &&
    typeof ClipboardItem !== "undefined" &&
    clipboard?.write
  ) {
    try {
      await clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([plainText], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return "rich";
    } catch {
      // Fall back to the original markdown/plain text.
    }
  }

  await writePlainTextClipboard(plainText);
  return "plain";
}
