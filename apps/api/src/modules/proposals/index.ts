// Proposals module (WP-13): "Ask {partner} to approve". Creation from the items and goals services goes
// through ./core; applying an approved proposal is in ./apply.
import { defineModule } from "../../lib/module";
import { runtime, type RuntimeSource } from "../../auth/runtime";
import { proposalsRoutes } from "./routes";

export function createProposalsModule(source: RuntimeSource = runtime, options: { now?: () => string } = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  return defineModule({ name: "proposals", routes: proposalsRoutes(() => ({ db: source().db, now })) });
}

export const proposalsModule = createProposalsModule();
