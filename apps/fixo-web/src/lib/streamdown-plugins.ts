"use client";

import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { useEffect, useMemo, useState } from "react";
import type { DiagramPlugin, MathPlugin, PluginConfig } from "streamdown";

// Heavy plugins (math = KaTeX ~280KB, mermaid = ~1MB+) are loaded only when
// the rendered markdown actually contains the corresponding syntax. cjk/code
// are small and effectively always-on in chat output, so they stay static.

let mathPromise: Promise<MathPlugin> | null = null;
let mermaidPromise: Promise<DiagramPlugin> | null = null;

const loadMath = () => {
  mathPromise ??= import("@streamdown/math").then((m) => m.math);
  return mathPromise;
};

const loadMermaid = () => {
  mermaidPromise ??= import("@streamdown/mermaid").then((m) => m.mermaid);
  return mermaidPromise;
};

const MATH_RE = /\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\\(|\\\[/;
const MERMAID_RE = /```mermaid\s/;

export function useStreamdownPlugins(
  content: string | null | undefined,
): PluginConfig {
  const text = typeof content === "string" ? content : "";
  const needsMath = MATH_RE.test(text);
  const needsMermaid = MERMAID_RE.test(text);

  const [math, setMath] = useState<MathPlugin | null>(null);
  const [mermaid, setMermaid] = useState<DiagramPlugin | null>(null);

  useEffect(() => {
    if (!needsMath || math) return;
    let active = true;
    loadMath().then((p) => {
      if (active) setMath(p);
    });
    return () => {
      active = false;
    };
  }, [needsMath, math]);

  useEffect(() => {
    if (!needsMermaid || mermaid) return;
    let active = true;
    loadMermaid().then((p) => {
      if (active) setMermaid(p);
    });
    return () => {
      active = false;
    };
  }, [needsMermaid, mermaid]);

  return useMemo(
    () => ({
      cjk,
      code,
      ...(math ? { math } : {}),
      ...(mermaid ? { mermaid } : {}),
    }),
    [math, mermaid],
  );
}
