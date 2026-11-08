// Hard rule 7: only apps/worker decrypts a token. Which modules apps/api may import (directly or through any chain,
// dynamic import() included) is enforced by the dependency-cruiser rules `only-worker-touches-secrets` and
// `api-no-decrypt-reachable` (`pnpm depcruise`, tested in tooling/fitness). This file checks the SQL side: no API source
// names a token column except the one INSERT.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !path.includes(`${join("auth", "testing")}`)
      ? [path]
      : [];
  });
}

describe("apps/api and the token", () => {
  const files = sources(SRC);

  it("never names a token column or the address hash in a query it reads back", () => {
    const readers = files.filter((f) =>
      /token_ciphertext|token_dek_wrapped|token_key_id/.test(readFileSync(f, "utf8")),
    );
    // The one place that writes them: the INSERT in the email repo.
    expect(readers.map((f) => f.slice(SRC.length))).toEqual([join("modules", "email", "repo.ts")]);
    const text = readFileSync(join(SRC, "modules", "email", "repo.ts"), "utf8");
    const selects = text.match(/select[\s\S]*?(?:from|;)/gi) ?? [];
    for (const s of selects) expect(s).not.toMatch(/token_|address_hash/);
  });
});
