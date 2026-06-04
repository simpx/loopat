/**
 * Normalises LaTeX-style math delimiters into the dollar syntax that
 * remark-math understands:
 *
 *   \( … \)  →  $ … $
 *   \[ … \]  →  $$ … $$
 *
 * The transform is intentionally conservative. It never touches delimiters
 * that live inside code (fenced or inline) or markdown links, it respects
 * backslash escaping, and it only rewrites a pair once a balanced closing
 * delimiter has actually been found. Anything ambiguous is left verbatim.
 */

type Span = [start: number, end: number];

// Cheap pre-flight check: is there even a `\(` or `\[` anywhere?
const DELIMITER_HINT = /\\[([]/;

function mergeSpans(spans: Span[]): Span[] {
  if (spans.length < 2) return spans;
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Span[] = [spans[0]];
  for (let idx = 1; idx < spans.length; idx++) {
    const tail = merged[merged.length - 1];
    const span = spans[idx];
    if (span[0] <= tail[1]) {
      if (span[1] > tail[1]) tail[1] = span[1];
    } else {
      merged.push(span);
    }
  }
  return merged;
}

/**
 * Collect every region whose contents must be shielded from substitution:
 * fenced code blocks, inline code spans and markdown link/image syntax.
 */
function findShieldedSpans(text: string): Span[] {
  const spans: Span[] = [];
  const matchers = [
    /```[\s\S]*?```/g, // fenced code (backticks)
    /~~~[\s\S]*?~~~/g, // fenced code (tildes)
    /`+[^`\n]*`+/g, // inline code
    /!?\[[^\]]*\]\([^)]*\)/g, // [text](url) and ![alt](url)
  ];
  for (const matcher of matchers) {
    let hit: RegExpExecArray | null;
    while ((hit = matcher.exec(text)) !== null) {
      spans.push([hit.index, hit.index + hit[0].length]);
    }
  }
  return mergeSpans(spans);
}

function isShielded(pos: number, spans: Span[]): boolean {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = spans[mid];
    if (pos < start) hi = mid - 1;
    else if (pos >= end) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * A delimiter backslash is "live" only when the run of backslashes that ends
 * at it has odd length — i.e. an even number of backslashes precedes it, so
 * the backslash itself is not escaped away.
 */
function isLiveDelimiter(text: string, pos: number): boolean {
  let run = 0;
  for (let k = pos - 1; k >= 0 && text[k] === "\\"; k--) run++;
  return run % 2 === 0;
}

/**
 * Walk forward from an opening delimiter looking for its balanced partner,
 * honouring nesting, escaping and shielded regions. Returns the index of the
 * closing backslash, or -1 when the pair never closes.
 */
function findClosingDelimiter(
  text: string,
  openAt: number,
  open: "(" | "[",
  spans: Span[],
): number {
  const close = open === "(" ? ")" : "]";
  let depth = 1;
  for (let j = openAt + 2; j < text.length; j++) {
    if (isShielded(j, spans)) continue;
    if (text[j] !== "\\" || !isLiveDelimiter(text, j)) continue;
    const following = text[j + 1];
    if (following === open) {
      depth++;
    } else if (following === close) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

export function processLatexBrackets(text: string): string {
  if (!DELIMITER_HINT.test(text)) return text;

  const spans = findShieldedSpans(text);
  let result = "";
  let i = 0;

  while (i < text.length) {
    if (isShielded(i, spans)) {
      const from = i;
      while (i < text.length && isShielded(i, spans)) i++;
      result += text.slice(from, i);
      continue;
    }

    const char = text[i];
    const next = text[i + 1];
    if (
      char === "\\" &&
      (next === "(" || next === "[") &&
      isLiveDelimiter(text, i)
    ) {
      const open = next as "(" | "[";
      const closeAt = findClosingDelimiter(text, i, open, spans);
      if (closeAt !== -1) {
        const inner = text.slice(i + 2, closeAt);
        result += open === "(" ? `$${inner}$` : `$$${inner}$$`;
        i = closeAt + 2;
        continue;
      }
    }

    result += char;
    i++;
  }

  return result;
}
