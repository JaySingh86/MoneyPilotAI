// A tiny CSS reader for the style conformance tests (no at-rule nesting beyond one level, which
// is all the component CSS modules use).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CssRule {
  file: string;
  selectors: string[];
  declarations: Array<{ prop: string; value: string }>;
}

export const componentsRoot = fileURLToPath(new URL("..", import.meta.url));

export function cssModuleFiles(dir: string = componentsRoot): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssModuleFiles(path);
    return entry.name.endsWith(".module.css") ? [path] : [];
  });
}

export function parseRules(file: string): CssRule[] {
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of css.matchAll(re)) {
    const selectors = (match[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("@"));
    if (selectors.length === 0) continue;
    const declarations = (match[2] ?? "")
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const i = d.indexOf(":");
        return { prop: d.slice(0, i).trim(), value: d.slice(i + 1).trim() };
      });
    rules.push({ file: file.slice(componentsRoot.length), selectors, declarations });
  }
  return rules;
}
