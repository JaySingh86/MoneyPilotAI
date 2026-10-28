// Prints the OpenAPI document of the full server (all registered modules) as JSON on stdout.
// Used by `pnpm contracts:gen` (packages/contracts/scripts/gen.ts). Needs no database or network.
import { openApiDocument } from "../plugins/openapi";
import { buildServer } from "../server";

const app = buildServer();
const doc = await openApiDocument(app);
await app.close();
process.stdout.write(`${JSON.stringify(doc)}\n`);
