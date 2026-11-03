// Allowed: a type-only import from contracts.
import type { ContractType } from "../contracts/index";

export const id = (c: ContractType) => c.id;
