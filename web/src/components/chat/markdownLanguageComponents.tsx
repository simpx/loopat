"use client";

import {
  type CodeHeaderProps,
  type SyntaxHighlighterProps,
} from "@assistant-ui/react-markdown";
import type { ComponentType } from "react";
import { isSvgContent } from "@/lib/sanitizeSvg";
import { GraphvizBlock } from "./GraphvizBlock";
import { HtmlArtifactCard } from "./HtmlArtifactCard";
import { MermaidBlock } from "./MermaidBlock";
import { PlantUMLBlock } from "./PlantUMLBlock";
import { FencedSvg } from "./SvgRenderer";

const NoCodeHeader = () => null;

const SvgFencedBlock = ({ code }: SyntaxHighlighterProps) => (
  <FencedSvg svg={code} />
);

const XmlBlock = ({ code, node, components }: SyntaxHighlighterProps) => {
  if (isSvgContent(code)) return <FencedSvg svg={code} />;
  const { Pre, Code } = components;
  return (
    <Pre>
      <Code node={node}>{code}</Code>
    </Pre>
  );
};

export function createMarkdownLanguageComponents(
  CodeHeader: ComponentType<CodeHeaderProps>,
) {
  const XmlHeader = ({ language, code, node }: CodeHeaderProps) =>
    isSvgContent(code) ? null : (
      <CodeHeader language={language} code={code} node={node} />
    );

  return {
    html: { SyntaxHighlighter: HtmlArtifactCard, CodeHeader: NoCodeHeader },
    svg: { SyntaxHighlighter: SvgFencedBlock, CodeHeader: NoCodeHeader },
    xml: { SyntaxHighlighter: XmlBlock, CodeHeader: XmlHeader },
    mermaid: { SyntaxHighlighter: MermaidBlock, CodeHeader: NoCodeHeader },
    plantuml: { SyntaxHighlighter: PlantUMLBlock, CodeHeader: NoCodeHeader },
    dot: { SyntaxHighlighter: GraphvizBlock, CodeHeader: NoCodeHeader },
    graphviz: { SyntaxHighlighter: GraphvizBlock, CodeHeader: NoCodeHeader },
  };
}
