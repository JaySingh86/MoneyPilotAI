// Allowed: the api may seal tokens at the OAuth callback.
import { seal } from "../../packages/crypto/src/encrypt";

export const ok = seal;
