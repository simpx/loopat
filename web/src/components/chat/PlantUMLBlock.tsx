"use client";

import { type SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import { deflateRaw } from "pako";
import { CodeIcon, EyeIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { sanitizeSvg } from "@/lib/sanitizeSvg";
import { useDebouncedRender } from "@/lib/useDebouncedRender";

// PRIVACY: the diagram source is deflated and sent to a PlantUML server to be
// rendered into SVG — nothing is rendered locally, so the text of every
// ```plantuml block leaves the browser. The endpoint defaults to the public
// server but can be pointed at a self-hosted instance via the
// VITE_PLANTUML_SERVER build-time env var. The rendered card names the host
// it talked to so the destination is never hidden from the user.
const PLANTUML_SERVER = (
  (import.meta as { env?: Record<string, string | undefined> }).env
    ?.VITE_PLANTUML_SERVER || "https://www.plantuml.com/plantuml"
).replace(/\/+$/, "");

function serverHost(): string {
  try {
    return new URL(PLANTUML_SERVER).host;
  } catch {
    return PLANTUML_SERVER;
  }
}

// PlantUML's own 6-bit alphabet — deliberately not standard base64.
const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

/** Encode deflated bytes using PlantUML's 3-byte → 4-char transform. */
function encodePlantUml(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i];
    const b2 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b3 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += ALPHABET[(b1 >> 2) & 0x3f];
    out += ALPHABET[(((b1 & 0x3) << 4) | (b2 >> 4)) & 0x3f];
    out += ALPHABET[(((b2 & 0xf) << 2) | (b3 >> 6)) & 0x3f];
    out += ALPHABET[b3 & 0x3f];
  }
  return out;
}

async function fetchDiagram(source: string): Promise<string> {
  // PlantUML's server inflates with a raw (header-less) DEFLATE stream, so we
  // compress with deflateRaw rather than the zlib-wrapped deflate.
  const encoded = encodePlantUml(deflateRaw(source, { level: 9 }));
  let response: Response;
  try {
    response = await fetch(`${PLANTUML_SERVER}/svg/${encoded}`);
  } catch {
    throw new Error("Could not reach the PlantUML server");
  }
  if (!response.ok) {
    if (response.status >= 500) throw new Error("PlantUML server error");
    if (response.status >= 400) throw new Error("PlantUML syntax error");
    throw new Error("PlantUML request failed");
  }
  return sanitizeSvg(await response.text());
}

const headerButton =
  "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-gray-400 transition-colors hover:bg-gray-700 hover:text-gray-200";

export const PlantUMLBlock = ({ code }: SyntaxHighlighterProps) => {
  const [showSource, setShowSource] = useState(false);
  const { html, error, isLoading } = useDebouncedRender(code, fetchDiagram, 300);
  const sourceVisible = showSource || error !== null;

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-gray-700 bg-gray-900">
      <div
        data-copy-ignore
        className="flex select-none items-center justify-between gap-2 border-gray-700 border-b bg-gray-800 px-3 py-1.5 text-xs"
      >
        <span className="font-medium text-gray-400 lowercase">plantuml</span>
        <button
          type="button"
          onClick={() => setShowSource((v) => !v)}
          aria-pressed={showSource}
          className={cn(headerButton, showSource && "text-gray-200")}
        >
          {sourceVisible ? (
            <EyeIcon className="h-3 w-3" />
          ) : (
            <CodeIcon className="h-3 w-3" />
          )}
          <span>{sourceVisible ? "Preview" : "Source"}</span>
        </button>
      </div>

      {sourceVisible ? (
        <div>
          {error !== null && (
            <div className="border-red-500/40 border-b bg-red-500/10 px-3 py-1.5 text-[11px] text-red-300">
              {error}
            </div>
          )}
          <pre className="overflow-x-auto p-3 text-gray-200 text-xs leading-relaxed">
            {code}
          </pre>
        </div>
      ) : (
        <div className="p-3">
          {isLoading && !html ? (
            <div className="text-gray-500 text-xs">Rendering diagram…</div>
          ) : (
            <>
              <div
                className="flex justify-center [&>svg]:h-auto [&>svg]:max-w-full"
                dangerouslySetInnerHTML={{ __html: html }}
              />
              <div
                data-copy-ignore
                className="mt-2 select-none text-center text-[10px] text-gray-500"
              >
                Rendered via {serverHost()} — diagram source is sent there
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
