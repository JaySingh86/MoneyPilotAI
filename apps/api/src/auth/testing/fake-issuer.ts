// Compatibility alias: the old `FakeIssuer` name for `FakeSupabase` (ADR-020). It stays because unmerged branches
// (for example WP-32's apps/api/src/dev/live-smoke.ts) still import it; delete it once they have merged and
// switched to `./fake-supabase`. New code imports `./fake-supabase`.
export { FakeSupabase as FakeIssuer, type TokenOptions } from "./fake-supabase";
