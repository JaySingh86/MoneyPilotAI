import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AiRoute } from "./config";

// Prompts are versioned files: packages/ai/prompts/<route>.v<N>.md. Changing a prompt means a new version
// plus an eval run (`pnpm ai:eval`). Never edit a released version in place.

const PROMPT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");

export interface LoadedPrompt {
  readonly route: AiRoute;
  readonly version: number;
  /** `extract.v1`: stored in `ai_runs.prompt_version`. */
  readonly id: string;
  readonly text: string;
  /** SHA-256 of the file, shown in the eval report so a reviewer knows exactly which text was evaluated. */
  readonly sha256: string;
}

const cache = new Map<string, LoadedPrompt>();

export function loadPrompt(route: AiRoute, version: number): LoadedPrompt {
  const id = `${route}.v${version}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const text = readFileSync(join(PROMPT_DIR, `${id}.md`), "utf8");
  const loaded: LoadedPrompt = {
    route,
    version,
    id,
    text,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
  cache.set(id, loaded);
  return loaded;
}
