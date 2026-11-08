// Deliberate violation: the API may import the OAuth entry point of packages/email, not the mailbox readers.
import { listChanges } from "../../packages/email/src/providers/gmail";

export const leaked = listChanges;
