// Deliberate violation: a dynamic import() of a chain that ends in decrypting code.
export const load = () => import("../../packages/crypto/src/chain");
