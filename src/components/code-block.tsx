"use client";

import { useEffect, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import type { CSSProperties } from "react";

interface CodeBlockProps {
  content: string;
  language: string;
}

const baseStyle: CSSProperties = {
  margin: 0,
  padding: "1rem",
  background: "#1e1e1e",
  color: "#d4d4d4",
  fontSize: "13px",
  lineHeight: "1.6",
  fontFamily: "var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, monospace",
};

export function CodeBlock({ content, language }: CodeBlockProps) {
  const [theme, setTheme] = useState<Record<string, CSSProperties> | null>(null);

  useEffect(() => {
    import("react-syntax-highlighter/dist/esm/styles/prism").then((mod) => {
      setTheme(mod.vscDarkPlus as Record<string, CSSProperties>);
    });
  }, []);

  if (!theme) {
    return (
      <div
        className="rounded-lg border border-white/10 overflow-auto max-h-[600px]"
        style={{ background: "#1e1e1e" }}
      >
        <pre className="m-0 p-4 text-[13px] leading-relaxed overflow-x-auto" style={baseStyle}>
          <code style={{ color: "#d4d4d4" }}>{content}</code>
        </pre>
      </div>
    );
  }

  return (
    <div
      className="rounded-lg border border-white/10 overflow-auto max-h-[600px] [&_code]:!text-[#d4d4d4] [&_span]:!text-inherit"
      style={{ background: "#1e1e1e" }}
    >
      <SyntaxHighlighter
        language={language}
        style={theme}
        showLineNumbers
        wrapLongLines
        customStyle={baseStyle}
        codeTagProps={{ style: { color: "#d4d4d4", fontFamily: baseStyle.fontFamily } }}
        lineNumberStyle={{ color: "#858585", minWidth: "2.5em" }}
      >
        {content}
      </SyntaxHighlighter>
    </div>
  );
}
