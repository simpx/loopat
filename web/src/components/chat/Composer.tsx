import { useEffect, useRef, useState } from "react";
import {
  ComposerPrimitive,
  AuiIf,
  useAuiState,
  useAui,
} from "@assistant-ui/react";
import {
  ArrowUpIcon,
  SquareIcon,
  ListOrderedIcon,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import ClaudeStatus from "./ClaudeStatus";

import PlanModeToggle from "./PlanModeToggle";
import ModelSelector from "./ModelSelector";
import PluginsButton from "./PluginsButton";
import SlashCommand from "./SlashCommand";
import TokenUsagePie from "./TokenUsagePie";
import { useLoopRuntimeExtra, type ImageInput } from "@/useLoopRuntime";
import { getChatHistory, appendChatHistory } from "@/api";

const FALLBACK_CONTEXT_WINDOW = 200_000;
const MAX_HISTORY = 500;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB per image — Anthropic's documented limit
const ALLOWED_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

interface PendingImage extends ImageInput {
  /** Object URL for thumbnail preview (revoked on remove / send). */
  previewUrl: string;
  /** Stable key for React list rendering. */
  key: string;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("unexpected reader result"));
        return;
      }
      // result format: "data:<mime>;base64,<data>"
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

let pendingImageCounter = 0;

export default function Composer() {
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const hasInput = useAuiState(
    (s) => typeof s.composer.text === "string" && s.composer.text.trim().length > 0,
  );
  const composerText = useAuiState((s) => s.composer.text);

  const { provider, permissionMode, setPermissionMode, enqueueMessage, queue, clearQueue, removeFromQueue, loopId, contextTokens, cumulativeTokens, getStreamingTokenCount, getWaitingForResponse, suppressSlashRef } = useLoopRuntimeExtra();
  const contextWindow = provider?.contextWindow ?? FALLBACK_CONTEXT_WINDOW;

  const aui = useAui();

  // ── pending pasted images ──
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const pendingImagesRef = useRef<PendingImage[]>([]);
  pendingImagesRef.current = pendingImages;

  useEffect(() => {
    // Revoke any object URLs still alive on unmount (e.g. unsent paste).
    return () => {
      for (const img of pendingImagesRef.current) URL.revokeObjectURL(img.previewUrl);
    };
  }, []);

  const removePendingImage = (key: string) => {
    setPendingImages((prev) => {
      const target = prev.find((p) => p.key === key);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.key !== key);
    });
  };

  const consumePendingImages = (): ImageInput[] => {
    const snapshot = pendingImages;
    if (snapshot.length === 0) return [];
    setPendingImages([]);
    // Strip preview-only fields before sending.
    return snapshot.map((p) => ({
      mediaType: p.mediaType,
      data: p.data,
      ...(p.filename ? { filename: p.filename } : {}),
    }));
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;

    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind !== "file") continue;
      if (!ALLOWED_IMAGE_TYPES.has(it.type)) continue;
      const f = it.getAsFile();
      if (f) files.push(f);
    }
    if (files.length === 0) return;

    // We're going to handle these images; don't also paste their text/URL repr.
    e.preventDefault();
    setPasteError(null);

    const next: PendingImage[] = [];
    for (const file of files) {
      if (file.size > MAX_IMAGE_BYTES) {
        setPasteError(
          `Image is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB > 10 MB).`,
        );
        continue;
      }
      try {
        const base64 = await readFileAsBase64(file);
        const previewUrl = URL.createObjectURL(file);
        pendingImageCounter += 1;
        next.push({
          mediaType: file.type as ImageInput["mediaType"],
          data: base64,
          filename: file.name || undefined,
          previewUrl,
          key: `paste-${Date.now()}-${pendingImageCounter}`,
        });
      } catch (err) {
        console.error("[composer:paste] read failed", err);
        setPasteError("Failed to read pasted image.");
      }
    }
    if (next.length > 0) setPendingImages((prev) => [...prev, ...next]);
  };

  // ── chat history ──
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const pendingDraftRef = useRef("");
  const textRef = useRef("");
  textRef.current = typeof composerText === "string" ? composerText : "";

  useEffect(() => {
    if (!loopId) return;
    getChatHistory(loopId).then((entries) => {
      setHistory(entries);
      setHistoryIdx(-1);
    });
  }, [loopId]);

  const saveToHistory = (text: string) => {
    if (!text.trim() || !loopId) return;
    const trimmed = text.trim();
    setHistory((prev) => {
      if (prev[prev.length - 1] === trimmed) return prev;
      const next = [...prev, trimmed];
      if (next.length > MAX_HISTORY) next.splice(0, next.length - MAX_HISTORY);
      return next;
    });
    setHistoryIdx(-1);
    appendChatHistory(loopId, trimmed).catch(() => {});
  };

  /** Unified send handler — used for both initial send and enqueue. The
   *  server treats every message identically: if a turn is in flight it
   *  goes onto the queue, otherwise it kicks off a new run. */
  const handleSend = () => {
    const text = typeof composerText === "string" ? composerText.trim() : "";
    const images = consumePendingImages();
    if (!text && images.length === 0) return;
    if (text) saveToHistory(text);
    enqueueMessage(text, images.length > 0 ? images : undefined);
    aui.composer().setText("");
    setPasteError(null);
  };

  const handleSubmit = () => {
    const text = textRef.current.trim();
    if (text) saveToHistory(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Ignore Enter during IME composition (e.g. Chinese input method
    // confirmation) to avoid prematurely sending unfinished text.
    if ((e.nativeEvent as any).isComposing || e.keyCode === 229) {
      return;
    }
    // Ctrl+C clears the input (macOS / Linux only; conflicts with copy on Windows).
    if (
      e.key === "c" &&
      e.ctrlKey &&
      !e.altKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !/windows/i.test(navigator.userAgent)
    ) {
      const ta = e.target as HTMLTextAreaElement
      if (ta.selectionStart === ta.selectionEnd && textRef.current.trim().length > 0) {
        e.preventDefault()
        aui.composer().setText("")
        return
      }
    }
    // Reset slash-suppression on any printable keystroke so the / menu
    // reappears once the user actually starts typing again.
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") {
      suppressSlashRef.current = false;
    }
    // Send / enqueue on Enter — covers both pending images (which need our
    // own handler) and plain text. ComposerPrimitive.Send still works for
    // mouse clicks on the text-only path.
    if (e.key === "Enter" && !e.shiftKey) {
      const hasPending = pendingImagesRef.current.length > 0;
      if (isRunning || hasPending) {
        e.preventDefault();
        handleSend();
        return;
      }
    }
    if (e.key === "ArrowUp" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      if (history.length === 0) return;
      e.preventDefault();
      suppressSlashRef.current = true;
      if (historyIdx === -1) {
        pendingDraftRef.current = textRef.current;
        setHistoryIdx(history.length - 1);
        aui.composer().setText(history[history.length - 1]);
      } else if (historyIdx > 0) {
        const nextIdx = historyIdx - 1;
        setHistoryIdx(nextIdx);
        aui.composer().setText(history[nextIdx]);
      }
      return;
    }
    if (e.key === "ArrowDown" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      if (historyIdx === -1) return;
      e.preventDefault();
      suppressSlashRef.current = true;
      if (historyIdx < history.length - 1) {
        const nextIdx = historyIdx + 1;
        setHistoryIdx(nextIdx);
        aui.composer().setText(history[nextIdx]);
      } else {
        setHistoryIdx(-1);
        aui.composer().setText(pendingDraftRef.current);
      }
      return;
    }
  };

  const hasPendingImages = pendingImages.length > 0;
  const showSendButton = hasInput || hasPendingImages;

  return (
    <ComposerPrimitive.Root className="relative flex w-full flex-col" onSubmit={handleSubmit}>
      {/* Claude Status bar */}
      <ClaudeStatus isLoading={isRunning} getTokenCount={getStreamingTokenCount} getWaitingForResponse={getWaitingForResponse} />

      {/* Queue: inline items with per-item remove */}
      {queue.length > 0 && (
        <div className="mb-1.5 space-y-1 px-2">
          {queue.map((msg, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-2 bg-gray-50 border border-gray-200 rounded-md px-2.5 py-1.5"
            >
              <span className="text-xs text-gray-600 line-clamp-3 break-words whitespace-pre-wrap min-w-0">
                <span className="text-gray-400 mr-1.5 shrink-0">{i + 1}.</span>
                {msg}
              </span>
              <button
                onClick={() => removeFromQueue(i)}
                className="text-gray-400 hover:text-gray-600 shrink-0 p-0.5 rounded hover:bg-gray-100 transition-colors"
                title="Remove from queue"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div
        data-slot="composer-shell"
        className="flex w-full flex-col gap-2 rounded-2xl border border-gray-200 bg-white p-2.5 shadow-sm"
      >
        <SlashCommand />

        {/* Pasted-image previews */}
        {hasPendingImages && (
          <div className="flex flex-wrap items-center gap-2 px-1.5">
            {pendingImages.map((img) => (
              <div
                key={img.key}
                className="group relative h-16 w-16 overflow-hidden rounded-md border border-gray-200 bg-gray-50 shadow-sm"
                title={img.filename || "Pasted image"}
              >
                <img
                  src={img.previewUrl}
                  alt={img.filename || "Pasted image"}
                  className="h-full w-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => removePendingImage(img.key)}
                  className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label="Remove image"
                  title="Remove image"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {pasteError && (
          <div className="px-1.5 text-xs text-red-500">{pasteError}</div>
        )}

        <ComposerPrimitive.Input
            placeholder="Send a message..."
            className="max-h-32 min-h-10 w-full resize-none bg-transparent px-1.5 py-1 text-sm text-gray-900 outline-none placeholder:text-gray-400"
            rows={1}
            autoFocus
            aria-label="Message input"
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />

          {/* Toolbar */}
          <div className="flex items-center justify-between gap-0.5 border-t border-gray-100 pt-2 overflow-hidden">
            <div className="flex items-center gap-0.5 min-w-0">
              <TokenUsagePie
                used={Math.min(contextTokens, contextWindow)}
                total={contextWindow}
              />

              <ModelSelector />

              <PluginsButton
                onPick={(slashCommand) => {
                  // Insert at end + a trailing space so user can keep typing args.
                  const current = textRef.current
                  const next = current.length === 0 || current.endsWith(" ")
                    ? `${current}${slashCommand}`
                    : `${current} ${slashCommand}`
                  aui.composer().setText(next)
                }}
              />
            </div>

            <div className="flex items-center gap-1 sm:gap-2 shrink-0">
              <PlanModeToggle
                mode={permissionMode}
                onChange={setPermissionMode}
              />

              {/* Send / Enqueue button */}
              {showSendButton && (
                isRunning ? (
                  <Button
                    type="button"
                    variant="default"
                    size="icon"
                    onClick={handleSend}
                    className="h-8 w-8 rounded-lg bg-amber-500 hover:bg-amber-600 text-white"
                    aria-label="Enqueue message"
                    title="Enqueue message"
                  >
                    <ListOrderedIcon className="h-4 w-4" />
                  </Button>
                ) : hasPendingImages ? (
                  // Pasted images need to ride alongside text — bypass
                  // ComposerPrimitive.Send so the WS payload includes them.
                  <Button
                    type="button"
                    variant="default"
                    size="icon"
                    onClick={handleSend}
                    className="h-8 w-8 rounded-lg bg-gray-800 hover:bg-gray-900 text-white"
                    aria-label="Send message"
                    title="Send message"
                  >
                    <ArrowUpIcon className="h-4 w-4" />
                  </Button>
                ) : (
                  <ComposerPrimitive.Send asChild>
                    <Button
                      type="button"
                      variant="default"
                      size="icon"
                      className="h-8 w-8 rounded-lg bg-gray-800 hover:bg-gray-900 text-white"
                      aria-label="Send message"
                    >
                      <ArrowUpIcon className="h-4 w-4" />
                    </Button>
                  </ComposerPrimitive.Send>
                )
              )}

              {/* Stop button: only visible when running */}
              <AuiIf condition={(s) => s.thread.isRunning}>
                <ComposerPrimitive.Cancel asChild>
                  <Button
                    type="button"
                    variant="default"
                    size="icon"
                    className="h-8 w-8 rounded-lg bg-red-500 hover:bg-red-600 text-white"
                    aria-label="Stop generating"
                  >
                    <SquareIcon className="h-3 w-3 fill-current" />
                  </Button>
                </ComposerPrimitive.Cancel>
              </AuiIf>
            </div>
          </div>
        </div>
    </ComposerPrimitive.Root>
  );
}
