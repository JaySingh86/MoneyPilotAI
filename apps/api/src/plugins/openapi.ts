// OpenAPI 3.1 generated from the routes' Zod schemas (ADR-008), served at /v1/openapi.json.
// `pnpm contracts:gen` reads the same document and generates the typed client in @mp/contracts.
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import swagger from "@fastify/swagger";
import { jsonSchemaTransform, jsonSchemaTransformObject } from "fastify-type-provider-zod";
import type { OpenAPIV3_1 } from "openapi-types";
import { WEBHOOKS_PREFIX } from "../lib/module";

export const OPENAPI_PATH = "/v1/openapi.json";

const openapiPlugin: FastifyPluginAsync = async (app) => {
  // Webhooks are called by providers, not by our clients: keep them out of the public document.
  app.addHook("onRoute", (route) => {
    if (route.url === WEBHOOKS_PREFIX || route.url.startsWith(`${WEBHOOKS_PREFIX}/`)) {
      route.schema = { ...route.schema, hide: true };
    }
  });

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "MoneyPilot API",
        version: "1.0.0",
        description:
          "Household planning API. Money is integer cents, dates are YYYY-MM-DD, errors are RFC 9457 " +
          "problem+json with a `code` (BACKEND_PLAN §8.1). The API never moves money.",
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
      security: [{ bearerAuth: [] }],
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  // Rate limited like any other route (the global per-user/IP limit).
  app.get(OPENAPI_PATH, { schema: { hide: true } }, async () => app.swagger());
};

export const openapi = fp(openapiPlugin, { name: "mp-openapi" });

/** The OpenAPI document of a ready server. */
export async function openApiDocument(app: FastifyInstance): Promise<OpenAPIV3_1.Document> {
  await app.ready();
  return app.swagger() as unknown as OpenAPIV3_1.Document;
}
