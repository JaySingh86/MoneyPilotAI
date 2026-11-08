// Deliberate violation: production code must not import the auth test fakes.
import { fake } from "../auth/testing/fake";

export const leaked = fake;
