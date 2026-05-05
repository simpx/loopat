/**
 * Tiny icon helper. Maps a name to a unicode glyph.
 * Replaces opencode's @opencode-ai/ui Icon component for the POC.
 */
const GLYPHS: Record<string, string> = {
  enter: "+",
  "close-small": "×",
  folder: "▸",
  "chevron-down": "▾",
  "chevron-right": "▸",
  "file-tree": "▤",
  archive: "▦",
  "magnifying-glass": "⌕",
  fork: "⑂",
  terminal: "▷_",
  prompt: "›",
  brain: "✦",
}

export function Icon(props: { name: string; class?: string }) {
  const ch = GLYPHS[props.name] ?? "•"
  return <span class={`inline-block leading-none ${props.class ?? ""}`}>{ch}</span>
}
