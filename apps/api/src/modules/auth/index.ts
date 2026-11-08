import { defineModule } from "../../lib/module";
import { authRoutes, type AuthRoutesOptions } from "./routes";
import { authRuntime, type AuthRuntimeSource } from "./runtime";

/** `/v1/auth/*`: sign-up, sign-in, sessions, MFA and Google, proxied to Supabase Auth (WP-33, ADR-020). */
export function createAuthModule(source: AuthRuntimeSource = authRuntime, options: AuthRoutesOptions = {}) {
  return defineModule({ name: "auth", routes: authRoutes(source, options) });
}

export const authModule = createAuthModule();
