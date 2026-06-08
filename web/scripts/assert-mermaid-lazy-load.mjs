import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

const mermaidBlock = read("src/components/chat/MermaidBlock.tsx");
const markdownBlock = read("src/components/chat/MarkdownBlock.tsx");
const assistantMarkdown = read("src/components/assistant-ui/markdown-text.tsx");

const failures = [];

if (/import\s+(?:[^"']+\s+from\s+)?["']mermaid["']/.test(mermaidBlock)) {
  failures.push("MermaidBlock.tsx must not statically import mermaid.");
}

if (!/import\s*\(\s*["']mermaid["']\s*\)/.test(mermaidBlock)) {
  failures.push("MermaidBlock.tsx must lazy-load mermaid with import('mermaid').");
}

if (!/mermaid(?:Promise|Loading|Module|Instance)/.test(mermaidBlock)) {
  failures.push("MermaidBlock.tsx should cache the lazy mermaid load at module scope.");
}

const sharedImportPattern =
  /import\s+\{\s*createMarkdownLanguageComponents\s*\}\s+from\s+["'][^"']*markdownLanguageComponents["']/;

if (!sharedImportPattern.test(markdownBlock)) {
  failures.push("MarkdownBlock.tsx must import shared createMarkdownLanguageComponents.");
}

if (!sharedImportPattern.test(assistantMarkdown)) {
  failures.push("assistant-ui/markdown-text.tsx must import shared createMarkdownLanguageComponents.");
}

if (!/createMarkdownLanguageComponents\(CodeHeader\)/.test(markdownBlock)) {
  failures.push("MarkdownBlock.tsx must create language components from the shared factory.");
}

if (!/createMarkdownLanguageComponents\(CodeHeader\)/.test(assistantMarkdown)) {
  failures.push("assistant-ui/markdown-text.tsx must create language components from the shared factory.");
}

if (!/componentsByLanguage=\{markdownLanguageComponents\}/.test(markdownBlock)) {
  failures.push("MarkdownBlock.tsx must use shared markdownLanguageComponents.");
}

if (!/componentsByLanguage=\{markdownLanguageComponents\}/.test(assistantMarkdown)) {
  failures.push("assistant-ui/markdown-text.tsx must use shared markdownLanguageComponents.");
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log("Mermaid lazy-load and markdown language registration inspection passed.");
