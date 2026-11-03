// Deliberate violation: review-rules may import only TYPES from contracts, not values.
import { contractValue } from "../contracts/index";

export const used = contractValue;
