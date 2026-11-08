// Deliberate violation: only a file named exactly testing.ts is a test helper, so this name is production code.
import { fake } from "../auth/testing/fake";

export const leaked = fake;
