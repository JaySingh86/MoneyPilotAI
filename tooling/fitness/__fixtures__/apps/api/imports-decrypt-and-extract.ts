// Deliberate violations: decryption and the extraction route are worker-only.
import { open } from "../../packages/crypto/src/decrypt";
import { extract } from "../../packages/ai/src/extract/index";

export const leaked = [open, extract];
