// Pure helpers behind `tokens:gen` and `tokens:check` (WP-04). No file I/O here, so the
// consistency rules can be tested against in-memory copies of design/tokens.{json,css}.

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const isLeaf = (v: unknown): v is JsonObject & { $value: Json } => isObject(v) && "$value" in v;

interface Leaf {
  path: string[];
  value: Json;
}

/** Every token (node with `$value`) in document order. `$`-prefixed keys are metadata. */
function leaves(node: Json, path: string[] = []): Leaf[] {
  if (isLeaf(node)) return [{ path, value: node.$value }];
  if (!isObject(node)) return [];
  return Object.entries(node)
    .filter(([key]) => !key.startsWith("$"))
    .flatMap(([key, child]) => leaves(child, [...path, key]));
}

const kebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const camel = (s: string): string => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const cssVarRef = (name: string): string => `var(${name})`;

/** JSON tokens with no CSS custom property (RN-only icon sizes; breakpoints can't be variables). */
const JSON_ONLY = new Set([
  "size.iconNav",
  "size.iconTab",
  "size.iconInline",
  "size.iconStroke",
  "breakpoint.compact",
  "breakpoint.wide",
]);

/**
 * `--mp-tracking-*` variables derived from typography. Each is defined by the letter spacing of
 * one typography style; every other style with non-zero tracking must match one of them.
 * Standalone tracking values (table headers) live in tokens.json `tracking.*`.
 */
const TRACKING_FROM_STYLE: Record<string, string> = {
  "display-xl": "display-xl",
  heading: "heading-1",
  overline: "overline",
  nano: "nano",
};

/** Overrides tokens.css must declare under `@media (prefers-reduced-motion: reduce)` (§2.5). */
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const REDUCED_MOTION: Record<string, string> = { "--mp-duration": "0ms" };

function fontFamilyName(ref: Json): string | undefined {
  const match = typeof ref === "string" ? /^\{font\.family\.([\w-]+)\}$/.exec(ref) : null;
  return match?.[1];
}

function resolveFontFamily(json: JsonObject, ref: Json): Json {
  const name = fontFamilyName(ref);
  const font = json.font;
  const family = isObject(font) && isObject(font.family) && name ? font.family[name] : undefined;
  return isLeaf(family) ? family.$value : ref;
}

const asText = (v: Json): string => (Array.isArray(v) ? v.join(", ") : String(v));

type Mapping = { name: string; value: string } | "json-only" | "unmapped";

function mapToken(path: string[], value: Json): Mapping {
  const key = path.join(".");
  if (JSON_ONLY.has(key)) return "json-only";
  const [group, a, b] = path;
  switch (group) {
    case "color":
      return a && b && path.length === 3
        ? { name: `--mp-${kebab(a)}-${kebab(b)}`, value: asText(value) }
        : "unmapped";
    case "font":
      return a === "family" && b && path.length === 3
        ? { name: `--mp-font-${b}`, value: asText(value) }
        : "unmapped";
    case "typography": {
      if (!a || path.length !== 2 || !isObject(value)) return "unmapped";
      const family = fontFamilyName(value.fontFamily ?? null);
      const font = `${asText(value.fontWeight ?? "")} ${asText(value.fontSize ?? "")}/${asText(value.lineHeight ?? "")}`;
      return { name: `--mp-type-${a}`, value: `${font} var(--mp-font-${family ?? "?"})` };
    }
    case "space":
    case "radius":
    case "shadow":
      return a && path.length === 2 ? { name: `--mp-${group}-${a}`, value: asText(value) } : "unmapped";
    case "size":
      if (!a || path.length !== 2) return "unmapped";
      if (a === "focusRing")
        return { name: "--mp-focus-ring", value: `${asText(value)} solid var(--mp-brand-default)` };
      return { name: `--mp-${kebab(a)}`, value: asText(value) };
    case "tracking":
      return a && path.length === 2
        ? { name: `--mp-tracking-${kebab(a)}`, value: asText(value) }
        : "unmapped";
    case "motion":
      if (a === "duration" && path.length === 2) return { name: "--mp-duration", value: asText(value) };
      if (a === "easing" && path.length === 2)
        return { name: "--mp-easing", value: `cubic-bezier(${asText(value)})` };
      return "unmapped";
    default:
      return "unmapped";
  }
}

function typographyStyles(json: JsonObject): [string, JsonObject][] {
  const typography = json.typography;
  if (!isObject(typography)) return [];
  return Object.entries(typography).flatMap(([name, node]) =>
    isLeaf(node) && isObject(node.$value) ? [[name, node.$value] as [string, JsonObject]] : [],
  );
}

function trackingVars(json: JsonObject): Map<string, string> {
  const styles = new Map(typographyStyles(json));
  const out = new Map<string, string>();
  for (const [suffix, style] of Object.entries(TRACKING_FROM_STYLE)) {
    const spacing = styles.get(style)?.letterSpacing;
    out.set(`--mp-tracking-${suffix}`, spacing === undefined ? "?" : asText(spacing));
  }
  return out;
}

/** The tracking variable for a style's letter spacing, preferring the one the style defines. */
function trackingVarFor(json: JsonObject, styleName: string, spacing: string): string | undefined {
  const tracking = trackingVars(json);
  const own = Object.entries(TRACKING_FROM_STYLE).find(([, style]) => style === styleName)?.[0];
  if (own && tracking.get(`--mp-tracking-${own}`) === spacing) return `--mp-tracking-${own}`;
  return [...tracking].find(([, value]) => value === spacing)?.[0];
}

/** The CSS custom properties tokens.css must define, derived from tokens.json. */
export function expectedCssVars(json: unknown): Map<string, string> {
  const vars = new Map<string, string>();
  if (!isObject(json)) return vars;
  for (const [name, value] of trackingVars(json)) vars.set(name, value);
  for (const leaf of leaves(json)) {
    const mapped = mapToken(leaf.path, leaf.value);
    if (typeof mapped === "object") vars.set(mapped.name, mapped.value);
  }
  return vars;
}

const normalize = (v: string): string =>
  v
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*([,()/])\s*/g, "$1")
    .toLowerCase();

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  prelude: string;
  body: string;
}

/** Top-level rules (`prelude { body }`) of a comment-free stylesheet fragment. */
function topLevelRules(text: string): Rule[] {
  const rules: Rule[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open === -1) break;
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
      j++;
    }
    rules.push({ prelude: text.slice(i, open).trim(), body: text.slice(open + 1, j - 1) });
    i = j;
  }
  return rules;
}

function rootVarsIn(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const rule of topLevelRules(text)) {
    if (rule.prelude !== ":root") continue;
    for (const decl of rule.body.split(";")) {
      const colon = decl.indexOf(":");
      const name = decl.slice(0, colon).trim();
      if (colon > 0 && name.startsWith("--")) vars.set(name, decl.slice(colon + 1).trim());
    }
  }
  return vars;
}

/** Custom properties declared in top-level `:root` rules (not inside @media or other at-rules). */
export function parseRootVars(css: string): Map<string, string> {
  return rootVarsIn(stripComments(css));
}

/** Custom properties declared in `:root` inside `@media <query>` (whitespace-insensitive). */
export function parseMediaRootVars(css: string, query: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const rule of topLevelRules(stripComments(css))) {
    if (normalize(rule.prelude) !== normalize(`@media ${query}`)) continue;
    for (const [name, value] of rootVarsIn(rule.body)) vars.set(name, value);
  }
  return vars;
}

/** Problems that make tokens.css diverge from tokens.json. Empty means consistent. */
export function checkTokens(json: unknown, css: string): string[] {
  const problems: string[] = [];
  if (!isObject(json)) return ["tokens.json is not an object"];

  for (const leaf of leaves(json)) {
    if (mapToken(leaf.path, leaf.value) === "unmapped") {
      problems.push(`${leaf.path.join(".")}: no CSS mapping rule for this tokens.json token`);
    }
  }
  for (const [name, style] of typographyStyles(json)) {
    const spacing = asText(style.letterSpacing ?? "0");
    if (normalize(spacing) !== "0" && !trackingVarFor(json, name, spacing)) {
      problems.push(`typography.${name}: letter spacing ${spacing} has no --mp-tracking-* variable`);
    }
  }

  const expected = expectedCssVars(json);
  const actual = parseRootVars(css);
  for (const [name, value] of expected) {
    const got = actual.get(name);
    if (got === undefined) problems.push(`${name}: missing from tokens.css (tokens.json has "${value}")`);
    else if (normalize(got) !== normalize(value)) {
      problems.push(`${name}: tokens.json has "${value}" but tokens.css has "${got}"`);
    }
  }
  for (const name of actual.keys()) {
    if (!expected.has(name)) problems.push(`${name}: in tokens.css but not in tokens.json`);
  }
  for (const leaf of leaves(json)) {
    const mapped = mapToken(leaf.path, leaf.value);
    const derived = typeof mapped === "object" ? trackingVars(json).get(mapped.name) : undefined;
    if (
      typeof mapped === "object" &&
      derived !== undefined &&
      normalize(derived) !== normalize(mapped.value)
    ) {
      problems.push(
        `${leaf.path.join(".")}: conflicts with ${mapped.name} derived from typography (${derived})`,
      );
    }
  }

  // Reduced motion (DESIGN_SPEC §2.5): no motion when prefers-reduced-motion is set.
  const reduced = parseMediaRootVars(css, REDUCED_MOTION_QUERY);
  for (const [name, value] of Object.entries(REDUCED_MOTION)) {
    const got = reduced.get(name);
    if (got === undefined || normalize(got) !== normalize(value)) {
      problems.push(
        `reduced motion: tokens.css must set ${name}: ${value} in @media ${REDUCED_MOTION_QUERY} (found ${got ?? "nothing"})`,
      );
    }
  }

  // Breakpoints live in a tokens.css comment because media queries can't read variables.
  const breakpoint = isObject(json.breakpoint) ? json.breakpoint : {};
  const px = (key: string): number => {
    const node = breakpoint[key];
    return isLeaf(node) ? Number.parseInt(asText(node.$value), 10) : Number.NaN;
  };
  const expectComment = [
    ["compact", `compact: max-width ${px("compact") - 1}px`],
    ["wide", `wide: min-width ${px("wide")}px`],
  ] as const;
  for (const [key, phrase] of expectComment) {
    if (!new RegExp(`${phrase.replace(/ /g, "\\s+")}\\b`).test(css)) {
      problems.push(`breakpoint.${key}: tokens.css comment should say "${phrase}"`);
    }
  }
  return problems;
}

/** Raw token values with metadata stripped and font-family references resolved. */
function valuesOf(json: JsonObject, node: Json, path: string[] = []): Json {
  if (isLeaf(node)) {
    if (path[0] === "typography" && isObject(node.$value)) {
      return { ...node.$value, fontFamily: resolveFontFamily(json, node.$value.fontFamily ?? null) };
    }
    return node.$value;
  }
  if (!isObject(node)) return node;
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(node)) {
    if (!key.startsWith("$")) out[key] = valuesOf(json, child, [...path, key]);
  }
  return out;
}

/** `var(--mp-…)` references, same shape as the values, for tokens that have a CSS variable. */
function varsOf(json: JsonObject, node: Json, path: string[] = []): Json | undefined {
  if (isLeaf(node)) {
    const mapped = mapToken(path, node.$value);
    if (typeof mapped !== "object") return undefined;
    if (path[0] === "typography" && path[1] && isObject(node.$value)) {
      const spacing = asText(node.$value.letterSpacing ?? "0");
      const tracking = normalize(spacing) === "0" ? undefined : trackingVarFor(json, path[1], spacing);
      return { font: cssVarRef(mapped.name), letterSpacing: tracking ? cssVarRef(tracking) : "0" };
    }
    return cssVarRef(mapped.name);
  }
  if (!isObject(node)) return undefined;
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith("$")) continue;
    const value = varsOf(json, child, [...path, key]);
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const identifier = /^[A-Za-z_$][\w$]*$/;

function serialize(value: Json, indent = 0): string {
  if (Array.isArray(value)) return `[${value.map((v) => serialize(v, indent)).join(", ")}]`;
  if (isObject(value)) {
    const pad = "  ".repeat(indent + 1);
    const lines = Object.entries(value).map(
      ([key, v]) => `${pad}${identifier.test(key) ? key : JSON.stringify(key)}: ${serialize(v, indent + 1)},`,
    );
    return `{\n${lines.join("\n")}\n${"  ".repeat(indent)}}`;
  }
  return JSON.stringify(value);
}

/** Source of tokens.generated.ts. */
export function renderTokensModule(json: unknown): string {
  if (!isObject(json)) throw new TypeError("tokens.json is not an object");
  const values = valuesOf(json, json);
  const refs = varsOf(json, json);
  const vars: JsonObject = isObject(refs) ? { ...refs } : {};
  const derivedTracking = Object.fromEntries(
    [...trackingVars(json).keys()].map((name) => [
      camel(name.slice("--mp-tracking-".length)),
      cssVarRef(name),
    ]),
  );
  vars.tracking = { ...derivedTracking, ...(isObject(vars.tracking) ? vars.tracking : {}) };
  return [
    "// GENERATED from design/tokens.json by `pnpm --filter @mp/ui tokens:gen`. Do not edit by hand.",
    "// `pnpm --filter @mp/ui tokens:check` verifies design/tokens.css matches design/tokens.json.",
    "",
    "/** Raw token values (React Native, charts, anything that can't read CSS variables). */",
    "// prettier-ignore",
    `export const tokens = ${serialize(values)} as const;`,
    "",
    "/**",
    " * `var(--mp-…)` references into design/tokens.css, for web styles.",
    " * Note: `cssVar.size.focusRing` is the full outline shorthand (`2px solid` brand.default),",
    " * while `tokens.size.focusRing` is only the ring width (`2px`).",
    " */",
    "// prettier-ignore",
    `export const cssVar = ${serialize(vars)} as const;`,
    "",
    "export type Tokens = typeof tokens;",
    "export type CssVar = typeof cssVar;",
    "",
  ].join("\n");
}
