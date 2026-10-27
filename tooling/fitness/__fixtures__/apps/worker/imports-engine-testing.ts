// Deliberate violation: production code must not import the engine test fixtures.
import { riveraInput } from "../../packages/engine/src/testing/index";

export const leaked = riveraInput;
