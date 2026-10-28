/** Joins the class names that are non-empty strings; ignores falsy and other values. */
export function cx(...names: unknown[]): string {
  return names.filter((n): n is string => typeof n === "string" && n.length > 0).join(" ");
}
