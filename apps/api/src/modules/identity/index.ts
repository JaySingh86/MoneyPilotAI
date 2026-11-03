import { defineModule } from "../../lib/module";
import { runtime, type RuntimeSource } from "../../auth/runtime";
import { householdsModule } from "../households";
import { identityRoutes } from "./routes";

/** `/v1/me`: bootstrap, profile. */
export function createIdentityModule(source: RuntimeSource = runtime) {
  return defineModule({ name: "identity", routes: identityRoutes(source) });
}

export const identityModule = createIdentityModule();

/** WP-05's modules, registered together in `modules/index.ts`. */
export const identityModules = [identityModule, householdsModule] as const;
