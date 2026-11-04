// Deliberate violation: a lib module must not import apps/web/mocks.
import { mock } from "../mocks/mock";

export const leaked = mock;
