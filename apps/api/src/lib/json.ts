import sjson from "secure-json-parse";

/**
 * JSON.parse that throws on `__proto__` and `constructor.prototype` keys (prototype poisoning), the same
 * protection Fastify's default JSON parser applies. Use it for any body parsed outside Fastify's parser.
 */
export function parseJsonSafely(text: string | Buffer): unknown {
  return sjson.parse(text, null, { protoAction: "error", constructorAction: "error" }) as unknown;
}
