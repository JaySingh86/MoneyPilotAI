/**
 * Path without the query string or fragment. Request URLs are logged and echoed in problem bodies this way
 * because query strings carry OAuth `code` and `state` (and could carry other user input).
 */
export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}
