// Email theme (Q-136): inline-style values read from design/tokens.json at module load. Email clients can't use
// CSS variables, so the templates take their colors and type from here; no value is written by hand in this
// package (hard rule 6). A missing token throws at module load with the token's name.
// A static JSON import, so bundlers inline the tokens and nothing is read from disk at runtime.
import tokensJson from "../../../design/tokens.json" with { type: "json" };

interface Leaf {
  $value: unknown;
}
type Tree = { [key: string]: Tree | Leaf };

const tokens = tokensJson as unknown as Record<string, Tree>;

function leaf(path: string): unknown {
  let node: Tree | Leaf | undefined = tokens as Tree;
  for (const part of path.split(".")) {
    node = node && !("$value" in node) ? node[part] : undefined;
  }
  if (!node || !("$value" in node)) throw new Error(`design token not found: ${path}`);
  return node.$value;
}

function str(path: string): string {
  const v = leaf(path);
  if (typeof v !== "string") throw new Error(`design token is not a string: ${path}`);
  return v;
}

/** Resolves `{font.family.body}` style references and joins a font stack. */
function fontStack(ref: string): string {
  const path = ref.replace(/^\{|\}$/g, "");
  const v = leaf(path);
  if (!Array.isArray(v)) throw new Error(`design token is not a font stack: ${path}`);
  return v.map((f) => (/\s/.test(String(f)) ? `'${String(f)}'` : String(f))).join(",");
}

interface Type {
  fontFamily: string;
  fontWeight: number;
  fontSize: string;
  lineHeight: string;
}

function type(name: string): string {
  const v = leaf(`typography.${name}`) as Type;
  return `font-family:${fontStack(v.fontFamily)};font-weight:${v.fontWeight};font-size:${v.fontSize};line-height:${v.lineHeight}`;
}

export const emailTheme = {
  pageBg: str("color.bg.canvas"),
  cardBg: str("color.bg.surface"),
  border: str("color.border.default"),
  text: str("color.text.primary"),
  textMuted: str("color.text.muted"),
  brand: str("color.brand.default"),
  onBrand: str("color.text.inverse"),
  radius: str("radius.lg"),
  maxWidth: str("size.emailMaxWidth"),
  space: { sm: str("space.2"), md: str("space.4"), lg: str("space.6") },
  body: type("body-l"),
  heading: type("heading-3"),
  small: type("small"),
  button: type("title"),
} as const;
