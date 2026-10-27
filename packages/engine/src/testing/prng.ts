// A seeded, deterministic generator for property tests (mulberry32). The engine has no randomness;
// tests use fixed seeds so every run checks the same cases and a failure names its seed.

export interface Rng {
  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  bool(probability?: number): boolean;
}

export function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  return {
    int,
    pick: <T>(items: readonly T[]): T => {
      const item = items[int(0, items.length - 1)];
      if (item === undefined) throw new Error("pick from an empty list");
      return item;
    },
    bool: (probability = 0.5) => next() < probability,
  };
}

/** Runs `check` for seeds 1..runs; the seed is in the failure message. */
export function forAllSeeds(runs: number, check: (rng: Rng, seed: number) => void): void {
  for (let seed = 1; seed <= runs; seed++) {
    try {
      check(seededRng(seed), seed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`property failed for seed ${seed}: ${message}`, { cause: err });
    }
  }
}
