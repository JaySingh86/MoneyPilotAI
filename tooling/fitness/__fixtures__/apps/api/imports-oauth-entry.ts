// Allowed: the OAuth entry point of packages/email.
import { createOAuthClientsFromEnv } from "../../packages/email/src/oauth/index";

export const ok = createOAuthClientsFromEnv;
