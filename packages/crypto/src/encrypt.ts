// Encrypt-only entry point: the one part of packages/crypto that apps/api may import (seals OAuth
// tokens at the callback). Decryption stays worker-only. Implemented in WP-21.
export const ENCRYPT_ONLY = true;
