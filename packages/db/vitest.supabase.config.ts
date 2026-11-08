import { defineConfig } from "vitest/config";

// `pnpm test:supabase-compat` (WP-32, ADR-020): the migrations and the whole cross-household suite against
// the Supabase Postgres image, after bootstrap.sql. The RLS tests are the same files `pnpm test:rls` runs;
// only the database underneath differs. Needs Docker and the image (a ~1.6 GB first pull).
export default defineConfig({
  test: {
    name: "rls",
    include: ["test/rls/**/*.test.ts", "test/supabase/**/*.test.ts"],
    globalSetup: ["test/setup/global-setup-supabase.ts"],
    testTimeout: 60_000,
    hookTimeout: 300_000,
  },
});
