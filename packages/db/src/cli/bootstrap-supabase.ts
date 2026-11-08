// pnpm db:bootstrap:supabase — one-time (and re-runnable) setup of a Supabase project's database roles.
// Reads SUPABASE_ADMIN_URL (the `postgres` user). Prints the generated role passwords as ready-to-paste
// .env.local lines, once, on stdout. It writes nothing to disk and logs no secret.
//   --rotate   also set new passwords for roles that already exist
import { runBootstrap, envLines } from "./bootstrap-lib";
import { fail, requireEnv, say } from "./env";

try {
  const adminUrl = requireEnv("SUPABASE_ADMIN_URL");
  const result = await runBootstrap({ adminUrl, rotate: process.argv.includes("--rotate") });
  say(
    result.created.length > 0
      ? `Created roles: ${result.created.join(", ")}.`
      : "All roles already existed; grants and lockdown re-applied.",
  );
  const lines = envLines(adminUrl, result.passwords);
  if (lines.length > 0) {
    say("");
    say(
      "Copy these lines into .env.local now. They are not shown again (re-run with --rotate for new ones):",
    );
    say("");
    for (const line of lines) say(line);
    say("");
  } else {
    say("No password was changed. Use --rotate to generate new ones.");
  }
} catch (error) {
  // A connection error can echo the host and user, never the password.
  fail(error);
}
