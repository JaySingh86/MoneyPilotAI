export {
  isFreeMailDomain,
  isSameOrSubdomain,
  normalizeDomain,
  orgDomain,
  sameOrganisation,
} from "./domain.js";
export {
  FUZZY_MIN_MARGIN,
  FUZZY_MIN_SCORE,
  isDomainMatch,
  kindOf,
  matchItem,
  nameSimilarity,
} from "./match.js";
export type { MatchableItem, MatchMethod, MatchQuery, MatchResult } from "./match.js";
